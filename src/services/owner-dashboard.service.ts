import { Types, type PipelineStage } from "mongoose";
import { Booking } from "../models/Booking.js";
import { Equipment } from "../models/Equipment.js";
import { User } from "../models/User.js";
import type { BookingStatus } from "../models/types.js";
import type {
  OwnerEarningsQuery,
  OwnerEquipmentQuery,
  OwnerRentalRequestsQuery,
} from "../utils/owner-dashboard-validation.js";
import { escapeRegex } from "../utils/equipment-search-validation.js";
import { listOwnerBookingRequests } from "./booking.service.js";
import { successfulPaymentStages } from "./paid-payment-aggregation.js";

const equipmentSort: Record<
  OwnerEquipmentQuery["sort"],
  Record<string, 1 | -1>
> = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: -1 },
};

function pagination(page: number, limit: number, totalItems: number) {
  const totalPages = Math.ceil(totalItems / limit);
  return {
    currentPage: page,
    totalPages,
    totalItems,
    limit,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

function equipmentOverviewPipeline(
  ownerId: Types.ObjectId,
): PipelineStage[] {
  return [
    { $match: { ownerId, isDeleted: { $ne: true } } },
    {
      $group: {
        _id: null,
        totalEquipment: { $sum: 1 },
        approvedEquipment: {
          $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
        },
        pendingEquipment: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
        },
        rejectedEquipment: {
          $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
        },
      },
    },
    { $project: { _id: 0 } },
  ];
}

function bookingOverviewPipeline(ownerId: Types.ObjectId): PipelineStage[] {
  return [
    { $match: { ownerId } },
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalRentalRequests: { $sum: 1 },
              pendingRequests: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "pending"] }, 1, 0],
                },
              },
              confirmedBookings: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "confirmed"] }, 1, 0],
                },
              },
              activeRentals: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "active"] }, 1, 0],
                },
              },
              completedRentals: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "completed"] }, 1, 0],
                },
              },
              cancelledBookings: {
                $sum: {
                  $cond: [{ $eq: ["$bookingStatus", "cancelled"] }, 1, 0],
                },
              },
              pendingEarnings: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$bookingStatus", "pending"] },
                        { $in: ["$paymentStatus", ["unpaid", "failed"]] },
                      ],
                    },
                    { $ifNull: ["$totalAmount", 0] },
                    0,
                  ],
                },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        recentRentalRequests: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 5 },
          {
            $lookup: {
              from: "equipment",
              localField: "equipmentId",
              foreignField: "_id",
              as: "equipment",
            },
          },
          {
            $unwind: {
              path: "$equipment",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "customerId",
              foreignField: "_id",
              as: "customer",
            },
          },
          {
            $unwind: {
              path: "$customer",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              _id: 1,
              equipment: {
                $cond: [
                  { $ifNull: ["$equipment._id", false] },
                  {
                    _id: "$equipment._id",
                    name: "$equipment.name",
                    image: "$equipment.image",
                    category: "$equipment.category",
                    location: "$equipment.location",
                  },
                  null,
                ],
              },
              customer: {
                $cond: [
                  { $ifNull: ["$customer._id", false] },
                  {
                    _id: "$customer._id",
                    name: "$customer.name",
                    image: "$customer.image",
                  },
                  null,
                ],
              },
              startDate: 1,
              endDate: 1,
              quantity: 1,
              rentalType: 1,
              totalAmount: 1,
              bookingStatus: 1,
              paymentStatus: 1,
              createdAt: 1,
            },
          },
        ],
      },
    },
  ];
}

export async function getOwnerDashboardOverview(ownerId: Types.ObjectId) {
  const [equipmentRows, bookingRows, earningRows] = await Promise.all([
    Equipment.aggregate<{
      totalEquipment: number;
      approvedEquipment: number;
      pendingEquipment: number;
      rejectedEquipment: number;
    }>(equipmentOverviewPipeline(ownerId)).exec(),
    Booking.aggregate<{
      stats: Record<string, number>[];
      recentRentalRequests: Record<string, unknown>[];
    }>(bookingOverviewPipeline(ownerId)).exec(),
    Booking.aggregate<{ totalEarnings: number }>([
      ...successfulPaymentStages({ ownerId }),
      { $group: { _id: null, totalEarnings: { $sum: "$amount" } } },
      { $project: { _id: 0, totalEarnings: 1 } },
    ]).exec(),
  ]);

  const equipment = equipmentRows[0];
  const booking = bookingRows[0];
  const stats = booking?.stats[0];
  return {
    totalEquipment: equipment?.totalEquipment ?? 0,
    approvedEquipment: equipment?.approvedEquipment ?? 0,
    pendingEquipment: equipment?.pendingEquipment ?? 0,
    rejectedEquipment: equipment?.rejectedEquipment ?? 0,
    totalRentalRequests: stats?.totalRentalRequests ?? 0,
    pendingRequests: stats?.pendingRequests ?? 0,
    confirmedBookings: stats?.confirmedBookings ?? 0,
    activeRentals: stats?.activeRentals ?? 0,
    completedRentals: stats?.completedRentals ?? 0,
    cancelledBookings: stats?.cancelledBookings ?? 0,
    totalEarnings: Number((earningRows[0]?.totalEarnings ?? 0).toFixed(2)),
    pendingEarnings: Number((stats?.pendingEarnings ?? 0).toFixed(2)),
    earningsType: "gross" as const,
    currency: "bdt",
    recentRentalRequests: booking?.recentRentalRequests ?? [],
  };
}

