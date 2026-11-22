import { Types, type PipelineStage } from "mongoose";
import { Booking } from "../models/Booking.js";
import { Equipment } from "../models/Equipment.js";
import { User } from "../models/User.js";
import {
  BOOKING_STATUSES,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  USER_ROLES,
} from "../models/types.js";
import { successfulPaymentStages } from "./paid-payment-aggregation.js";
import {
  analyticsPeriodLabel,
  analyticsPeriodLabels,
  lastTwelveMonthRange,
  mongoPeriodFormat,
  rollingThirtyDayPeriods,
  type AnalyticsRevenueQuery,
} from "../utils/analytics-validation.js";

const RENTAL_BOOKING_STATUSES = ["confirmed", "active", "completed"] as const;

type AggregateRow = Record<string, any>;

function toMoney(minorUnits: number | null | undefined): number {
  return Number((((minorUnits ?? 0) as number) / 100).toFixed(2));
}

function averageMoney(averageMinorUnits: number | null | undefined): number {
  return Number((((averageMinorUnits ?? 0) as number) / 100).toFixed(2));
}

function zeroFilledCounts<T extends string>(
  keys: readonly T[],
  rows: Array<{
    _id: T;
    count?: number;
    equipmentCount?: number;
    userCount?: number;
    bookingCount?: number;
  }>,
  keyName: string,
  valueName: string,
) {
  const counts = new Map(
    rows.map((row) => [
      row._id,
      (row[valueName as keyof typeof row] ??
        row.count ??
        row.equipmentCount ??
        row.userCount ??
        row.bookingCount) as number | undefined,
    ]),
  );
  return keys.map((key) => ({
    [keyName]: key,
    [valueName]: counts.get(key) ?? 0,
  }));
}

function zeroFilledRevenue(
  rows: Array<{
    label: string;
    revenueMinorUnits: number;
    paymentCount: number;
    bookingCount: number;
  }>,
  range: AnalyticsRevenueQuery,
) {
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  return analyticsPeriodLabels(
    range.startDate,
    range.endDate,
    range.period,
  ).map((label) => {
    const row = byLabel.get(label);
    return {
      label,
      revenue: toMoney(row?.revenueMinorUnits),
      paymentCount: row?.paymentCount ?? 0,
      bookingCount: row?.bookingCount ?? 0,
    };
  });
}

function revenueByPeriodPipeline(
  range: AnalyticsRevenueQuery,
  ownerId?: Types.ObjectId,
): PipelineStage[] {
  return [
    ...successfulPaymentStages({
      ...(ownerId ? { ownerId } : {}),
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      timestampBasis: "paidAt",
    }),
    {
      $addFields: {
        label: {
          $dateToString: {
            format: mongoPeriodFormat(range.period),
            date: "$paidAt",
            timezone: "UTC",
          },
        },
      },
    },
    {
      $group: {
        _id: { label: "$label", bookingId: "$bookingId" },
        bookingRevenueMinorUnits: { $sum: "$amountMinorUnits" },
        paymentCount: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: "$_id.label",
        revenueMinorUnits: { $sum: "$bookingRevenueMinorUnits" },
        paymentCount: { $sum: "$paymentCount" },
        bookingCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        label: "$_id",
        revenueMinorUnits: 1,
        paymentCount: 1,
        bookingCount: 1,
      },
    },
  ];
}

export async function getAdminRevenueAnalytics(
  range: AnalyticsRevenueQuery,
) {
  const rows = await Booking.aggregate<{
    label: string;
    revenueMinorUnits: number;
    paymentCount: number;
    bookingCount: number;
  }>(revenueByPeriodPipeline(range)).exec();
  return {
    period: range.period,
    currency: "BDT" as const,
    startDate: range.startDate.toISOString().slice(0, 10),
    endDate: range.endDate.toISOString().slice(0, 10),
    results: zeroFilledRevenue(rows, range),
  };
}

