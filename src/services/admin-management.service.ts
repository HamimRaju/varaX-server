import { Types, type PipelineStage } from "mongoose";
import { Booking } from "../models/Booking.js";
import { Equipment } from "../models/Equipment.js";
import { Payment } from "../models/Payment.js";
import { User } from "../models/User.js";
import {
  BOOKING_STATUSES,
  EQUIPMENT_STATUSES,
  USER_ROLES,
  type UserRole,
} from "../models/types.js";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import type {
  AdminBookingQuery,
  AdminPaymentQuery,
  AdminUserQuery,
} from "../utils/admin-validation.js";
import type { ProfileUpdate } from "../utils/customer-dashboard-validation.js";
import { escapeRegex } from "../utils/equipment-search-validation.js";
import { HttpError } from "../utils/http-error.js";
import { successfulPaymentStages } from "./paid-payment-aggregation.js";

const SAFE_USER_SELECT =
  "_id name email image phone role isActive createdAt";

function makePagination(
  page: number,
  limit: number,
  totalItems: number,
) {
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

function userOverviewPipeline(): PipelineStage[] {
  return [
    { $match: { role: { $in: USER_ROLES } } },
    {
      $facet: {
        stats: [
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
              totalAdmins: {
                $sum: { $cond: [{ $eq: ["$role", "admin"] }, 1, 0] },
              },
            },
          },
          { $project: { _id: 0 } },
        ],
        recentUsers: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 5 },
          {
            $project: {
              _id: 1,
              name: 1,
              email: 1,
              image: 1,
              role: 1,
              isActive: 1,
              createdAt: 1,
            },
          },
        ],
      },
    },
  ];
}

function equipmentOverviewPipeline(): PipelineStage[] {
  return [
    {
      $match: {
        isDeleted: { $ne: true },
        status: { $in: EQUIPMENT_STATUSES },
      },
    },
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

function bookingOverviewPipeline(): PipelineStage[] {
  return [
    { $match: { bookingStatus: { $in: BOOKING_STATUSES } } },
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
          ...bookingSummaryLookups(),
          { $project: bookingSafeProjection() },
        ],
      },
    },
  ];
}