function equipmentListPipeline(
  ownerId: Types.ObjectId,
  query: OwnerEquipmentQuery,
): PipelineStage[] {
  const filter: Record<string, unknown> = {
    ownerId,
    isDeleted: { $ne: true },
    ...(query.status ? { status: query.status } : {}),
  };
  if (query.search) {
    filter.name = {
      $regex: escapeRegex(query.search),
      $options: "i",
    };
  }

  const offset = (query.page - 1) * query.limit;
  return [
    { $match: filter },
    {
      $facet: {
        items: [
          { $sort: equipmentSort[query.sort] },
          { $skip: offset },
          { $limit: query.limit },
          {
            $lookup: {
              from: "bookings",
              let: { equipmentId: "$_id" },
              pipeline: [
                { $match: { $expr: { $eq: ["$equipmentId", "$$equipmentId"] } } },
                {
                  $group: {
                    _id: null,
                    totalRentalRequests: { $sum: 1 },
                    pendingRequests: {
                      $sum: {
                        $cond: [{ $eq: ["$bookingStatus", "pending"] }, 1, 0],
                      },
                    },
                    confirmedBookings: {
                      $sum: {
                        $cond: [{ $eq: ["$bookingStatus", "confirmed"] }, 1, 0],
                      },
                    },
                    activeRentals: {
                      $sum: {
                        $cond: [{ $eq: ["$bookingStatus", "active"] }, 1, 0],
                      },
                    },
                    completedRentals: {
                      $sum: {
                        $cond: [{ $eq: ["$bookingStatus", "completed"] }, 1, 0],
                      },
                    },
                  },
                },
                { $project: { _id: 0 } },
              ],
              as: "rentalStats",
            },
          },
          {
            $addFields: {
              rentalStats: {
                $ifNull: [
                  { $arrayElemAt: ["$rentalStats", 0] },
                  {
                    totalRentalRequests: 0,
                    pendingRequests: 0,
                    confirmedBookings: 0,
                    activeRentals: 0,
                    completedRentals: 0,
                  },
                ],
              },
            },
          },
          {
            $project: {
              _id: 1,
              name: 1,
              description: 1,
              category: 1,
              location: 1,
              price: 1,
              rentalType: 1,
              availableQuantity: 1,
              condition: 1,
              brand: 1,
              model: 1,
              image: 1,
              terms: 1,
              status: 1,
              createdAt: 1,
              updatedAt: 1,
              rentalStats: 1,
            },
          },
        ],
        metadata: [{ $count: "totalItems" }],
      },
    },
  ];
}

export async function getOwnerDashboardEquipment(
  ownerId: Types.ObjectId,
  query: OwnerEquipmentQuery,
) {
  const [result] = await Equipment.aggregate<{
    items: Record<string, unknown>[];
    metadata: { totalItems: number }[];
  }>(equipmentListPipeline(ownerId, query)).exec();
  const totalItems = result?.metadata[0]?.totalItems ?? 0;
  return {
    items: result?.items ?? [],
    pagination: pagination(query.page, query.limit, totalItems),
  };
}

export async function getOwnerDashboardRentalRequests(
  ownerId: Types.ObjectId,
  query: OwnerRentalRequestsQuery,
) {
  const result = await listOwnerBookingRequests(
    ownerId,
    { page: query.page, limit: query.limit },
    query.status,
    query.sort,
  );

  return {
    items: result.bookings.map((booking: any) => {
      const customer = booking.customerId;
      const equipment = booking.equipmentId;
      return {
        _id: booking._id,
        customer:
          customer &&
          typeof customer === "object" &&
          typeof customer.name === "string"
            ? {
                _id: customer._id,
                name: customer.name,
                image: customer.image ?? null,
              }
            : null,
        equipment:
          equipment &&
          typeof equipment === "object" &&
          typeof equipment.name === "string"
            ? {
                _id: equipment._id,
                name: equipment.name,
                image: equipment.image,
                category: equipment.category,
                location: equipment.location,
              }
            : null,
        startDate: booking.startDate,
        endDate: booking.endDate,
        quantity: booking.quantity,
        rentalType: booking.rentalType,
        amount: booking.totalAmount,
        paymentStatus: booking.paymentStatus ?? "unpaid",
        bookingStatus:
          (booking.bookingStatus ?? booking.status) as BookingStatus,
        createdAt: booking.createdAt,
      };
    }),
    pagination: result.pagination,
  };
}

