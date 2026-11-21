import { Types, type PipelineStage } from "mongoose";
import { Booking } from "../models/Booking.js";
import { Payment } from "../models/Payment.js";
import type {
  BookingPaymentStatus,
  BookingStatus,
} from "../models/types.js";
import * as favoriteService from "./favorite.service.js";
import { listCustomerBookings } from "./booking.service.js";

export interface DashboardPagination {
  page: number;
  limit: number;
}

interface BookingOverviewAggregate {
  stats: {
    totalBookings: number;
    pendingBookings: number;
    confirmedBookings: number;
    activeRentals: number;
    completedRentals: number;
    cancelledBookings: number;
  }[];
  recentBookings: Record<string, unknown>[];
}

function overviewPipeline(customerId: Types.ObjectId): PipelineStage[] {
  return [
    { $match: { customerId } },
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              pendingBookings: {
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
            },
          },
          { $project: { _id: 0 } },
        ],
        recentBookings: [
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
            $project: {
              _id: 1,
              equipmentId: {
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
              startDate: 1,
              endDate: 1,
              quantity: 1,
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

function paidSpendingPipeline(customerId: Types.ObjectId): PipelineStage[] {
  return [
    {
      $match: {
        customerId,
        paymentStatus: "paid",
        fulfillmentStatus: { $ne: "refunded" },
      },
    },
    {
      $lookup: {
        from: "bookings",
        localField: "bookingId",
        foreignField: "_id",
        as: "booking",
      },
    },
    { $unwind: "$booking" },
    { $match: { "booking.customerId": customerId } },
    {
      $sort: { createdAt: 1, _id: 1 },
    },
    {
      // Key by PaymentIntent when present, otherwise by the persisted payment ID.
      // This avoids double-counting duplicated legacy payment rows.
      $group: {
        _id: { $ifNull: ["$stripePaymentIntentId", "$_id"] },
        amount: { $max: "$amount" },
      },
    },
    {
      $group: {
        _id: null,
        totalSpent: { $sum: "$amount" },
      },
    },
    { $project: { _id: 0, totalSpent: 1 } },
  ];
}

export async function getCustomerDashboardOverview(customerId: Types.ObjectId) {
  const [bookingRows, spendingRows, favoritePage] = await Promise.all([
    Booking.aggregate<BookingOverviewAggregate>(
      overviewPipeline(customerId),
    ).exec(),
    Payment.aggregate<{ totalSpent: number }>(
      paidSpendingPipeline(customerId),
    ).exec(),
    favoriteService.listCustomerFavorites(customerId, { page: 1, limit: 1 }),
  ]);
  const overview = bookingRows[0];
  const stats = overview?.stats[0];
  return {
    totalBookings: stats?.totalBookings ?? 0,
    pendingBookings: stats?.pendingBookings ?? 0,
    confirmedBookings: stats?.confirmedBookings ?? 0,
    activeRentals: stats?.activeRentals ?? 0,
    completedRentals: stats?.completedRentals ?? 0,
    cancelledBookings: stats?.cancelledBookings ?? 0,
    totalFavorites: favoritePage.pagination.totalItems,
    totalSpent: Number((spendingRows[0]?.totalSpent ?? 0).toFixed(2)),
    recentBookings: overview?.recentBookings ?? [],
  };
}

export async function getCustomerDashboardBookings(
  customerId: Types.ObjectId,
  pagination: DashboardPagination,
  options: {
    status?: BookingStatus;
    paymentStatus?: BookingPaymentStatus;
    sort: "newest" | "oldest";
  },
) {
  const result = await listCustomerBookings(customerId, pagination, {
    ...options,
    includePaymentSummary: true,
  });
  return {
    ...result,
    bookings: result.bookings.map((booking: any) => {
      const { stripeSessionId, checkoutAttemptVersion, ...safeBooking } =
        booking;
      return safeBooking;
    }),
  };
}

export async function getCustomerDashboardFavorites(
  customerId: Types.ObjectId,
  pagination: DashboardPagination,
) {
  return favoriteService.listCustomerFavorites(customerId, pagination);
}

function activityPipeline(
  customerId: Types.ObjectId,
  pagination: DashboardPagination,
): PipelineStage[] {
  const offset = (pagination.page - 1) * pagination.limit;
  return [
    { $match: { customerId, createdAt: { $type: "date" } } },
    {
      $project: {
        _id: 1,
        bookingId: "$_id",
        activityType: { $literal: "booking_created" },
        occurredAt: "$createdAt",
      },
    },
    {
      $unionWith: {
        coll: "payments",
        pipeline: [
          {
            $match: {
              customerId,
              paymentStatus: "paid",
              fulfillmentStatus: { $ne: "refunded" },
              paidAt: { $type: "date" },
            },
          },
          { $sort: { paidAt: 1, createdAt: 1, _id: 1 } },
          {
            $group: {
              _id: { $ifNull: ["$stripePaymentIntentId", "$_id"] },
              payment: { $first: "$$ROOT" },
            },
          },
          { $replaceRoot: { newRoot: "$payment" } },
          {
            $project: {
              _id: 1,
              bookingId: 1,
              activityType: { $literal: "payment_completed" },
              occurredAt: "$paidAt",
              amount: 1,
              currency: 1,
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "bookings",
        localField: "bookingId",
        foreignField: "_id",
        as: "booking",
      },
    },
    {
      $unwind: {
        path: "$booking",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $match: {
        $or: [
          { activityType: "booking_created" },
          {
            activityType: "payment_completed",
            "booking.customerId": customerId,
          },
        ],
      },
    },
    { $sort: { occurredAt: -1, _id: -1 } },
    {
      $facet: {
        items: [
          { $skip: offset },
          { $limit: pagination.limit },
          {
            $lookup: {
              from: "equipment",
              localField: "booking.equipmentId",
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
            $project: {
              _id: 1,
              type: "$activityType",
              timestamp: "$occurredAt",
              bookingId: 1,
              equipment: {
                $cond: [
                  { $ifNull: ["$equipment._id", false] },
                  {
                    _id: "$equipment._id",
                    name: "$equipment.name",
                    image: "$equipment.image",
                    category: "$equipment.category",
                  },
                  null,
                ],
              },
              booking: {
                startDate: "$booking.startDate",
                endDate: "$booking.endDate",
                quantity: "$booking.quantity",
                totalAmount: "$booking.totalAmount",
              },
              payment: {
                $cond: [
                  { $eq: ["$activityType", "payment_completed"] },
                  {
                    amount: "$amount",
                    currency: "$currency",
                    status: "paid",
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

export async function getCustomerDashboardActivity(
  customerId: Types.ObjectId,
  pagination: DashboardPagination,
) {
  const [result] = await Booking.aggregate<{
    items: Record<string, unknown>[];
    metadata: { totalItems: number }[];
  }>(activityPipeline(customerId, pagination)).exec();
  const totalItems = result?.metadata[0]?.totalItems ?? 0;
  const totalPages = Math.ceil(totalItems / pagination.limit);
  return {
    items: result?.items ?? [],
    pagination: {
      currentPage: pagination.page,
      totalPages,
      totalItems,
      limit: pagination.limit,
      hasNextPage: pagination.page < totalPages,
      hasPrevPage: pagination.page > 1,
    },
  };
}