function bookingSummaryLookups(): PipelineStage.FacetPipelineStage[] {
  return [
    {
      $lookup: {
        from: "users",
        localField: "customerId",
        foreignField: "_id",
        pipeline: [
          { $project: { _id: 1, name: 1, email: 1, image: 1, role: 1 } },
        ],
        as: "customer",
      },
    },
    {
      $unwind: { path: "$customer", preserveNullAndEmptyArrays: true },
    },
    {
      $lookup: {
        from: "users",
        localField: "ownerId",
        foreignField: "_id",
        pipeline: [
          { $project: { _id: 1, name: 1, email: 1, image: 1, role: 1 } },
        ],
        as: "owner",
      },
    },
    { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "equipment",
        localField: "equipmentId",
        foreignField: "_id",
        pipeline: [
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
    {
      $unwind: { path: "$equipment", preserveNullAndEmptyArrays: true },
    },
  ];
}

function bookingSafeProjection(): Record<string, unknown> {
  return {
    _id: 1,
    startDate: 1,
    endDate: 1,
    quantity: 1,
    rentalType: 1,
    unitPrice: 1,
    rentalDuration: 1,
    subtotal: 1,
    totalAmount: 1,
    bookingStatus: 1,
    paymentStatus: 1,
    createdAt: 1,
    customer: {
      $cond: [
        { $ifNull: ["$customer._id", false] },
        {
          _id: "$customer._id",
          name: "$customer.name",
          email: "$customer.email",
          image: "$customer.image",
          role: "$customer.role",
        },
        null,
      ],
    },
    owner: {
      $cond: [
        { $ifNull: ["$owner._id", false] },
        {
          _id: "$owner._id",
          name: "$owner.name",
          email: "$owner.email",
          image: "$owner.image",
          role: "$owner.role",
        },
        null,
      ],
    },
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
  };
}

export async function getAdminDashboardOverview() {
  const [userRows, equipmentRows, bookingRows, revenueRows] =
    await Promise.all([
      User.aggregate<{
        stats: Record<string, number>[];
        recentUsers: Record<string, unknown>[];
      }>(userOverviewPipeline()).exec(),
      Equipment.aggregate<{
        totalEquipment: number;
        approvedEquipment: number;
        pendingEquipment: number;
        rejectedEquipment: number;
      }>(equipmentOverviewPipeline()).exec(),
      Booking.aggregate<{
        stats: Record<string, number>[];
        recentBookings: Record<string, unknown>[];
      }>(bookingOverviewPipeline()).exec(),
      Booking.aggregate<{
        revenue: { totalRevenue: number }[];
        bookings: { totalPaidBookings: number }[];
      }>([
        ...successfulPaymentStages(),
        {
          $facet: {
            revenue: [
              { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
              { $project: { _id: 0, totalRevenue: 1 } },
            ],
            bookings: [
              { $group: { _id: "$bookingId" } },
              { $count: "totalPaidBookings" },
            ],
          },
        },
      ]).exec(),
    ]);

  const users = userRows[0];
  const equipment = equipmentRows[0];
  const booking = bookingRows[0];
  const revenue = revenueRows[0];
  return {
    totalUsers: users?.stats[0]?.totalUsers ?? 0,
    totalCustomers: users?.stats[0]?.totalCustomers ?? 0,
    totalOwners: users?.stats[0]?.totalOwners ?? 0,
    totalAdmins: users?.stats[0]?.totalAdmins ?? 0,
    totalEquipment: equipment?.totalEquipment ?? 0,
    approvedEquipment: equipment?.approvedEquipment ?? 0,
    pendingEquipment: equipment?.pendingEquipment ?? 0,
    rejectedEquipment: equipment?.rejectedEquipment ?? 0,
    totalBookings: booking?.stats[0]?.totalBookings ?? 0,
    pendingBookings: booking?.stats[0]?.pendingBookings ?? 0,
    confirmedBookings: booking?.stats[0]?.confirmedBookings ?? 0,
    activeRentals: booking?.stats[0]?.activeRentals ?? 0,
    completedRentals: booking?.stats[0]?.completedRentals ?? 0,
    cancelledBookings: booking?.stats[0]?.cancelledBookings ?? 0,
    totalRevenue: Number((revenue?.revenue[0]?.totalRevenue ?? 0).toFixed(2)),
    totalPaidBookings: revenue?.bookings[0]?.totalPaidBookings ?? 0,
    currency: "bdt",
    recentUsers: users?.recentUsers ?? [],
    recentBookings: booking?.recentBookings ?? [],
  };
}

export async function listAdminUsers(
  query: AdminUserQuery,
) {
  const filter: Record<string, unknown> = {
    ...(query.role ? { role: query.role } : {}),
  };
  if (query.search) {
    const regex = escapeRegex(query.search);
    filter.$or = [
      { name: { $regex: regex, $options: "i" } },
      { email: { $regex: regex, $options: "i" } },
    ];
  }
  const direction = query.sort === "oldest" ? 1 : -1;
  const offset = (query.page - 1) * query.limit;
  const [users, totalItems] = await Promise.all([
    User.find(filter)
      .select(SAFE_USER_SELECT)
      .sort({ createdAt: direction, _id: direction })
      .skip(offset)
      .limit(query.limit)
      .lean()
      .exec(),
    User.countDocuments(filter).exec(),
  ]);
  return {
    users,
    pagination: makePagination(query.page, query.limit, totalItems),
  };
}

function adminUserDetailsPipeline(userId: Types.ObjectId): PipelineStage[] {
  return [
    { $match: { _id: userId } },
    {
      $lookup: {
        from: "bookings",
        let: { userId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$customerId", "$$userId"] } } },
          { $count: "count" },
        ],
        as: "customerBookingStats",
      },
    },
    {
      $lookup: {
        from: "bookings",
        let: { userId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$ownerId", "$$userId"] } } },
          { $count: "count" },
        ],
        as: "ownerBookingStats",
      },
    },
    {
      $lookup: {
        from: "equipment",
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$ownerId", "$$userId"] },
              isDeleted: { $ne: true },
            },
          },
          { $count: "count" },
        ],
        as: "equipmentStats",
      },
    },
    {
      $project: {
        _id: 1,
        name: 1,
        email: 1,
        image: 1,
        phone: 1,
        role: 1,
        isActive: 1,
        createdAt: 1,
        accountStats: {
          customerBookings: {
            $ifNull: [{ $arrayElemAt: ["$customerBookingStats.count", 0] }, 0],
          },
          ownerBookings: {
            $ifNull: [{ $arrayElemAt: ["$ownerBookingStats.count", 0] }, 0],
          },
          equipmentListings: {
            $ifNull: [{ $arrayElemAt: ["$equipmentStats.count", 0] }, 0],
          },
        },
      },
    },
  ];
}