export async function getOwnerRevenueAnalytics(
  ownerId: Types.ObjectId,
  range: AnalyticsRevenueQuery,
) {
  const rows = await Booking.aggregate<{
    label: string;
    revenueMinorUnits: number;
    paymentCount: number;
    bookingCount: number;
  }>(revenueByPeriodPipeline(range, ownerId)).exec();
  return {
    period: range.period,
    currency: "BDT" as const,
    startDate: range.startDate.toISOString().slice(0, 10),
    endDate: range.endDate.toISOString().slice(0, 10),
    results: zeroFilledRevenue(rows, range),
  };
}

function bookingAmountMinorExpression() {
  return {
    $cond: [
      {
        $and: [
          { $isNumber: "$totalAmount" },
          { $gt: ["$totalAmount", 0] },
        ],
      },
      { $round: [{ $multiply: ["$totalAmount", 100] }, 0] },
      null,
    ],
  };
}

function adminOverviewBookingPipeline(): PipelineStage[] {
  return [
    {
      $facet: {
        bookings: [
          { $match: { bookingStatus: { $in: BOOKING_STATUSES } } },
          {
            $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              completedBookings: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "completed"] }, 1, 0],
                },
              },
              activeRentals: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "active"] }, 1, 0],
                },
              },
              pendingBookings: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "pending"] }, 1, 0],
                },
              },
              averageBookingValueMinorUnits: {
                $avg: bookingAmountMinorExpression(),
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        revenue: [
          ...successfulPaymentStages(),
          {
            $group: {
              _id: null,
              totalRevenueMinorUnits: { $sum: "$amountMinorUnits" },
            },
          },
          { $project: { _id: 0, totalRevenueMinorUnits: 1 } },
        ],
      },
    },
  ];
}

export async function getAdminAnalyticsOverview() {
  const [users, equipment, bookingRows] = await Promise.all([
    User.aggregate<{
      totalUsers: number;
      totalCustomers: number;
      totalOwners: number;
    }>([
      { $match: { role: { $in: USER_ROLES } } },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          totalCustomers: {
            $sum: { $cond: [{ $eq: ["$role", "customer"] }, 1, 0] },
          },
          totalOwners: {
            $sum: { $cond: [{ $eq: ["$role", "owner"] }, 1, 0] },
          },
        },
      },
      { $project: { _id: 0 } },
    ]).exec(),
    Equipment.aggregate<{ totalEquipment: number }>([
      {
        $match: {
          isDeleted: { $ne: true },
          status: { $in: EQUIPMENT_STATUSES },
        },
      },
      { $count: "totalEquipment" },
    ]).exec(),
    Booking.aggregate<{
      bookings: {
        totalBookings: number;
        completedBookings: number;
        activeRentals: number;
        pendingBookings: number;
        averageBookingValueMinorUnits: number | null;
      }[];
      revenue: { totalRevenueMinorUnits: number }[];
    }>(adminOverviewBookingPipeline()).exec(),
  ]);
  const booking = bookingRows[0];
  const stats = booking?.bookings[0];
  return {
    totalRevenue: toMoney(booking?.revenue[0]?.totalRevenueMinorUnits),
    totalBookings: stats?.totalBookings ?? 0,
    totalUsers: users[0]?.totalUsers ?? 0,
    totalEquipment: equipment[0]?.totalEquipment ?? 0,
    totalCustomers: users[0]?.totalCustomers ?? 0,
    totalOwners: users[0]?.totalOwners ?? 0,
    averageBookingValue: averageMoney(stats?.averageBookingValueMinorUnits),
    completedBookings: stats?.completedBookings ?? 0,
    activeRentals: stats?.activeRentals ?? 0,
    pendingBookings: stats?.pendingBookings ?? 0,
    currency: "BDT" as const,
  };
}