function earningsPipeline(
  ownerId: Types.ObjectId,
  query: OwnerEarningsQuery,
): PipelineStage[] {
  const endDateExclusive = query.endDate
    ? new Date(query.endDate.getTime() + 24 * 60 * 60 * 1000)
    : undefined;
  const offset = (query.page - 1) * query.limit;
  return [
    ...successfulPaymentStages({
      ownerId,
      ...(query.startDate ? { startDate: query.startDate } : {}),
      ...(endDateExclusive ? { endDateExclusive } : {}),
    }),
    {
      $facet: {
        summary: [
          { $group: { _id: null, totalEarnings: { $sum: "$amount" } } },
          { $project: { _id: 0, totalEarnings: 1 } },
        ],
        paidBookings: [
          { $group: { _id: "$bookingId" } },
          { $count: "totalPaidBookings" },
        ],
        earningsByMonth: [
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
              amount: { $sum: "$amount" },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", amount: 1 } },
        ],
        recentPayments: [
          { $sort: { paidAt: -1, paymentId: -1 } },
          { $skip: offset },
          { $limit: query.limit },
          {
            $lookup: {
              from: "equipment",
              localField: "equipmentId",
              foreignField: "_id",
              as: "equipment",
            },
          },
          {
            $unwind: {
              path: "$equipment",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "customerId",
              foreignField: "_id",
              as: "customer",
            },
          },
          {
            $unwind: {
              path: "$customer",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              _id: 0,
              paymentId: 1,
              bookingId: 1,
              amount: 1,
              currency: 1,
              paymentStatus: { $literal: "paid" },
              paidAt: 1,
              equipment: {
                $cond: [
                  { $ifNull: ["$equipment._id", false] },
                  {
                    _id: "$equipment._id",
                    name: "$equipment.name",
                    image: "$equipment.image",
                  },
                  null,
                ],
              },
              customer: {
                $cond: [
                  { $ifNull: ["$customer._id", false] },
                  {
                    _id: "$customer._id",
                    name: "$customer.name",
                    image: "$customer.image",
                  },
                  null,
                ],
              },
            },
          },
        ],
        metadata: [{ $count: "totalItems" }],
      },
    },
  ];
}

export async function getOwnerDashboardEarnings(
  ownerId: Types.ObjectId,
  query: OwnerEarningsQuery,
) {
  const [result] = await Booking.aggregate<{
    summary: { totalEarnings: number }[];
    paidBookings: { totalPaidBookings: number }[];
    earningsByMonth: { month: string; amount: number }[];
    recentPayments: Record<string, unknown>[];
    metadata: { totalItems: number }[];
  }>(earningsPipeline(ownerId, query)).exec();
  const totalItems = result?.metadata[0]?.totalItems ?? 0;
  return {
    totalEarnings: Number(
      (result?.summary[0]?.totalEarnings ?? 0).toFixed(2),
    ),
    totalPaidBookings: result?.paidBookings[0]?.totalPaidBookings ?? 0,
    earningsByMonth: (result?.earningsByMonth ?? []).map((entry) => ({
      month: entry.month,
      amount: Number(entry.amount.toFixed(2)),
    })),
    recentPayments: result?.recentPayments ?? [],
    earningsType: "gross" as const,
    currency: "bdt",
    pagination: pagination(query.page, query.limit, totalItems),
  };
}

const OWNER_PROFILE_SELECT = "_id name email image phone role createdAt";

function safeProfile(user: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  image?: string;
  phone?: string;
  role?: string;
  createdAt?: Date;
}) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    phone: user.phone ?? null,
    role: user.role,
    createdAt: user.createdAt ?? null,
  };
}

export async function getOwnerDashboardProfile(ownerId: Types.ObjectId) {
  const user = await User.findOne({
    _id: ownerId,
    role: "owner",
    isActive: true,
  })
    .select(OWNER_PROFILE_SELECT)
    .lean()
    .exec();
  return user ? safeProfile(user) : null;
}

export async function updateOwnerDashboardProfile(
  ownerId: Types.ObjectId,
  update: { set: Record<string, string>; unset: string[] },
) {
  const updateDocument: Record<string, unknown> = {};
  if (Object.keys(update.set).length > 0) {
    updateDocument.$set = update.set;
  }
  if (update.unset.length > 0) {
    updateDocument.$unset = Object.fromEntries(
      update.unset.map((field) => [field, 1]),
    );
  }
  const user = await User.findOneAndUpdate(
    { _id: ownerId, role: "owner", isActive: true },
    updateDocument,
    { new: true, runValidators: true },
  )
    .select(OWNER_PROFILE_SELECT)
    .lean()
    .exec();
  return user ? safeProfile(user) : null;
}