export async function getAdminUserDetails(userId: Types.ObjectId) {
  const [user] = await User.aggregate<{
    _id: Types.ObjectId;
    name: string;
    email: string;
    image?: string;
    phone?: string;
    role: UserRole;
    isActive: boolean;
    createdAt?: Date;
    accountStats: {
      customerBookings: number;
      ownerBookings: number;
      equipmentListings: number;
    };
  }>(adminUserDetailsPipeline(userId)).exec();
  return user ?? null;
}

export async function updateAdminUserRole(
  userId: Types.ObjectId,
  role: UserRole,
) {
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $set: { role } },
    { new: true, runValidators: true },
  )
    .select(SAFE_USER_SELECT)
    .lean()
    .exec();
  return user ?? null;
}

export async function updateAdminUserStatus(
  userId: Types.ObjectId,
  isActive: boolean,
) {
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $set: { isActive } },
    { new: true, runValidators: true },
  )
    .select(SAFE_USER_SELECT)
    .lean()
    .exec();
  return user ?? null;
}

function adminBookingPipeline(
  query: AdminBookingQuery,
): PipelineStage[] {
  const filter: Record<string, unknown> = {
    bookingStatus: query.status
      ? query.status
      : { $in: BOOKING_STATUSES },
    ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
  };
  const pipeline: PipelineStage[] = [{ $match: filter }];
  if (query.search) {
    const regex = escapeRegex(query.search);
    pipeline.push(
      ...bookingSummaryLookups(),
      {
        $match: {
          $or: [
            { "customer.name": { $regex: regex, $options: "i" } },
            { "customer.email": { $regex: regex, $options: "i" } },
            { "owner.name": { $regex: regex, $options: "i" } },
            { "owner.email": { $regex: regex, $options: "i" } },
            { "equipment.name": { $regex: regex, $options: "i" } },
          ],
        },
      },
    );
  }
  const direction = query.sort === "oldest" ? 1 : -1;
  const offset = (query.page - 1) * query.limit;
  pipeline.push({
    $facet: {
      items: [
        { $sort: { createdAt: direction, _id: direction } },
        { $skip: offset },
        { $limit: query.limit },
        ...(!query.search ? bookingSummaryLookups() : []),
        { $project: bookingSafeProjection() },
      ],
      metadata: [{ $count: "totalItems" }],
    },
  });
  return pipeline;
}

export async function listAdminBookings(query: AdminBookingQuery) {
  const [result] = await Booking.aggregate<{
    items: Record<string, unknown>[];
    metadata: { totalItems: number }[];
  }>(adminBookingPipeline(query)).exec();
  const totalItems = result?.metadata[0]?.totalItems ?? 0;
  return {
    bookings: result?.items ?? [],
    pagination: makePagination(query.page, query.limit, totalItems),
  };
}

function adminBookingDetailsPipeline(
  bookingId: Types.ObjectId,
): PipelineStage[] {
  return [
    { $match: { _id: bookingId } },
    ...bookingSummaryLookups(),
    {
      $lookup: {
        from: "payments",
        localField: "_id",
        foreignField: "bookingId",
        pipeline: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 1 },
          {
            $project: {
              _id: 0,
              amount: {
                $ifNull: [
                  { $divide: ["$receivedAmountMinorUnits", 100] },
                  {
                    $ifNull: [
                      { $divide: ["$amountMinorUnits", 100] },
                      "$amount",
                    ],
                  },
                ],
              },
              currency: {
                $ifNull: [
                  "$receivedCurrency",
                  { $ifNull: ["$currency", "bdt"] },
                ],
              },
              paymentStatus: 1,
              fulfillmentStatus: 1,
              paymentMethod: 1,
              paidAt: 1,
              createdAt: 1,
            },
          },
        ],
        as: "paymentSummary",
      },
    },
    {
      $addFields: {
        paymentSummary: {
          $ifNull: [{ $arrayElemAt: ["$paymentSummary", 0] }, null],
        },
      },
    },
    {
      $project: {
        ...bookingSafeProjection(),
        updatedAt: 1,
        paymentSummary: 1,
      },
    },
  ];
}

export async function getAdminBookingDetails(bookingId: Types.ObjectId) {
  const [booking] = await Booking.aggregate<Record<string, unknown>>(
    adminBookingDetailsPipeline(bookingId),
  ).exec();
  return booking ?? null;
}