function growthPercent(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function growthDto(
  current: number,
  previous: number,
  periods: ReturnType<typeof rollingThirtyDayPeriods>,
  valueName: "bookings" | "users",
) {
  const currentEnd = periods.currentEnd.toISOString();
  const currentStart = periods.currentStart.toISOString();
  const previousStart = periods.previousStart.toISOString();
  return {
    currentPeriod: {
      startDate: currentStart,
      endDateExclusive: currentEnd,
      [valueName]: current,
    },
    previousPeriod: {
      startDate: previousStart,
      endDateExclusive: currentStart,
      [valueName]: previous,
    },
    percentChange: growthPercent(current, previous),
  };
}

function bookingAnalyticsPipeline(
  months: ReturnType<typeof lastTwelveMonthRange>,
  growth: ReturnType<typeof rollingThirtyDayPeriods>,
): PipelineStage[] {
  return [
    { $match: { bookingStatus: { $in: BOOKING_STATUSES } } },
    {
      $facet: {
        statuses: [
          { $group: { _id: "$bookingStatus", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        monthly: [
          {
            $match: {
              createdAt: {
                $type: "date",
                $gte: months.startDate,
                $lt: months.endDateExclusive,
              },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              bookingCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", bookingCount: 1 } },
        ],
        summary: [
          {
            $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              averageBookingValueMinorUnits: {
                $avg: bookingAmountMinorExpression(),
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        growth: [
          {
            $match: {
              createdAt: {
                $type: "date",
                $gte: growth.previousStart,
                $lt: growth.currentEnd,
              },
            },
          },
          {
            $group: {
              _id: null,
              currentBookings: {
                $sum: {
                  $cond: [{ $gte: ["$createdAt", growth.currentStart] }, 1, 0],
                },
              },
              previousBookings: {
                $sum: {
                  $cond: [{ $lt: ["$createdAt", growth.currentStart] }, 1, 0],
                },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
      },
    },
  ];
}

function monthlyBookingLabels(
  range: ReturnType<typeof lastTwelveMonthRange>,
): string[] {
  const labels: string[] = [];
  const cursor = new Date(range.startDate);
  while (cursor.getTime() < range.endDateExclusive.getTime()) {
    labels.push(analyticsPeriodLabel(cursor, "monthly"));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return labels;
}

export async function getAdminBookingAnalytics(now = new Date()) {
  const months = lastTwelveMonthRange(now);
  const growth = rollingThirtyDayPeriods(now);
  const [result] = await Booking.aggregate<{
    statuses: { _id: string; count: number }[];
    monthly: { month: string; bookingCount: number }[];
    summary: {
      totalBookings: number;
      averageBookingValueMinorUnits: number | null;
    }[];
    growth: { currentBookings: number; previousBookings: number }[];
  }>(bookingAnalyticsPipeline(months, growth)).exec();
  const summary = result?.summary[0];
  const growthCounts = result?.growth[0];
  const byMonth = new Map(
    (result?.monthly ?? []).map((row) => [row.month, row.bookingCount]),
  );
  return {
    bookingsByStatus: zeroFilledCounts(
      BOOKING_STATUSES,
      result?.statuses ?? [],
      "status",
      "bookingCount",
    ),
    bookingsByMonth: monthlyBookingLabels(months).map((month) => ({
      month,
      bookingCount: byMonth.get(month) ?? 0,
    })),
    bookingGrowth: growthDto(
      growthCounts?.currentBookings ?? 0,
      growthCounts?.previousBookings ?? 0,
      growth,
      "bookings",
    ),
    averageBookingValue: averageMoney(
      summary?.averageBookingValueMinorUnits,
    ),
    totalBookings: summary?.totalBookings ?? 0,
    currency: "BDT" as const,
  };
}

function userAnalyticsPipeline(
  months: ReturnType<typeof lastTwelveMonthRange>,
  growth: ReturnType<typeof rollingThirtyDayPeriods>,
): PipelineStage[] {
  return [
    { $match: { role: { $in: USER_ROLES } } },
    {
      $facet: {
        roles: [
          { $group: { _id: "$role", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        totals: [
          {
            $group: {
              _id: null,
              totalUsers: { $sum: 1 },
              customerCount: {
                $sum: { $cond: [{ $eq: ["$role", "customer"] }, 1, 0] },
              },
              ownerCount: {
                $sum: { $cond: [{ $eq: ["$role", "owner"] }, 1, 0] },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        monthly: [
          {
            $match: {
              createdAt: {
                $type: "date",
                $gte: months.startDate,
                $lt: months.endDateExclusive,
              },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              userCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", userCount: 1 } },
        ],
        growth: [
          {
            $match: {
              createdAt: {
                $type: "date",
                $gte: growth.previousStart,
                $lt: growth.currentEnd,
              },
            },
          },
          {
            $group: {
              _id: null,
              currentUsers: {
                $sum: {
                  $cond: [{ $gte: ["$createdAt", growth.currentStart] }, 1, 0],
                },
              },
              previousUsers: {
                $sum: {
                  $cond: [{ $lt: ["$createdAt", growth.currentStart] }, 1, 0],
                },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
      },
    },
  ];
}

export async function getAdminUserAnalytics(now = new Date()) {
  const months = lastTwelveMonthRange(now);
  const growth = rollingThirtyDayPeriods(now);
  const [result] = await User.aggregate<{
    roles: { _id: string; count: number }[];
    totals: {
      totalUsers: number;
      customerCount: number;
      ownerCount: number;
    }[];
    monthly: { month: string; userCount: number }[];
    growth: { currentUsers: number; previousUsers: number }[];
  }>(userAnalyticsPipeline(months, growth)).exec();
  const totals = result?.totals[0];
  const growthCounts = result?.growth[0];
  const byMonth = new Map(
    (result?.monthly ?? []).map((row) => [row.month, row.userCount]),
  );
  return {
    usersByRole: zeroFilledCounts(
      USER_ROLES,
      result?.roles ?? [],
      "role",
      "userCount",
    ),
    newUsersByMonth: monthlyBookingLabels(months).map((month) => ({
      month,
      userCount: byMonth.get(month) ?? 0,
    })),
    customerCount: totals?.customerCount ?? 0,
    ownerCount: totals?.ownerCount ?? 0,
    totalUsers: totals?.totalUsers ?? 0,
    userGrowth: growthDto(
      growthCounts?.currentUsers ?? 0,
      growthCounts?.previousUsers ?? 0,
      growth,
      "users",
    ),
  };
}

function equipmentRentalPipeline(ownerId?: Types.ObjectId): PipelineStage[] {
  return [
    {
      $match: {
        isDeleted: { $ne: true },
        status: { $in: EQUIPMENT_STATUSES },
        ...(ownerId ? { ownerId } : {}),
      },
    },
    {
      $lookup: {
        from: "bookings",
        localField: "_id",
        foreignField: "equipmentId",
        pipeline: [
          { $match: { bookingStatus: { $in: RENTAL_BOOKING_STATUSES } } },
          { $count: "rentalCount" },
        ],
        as: "rentalStats",
      },
    },
    {
      $addFields: {
        rentalCount: {
          $ifNull: [{ $arrayElemAt: ["$rentalStats.rentalCount", 0] }, 0],
        },
      },
    },
  ];
}

function equipmentSummaryProjection() {
  return {
    _id: 1,
    name: 1,
    image: 1,
    category: 1,
    location: 1,
    status: 1,
    rentalCount: 1,
  };
}

function adminEquipmentAnalyticsPipeline(): PipelineStage[] {
  return [
    ...equipmentRentalPipeline(),
    {
      $facet: {
        categories: [
          { $group: { _id: "$category", equipmentCount: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        statuses: [
          { $group: { _id: "$status", equipmentCount: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        mostRented: [
          { $match: { rentalCount: { $gt: 0 } } },
          { $sort: { rentalCount: -1, _id: 1 } },
          { $limit: 5 },
          { $project: equipmentSummaryProjection() },
        ],
        leastRented: [
          { $sort: { rentalCount: 1, _id: 1 } },
          { $limit: 5 },
          { $project: equipmentSummaryProjection() },
        ],
        topOwners: [
          {
            $group: {
              _id: "$ownerId",
              activeEquipmentCount: { $sum: 1 },
              rentalCount: { $sum: "$rentalCount" },
            },
          },
          { $match: { rentalCount: { $gt: 0 } } },
          { $sort: { rentalCount: -1, _id: 1 } },
          { $limit: 5 },
          {
            $lookup: {
              from: "users",
              localField: "_id",
              foreignField: "_id",
              pipeline: [{ $project: { _id: 1, name: 1, image: 1 } }],
              as: "owner",
            },
          },
          { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              owner: {
                $cond: [
                  { $ifNull: ["$owner._id", false] },
                  {
                    _id: "$owner._id",
                    name: "$owner.name",
                    image: "$owner.image",
                  },
                  null,
                ],
              },
              activeEquipmentCount: 1,
              rentalCount: 1,
            },
          },
        ],
      },
    },
  ];
}

function ownerEquipmentAnalyticsPipeline(
  ownerId: Types.ObjectId,
): PipelineStage[] {
  return [
    ...equipmentRentalPipeline(ownerId),
    {
      $facet: {
        statuses: [
          { $group: { _id: "$status", equipmentCount: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        bookingsByEquipment: [
          { $sort: { name: 1, _id: 1 } },
          { $project: equipmentSummaryProjection() },
        ],
        mostRented: [
          { $match: { rentalCount: { $gt: 0 } } },
          { $sort: { rentalCount: -1, _id: 1 } },
          { $limit: 5 },
          { $project: equipmentSummaryProjection() },
        ],
        leastRented: [
          { $sort: { rentalCount: 1, _id: 1 } },
          { $limit: 5 },
          { $project: equipmentSummaryProjection() },
        ],
      },
    },
  ];
}

function adminUserStatsPipeline(): PipelineStage[] {
  return [
    { $match: { role: { $in: USER_ROLES } } },
    {
      $group: {
        _id: null,
        totalUsers: { $sum: 1 },
        totalCustomers: {
          $sum: { $cond: [{ $eq: ["$role", "customer"] }, 1, 0] },
        },
        totalOwners: {
          $sum: { $cond: [{ $eq: ["$role", "owner"] }, 1, 0] },
        },
      },
    },
    { $project: { _id: 0 } },
  ];
}

function adminEquipmentTotalPipeline(): PipelineStage[] {
  return [
    {
      $match: {
        isDeleted: { $ne: true },
        status: { $in: EQUIPMENT_STATUSES },
      },
    },
    { $count: "totalEquipment" },
  ];
}

function ownerEquipmentTotalPipeline(ownerId: Types.ObjectId): PipelineStage[] {
  return [
    {
      $match: {
        ownerId,
        isDeleted: { $ne: true },
        status: { $in: EQUIPMENT_STATUSES },
      },
    },
    { $count: "totalEquipment" },
  ];
}

function ownerOverviewBookingPipeline(ownerId: Types.ObjectId): PipelineStage[] {
  return [
    {
      $match: {
        ownerId,
        bookingStatus: { $in: BOOKING_STATUSES },
      },
    },
    {
      $group: {
        _id: null,
        totalBookings: { $sum: 1 },
        activeRentals: {
          $sum: { $cond: [{ $eq: ["$bookingStatus", "active"] }, 1, 0] },
        },
        completedRentals: {
          $sum: { $cond: [{ $eq: ["$bookingStatus", "completed"] }, 1, 0] },
        },
        averageBookingValueMinorUnits: {
          $avg: bookingAmountMinorExpression(),
        },
      },
    },
    { $project: { _id: 0 } },
  ];
}

function ownerOverviewPaymentPipeline(
  ownerId: Types.ObjectId,
  now: Date,
): PipelineStage[] {
  const monthRange = lastTwelveMonthRange(now);
  return [
    ...successfulPaymentStages({ ownerId }),
    {
      $facet: {
        total: [
          {
            $group: {
              _id: null,
              totalRevenueMinorUnits: { $sum: "$amountMinorUnits" },
            },
          },
          { $project: { _id: 0, totalRevenueMinorUnits: 1 } },
        ],
        monthly: [
          {
            $match: {
              actualPaidAt: {
                $type: "date",
                $gte: monthRange.startDate,
                $lt: monthRange.endDateExclusive,
              },
            },
          },
          {
            $group: {
              _id: {
                      $dateToString: {
                        format: "%Y-%m",
                        date: "$actualPaidAt",
                  timezone: "UTC",
                },
              },
              revenueMinorUnits: { $sum: "$amountMinorUnits" },
              paymentCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              month: "$_id",
              revenueMinorUnits: 1,
              paymentCount: 1,
            },
          },
        ],
        equipmentPerformance: [
          {
            $group: {
              _id: "$equipmentId",
              revenueMinorUnits: { $sum: "$amountMinorUnits" },
              paymentCount: { $sum: 1 },
            },
          },
          {
            $lookup: {
              from: "equipment",
              localField: "_id",
              foreignField: "_id",
              pipeline: [
                {
                  $match: {
                    ownerId,
                    isDeleted: { $ne: true },
                    status: { $in: EQUIPMENT_STATUSES },
                  },
                },
                {
                  $project: {
                    _id: 1,
                    name: 1,
                    image: 1,
                    category: 1,
                    location: 1,
                  },
                },
              ],
              as: "equipment",
            },
          },
          { $unwind: "$equipment" },
          { $sort: { revenueMinorUnits: -1, _id: 1 } },
          { $limit: 5 },
          {
            $project: {
              _id: 0,
              equipment: {
                _id: "$equipment._id",
                name: "$equipment.name",
                image: "$equipment.image",
                category: "$equipment.category",
                location: "$equipment.location",
              },
              revenueMinorUnits: 1,
              paymentCount: 1,
            },
          },
        ],
      },
    },
  ];
}

function twelveMonthRevenue(
  rows: Array<{
    month: string;
    revenueMinorUnits: number;
    paymentCount: number;
  }>,
  now = new Date(),
) {
  const range = lastTwelveMonthRange(now);
  const amounts = new Map(rows.map((row) => [row.month, row]));
  const months = monthlyBookingLabels(range);
  return months.map((month) => {
    const row = amounts.get(month);
    return {
      month,
      revenue: toMoney(row?.revenueMinorUnits),
      paymentCount: row?.paymentCount ?? 0,
    };
  });
}

export async function getOwnerAnalyticsOverview(ownerId: Types.ObjectId) {
  const now = new Date();
  const [equipmentRows, bookingRows, paymentRows] = await Promise.all([
    Equipment.aggregate<{ totalEquipment: number }>(
      ownerEquipmentTotalPipeline(ownerId),
    ).exec(),
    Booking.aggregate<{
      totalBookings: number;
      activeRentals: number;
      completedRentals: number;
      averageBookingValueMinorUnits: number | null;
    }>(ownerOverviewBookingPipeline(ownerId)).exec(),
    Booking.aggregate<{
      total: { totalRevenueMinorUnits: number }[];
      monthly: {
        month: string;
        revenueMinorUnits: number;
        paymentCount: number;
      }[];
      equipmentPerformance: {
        equipment: Record<string, unknown>;
        revenueMinorUnits: number;
        paymentCount: number;
      }[];
    }>(ownerOverviewPaymentPipeline(ownerId, now)).exec(),
  ]);
  const stats = bookingRows[0];
  const payments = paymentRows[0];
  return {
    totalRevenue: toMoney(payments?.total[0]?.totalRevenueMinorUnits),
    totalBookings: stats?.totalBookings ?? 0,
    totalEquipment: equipmentRows[0]?.totalEquipment ?? 0,
    activeRentals: stats?.activeRentals ?? 0,
    completedRentals: stats?.completedRentals ?? 0,
    averageBookingValue: averageMoney(
      stats?.averageBookingValueMinorUnits,
    ),
    currency: "BDT" as const,
    monthlyRevenue: twelveMonthRevenue(payments?.monthly ?? [], now),
    equipmentPerformance: (payments?.equipmentPerformance ?? []).map((item) => ({
      equipment: item.equipment,
      revenue: toMoney(item.revenueMinorUnits),
      paymentCount: item.paymentCount,
    })),
  };
}

export async function getAdminEquipmentAnalytics() {
  const [result] = await Equipment.aggregate<{
    categories: { _id: string; equipmentCount: number }[];
    statuses: { _id: string; equipmentCount: number }[];
    mostRented: AggregateRow[];
    leastRented: AggregateRow[];
    topOwners: AggregateRow[];
  }>(adminEquipmentAnalyticsPipeline()).exec();
  return {
    equipmentByCategory: zeroFilledCounts(
      EQUIPMENT_CATEGORIES,
      result?.categories ?? [],
      "category",
      "equipmentCount",
    ),
    equipmentByStatus: zeroFilledCounts(
      EQUIPMENT_STATUSES,
      result?.statuses ?? [],
      "status",
      "equipmentCount",
    ),
    mostRentedEquipment: result?.mostRented ?? [],
    leastRentedEquipment: result?.leastRented ?? [],
    topEquipmentOwners: result?.topOwners ?? [],
  };
}

export async function getOwnerEquipmentAnalytics(ownerId: Types.ObjectId) {
  const [equipmentRows, revenueRows] = await Promise.all([
    Equipment.aggregate<{
      statuses: { _id: string; equipmentCount: number }[];
      bookingsByEquipment: AggregateRow[];
      mostRented: AggregateRow[];
      leastRented: AggregateRow[];
    }>(ownerEquipmentAnalyticsPipeline(ownerId)).exec(),
    Booking.aggregate<{
      _id: Types.ObjectId;
      revenueMinorUnits: number;
      paymentCount: number;
    }>([
      ...successfulPaymentStages({ ownerId }),
      {
        $lookup: {
          from: "equipment",
          localField: "equipmentId",
          foreignField: "_id",
          pipeline: [
            {
              $match: {
                ownerId,
                isDeleted: { $ne: true },
                status: { $in: EQUIPMENT_STATUSES },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "activeEquipment",
        },
      },
      { $unwind: "$activeEquipment" },
      {
        $group: {
          _id: "$equipmentId",
          revenueMinorUnits: { $sum: "$amountMinorUnits" },
          paymentCount: { $sum: 1 },
        },
      },
    ]).exec(),
  ]);
  const result = equipmentRows[0];
  const revenueByEquipment = new Map(
    revenueRows.map((row) => [row._id.toString(), row]),
  );
  const bookingsByEquipment = result?.bookingsByEquipment ?? [];
  return {
    equipmentByStatus: zeroFilledCounts(
      EQUIPMENT_STATUSES,
      result?.statuses ?? [],
      "status",
      "equipmentCount",
    ),
    mostRentedEquipment: result?.mostRented ?? [],
    leastRentedEquipment: result?.leastRented ?? [],
    bookingsByEquipment: bookingsByEquipment.map((item) => ({
      equipmentId: item._id,
      name: item.name,
      image: item.image,
      category: item.category,
      rentalCount: item.rentalCount,
    })),
    revenueByEquipment: bookingsByEquipment.map((item) => {
      const revenue = revenueByEquipment.get(item._id.toString());
      return {
        equipmentId: item._id,
        name: item.name,
        image: item.image,
        revenue: toMoney(revenue?.revenueMinorUnits),
        paymentCount: revenue?.paymentCount ?? 0,
      };
    }),
  };
}