function adminPaymentsPipeline(query: AdminPaymentQuery): PipelineStage[] {
  const direction = query.sort === "oldest" ? 1 : -1;
  const offset = (query.page - 1) * query.limit;
  return [
    {
      $match: {
        ...(query.status ? { paymentStatus: query.status } : {}),
      },
    },
    {
      $facet: {
        items: [
          { $sort: { createdAt: direction, _id: direction } },
          { $skip: offset },
          { $limit: query.limit },
          {
            $lookup: {
              from: "bookings",
              localField: "bookingId",
              foreignField: "_id",
              pipeline: [
                {
                  $project: {
                    _id: 1,
                    ownerId: 1,
                    equipmentId: 1,
                    startDate: 1,
                    endDate: 1,
                    quantity: 1,
                    rentalType: 1,
                    totalAmount: 1,
                    bookingStatus: 1,
                    paymentStatus: 1,
                  },
                },
              ],
              as: "booking",
            },
          },
          { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              resolvedOwnerId: { $ifNull: ["$ownerId", "$booking.ownerId"] },
              resolvedEquipmentId: {
                $ifNull: ["$equipmentId", "$booking.equipmentId"],
              },
            },
          },
          ...adminPaymentLookups(),
          { $project: adminPaymentProjection() },
        ],
        metadata: [{ $count: "totalItems" }],
      },
    },
  ];
}

function adminPaymentLookups(): PipelineStage.FacetPipelineStage[] {
  return [
    {
      $lookup: {
        from: "users",
        localField: "customerId",
        foreignField: "_id",
        pipeline: [
          { $project: { _id: 1, name: 1, email: 1, image: 1, role: 1 } },
        ],
        as: "customer",
      },
    },
    { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "resolvedOwnerId",
        foreignField: "_id",
        pipeline: [
          { $project: { _id: 1, name: 1, email: 1, image: 1, role: 1 } },
        ],
        as: "owner",
      },
    },
    { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "equipment",
        localField: "resolvedEquipmentId",
        foreignField: "_id",
        pipeline: [
          { $project: { _id: 1, name: 1, image: 1, category: 1, location: 1 } },
        ],
        as: "equipment",
      },
    },
    { $unwind: { path: "$equipment", preserveNullAndEmptyArrays: true } },
  ];
}

function adminPaymentProjection(): Record<string, unknown> {
  return {
    _id: 1,
    amount: 1,
    amountMinorUnits: 1,
    receivedAmountMinorUnits: 1,
    currency: 1,
    receivedCurrency: 1,
    paymentStatus: 1,
    fulfillmentStatus: 1,
    paymentMethod: 1,
    paidAt: 1,
    createdAt: 1,
    updatedAt: 1,
    booking: {
      $cond: [
        { $ifNull: ["$booking._id", false] },
        {
          _id: "$booking._id",
          startDate: "$booking.startDate",
          endDate: "$booking.endDate",
          quantity: "$booking.quantity",
          rentalType: "$booking.rentalType",
          totalAmount: "$booking.totalAmount",
          bookingStatus: "$booking.bookingStatus",
          paymentStatus: "$booking.paymentStatus",
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
          email: "$customer.email",
          image: "$customer.image",
          role: "$customer.role",
        },
        null,
      ],
    },
    owner: {
      $cond: [
        { $ifNull: ["$owner._id", false] },
        {
          _id: "$owner._id",
          name: "$owner.name",
          email: "$owner.email",
          image: "$owner.image",
          role: "$owner.role",
        },
        null,
      ],
    },
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
  };
}

export async function listAdminPayments(query: AdminPaymentQuery) {
  const [result] = await Payment.aggregate<{
    items: Record<string, unknown>[];
    metadata: { totalItems: number }[];
  }>(adminPaymentsPipeline(query)).exec();
  const totalItems = result?.metadata[0]?.totalItems ?? 0;
  return {
    payments: result?.items ?? [],
    pagination: makePagination(query.page, query.limit, totalItems),
  };
}

export async function getAdminDashboardProfile(adminId: Types.ObjectId) {
  return User.findOne({ _id: adminId, role: "admin", isActive: true })
    .select(SAFE_USER_SELECT)
    .lean()
    .exec();
}

export async function updateAdminDashboardProfile(
  adminId: Types.ObjectId,
  update: ProfileUpdate,
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
  return User.findOneAndUpdate(
    { _id: adminId, role: "admin", isActive: true },
    updateDocument,
    { new: true, runValidators: true },
  )
    .select(SAFE_USER_SELECT)
    .lean()
    .exec();
}

export function validateAdminSelfChange(
  actor: AuthenticatedUser,
  targetId: Types.ObjectId,
  change: { role?: UserRole; isActive?: boolean },
) {
  const self = actor.id.toString() === targetId.toString();
  if (self && change.role && change.role !== "admin") {
    throw new HttpError(409, "An administrator cannot remove their own admin role.");
  }
  if (self && change.isActive === false) {
    throw new HttpError(409, "An administrator cannot deactivate their own account.");
  }
}
