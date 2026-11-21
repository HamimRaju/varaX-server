import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { User } from "../models/User.js";
import { HttpError } from "../utils/http-error.js";
import {
  parseCustomerBookingHistoryQuery,
  parseDashboardPagination,
  parseProfileUpdate,
} from "../utils/customer-dashboard-validation.js";
import * as dashboardService from "../services/customer-dashboard.service.js";

const PROFILE_SELECT = "_id name email image phone role createdAt";

function getAuthenticatedCustomer(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

function profileResponse(user: any) {
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

async function findCustomerProfile(customerId: AuthenticatedUser["id"]) {
  const user = await User.findOne({
    _id: customerId,
    role: "customer",
    isActive: true,
  })
    .select(PROFILE_SELECT)
    .lean()
    .exec();
  if (!user) {
    throw new HttpError(404, "Customer profile not found.");
  }
  return user;
}

export const getCustomerDashboardOverview: RequestHandler = async (
  request,
  response,
) => {
  const customer = getAuthenticatedCustomer(request.user);
  const data = await dashboardService.getCustomerDashboardOverview(customer.id);
  response.status(200).json({
    success: true,
    message: "Customer dashboard data fetched successfully.",
    data,
  });
};

export const getCustomerDashboardBookings: RequestHandler = async (
  request,
  response,
) => {
  const customer = getAuthenticatedCustomer(request.user);
  const query = parseCustomerBookingHistoryQuery(
    request.query as Record<string, unknown>,
  );
  const result = await dashboardService.getCustomerDashboardBookings(
    customer.id,
    query.pagination,
    query,
  );
  response.status(200).json({
    success: true,
    message: "Customer bookings fetched successfully.",
    data: result.bookings,
    pagination: result.pagination,
  });
};

export const getCustomerDashboardFavorites: RequestHandler = async (
  request,
  response,
) => {
  const customer = getAuthenticatedCustomer(request.user);
  const pagination = parseDashboardPagination(
    request.query as Record<string, unknown>,
    9,
  );
  const result = await dashboardService.getCustomerDashboardFavorites(
    customer.id,
    pagination,
  );
  response.status(200).json({
    success: true,
    message: "Customer favorites fetched successfully.",
    data: result.items,
    pagination: result.pagination,
  });
};

export const getCustomerDashboardProfile: RequestHandler = async (
  request,
  response,
) => {
  const customer = getAuthenticatedCustomer(request.user);
  const user = await findCustomerProfile(customer.id);
  response.status(200).json({
    success: true,
    message: "Customer profile fetched successfully.",
    data: profileResponse(user),
  });
};

export const updateCustomerDashboardProfile: RequestHandler = async (
  request,
  response,
) => {
  const customer = getAuthenticatedCustomer(request.user);
  const update = parseProfileUpdate(request.body);
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
    {
      _id: customer.id,
      role: "customer",
      isActive: true,
    },
    updateDocument,
    { new: true, runValidators: true },
  )
    .select(PROFILE_SELECT)
    .lean()
    .exec();
  if (!user) {
    throw new HttpError(404, "Customer profile not found.");
  }
  response.status(200).json({
    success: true,
    message: "Customer profile updated successfully.",
    data: profileResponse(user),
  });
};

export const getCustomerDashboardActivity: RequestHandler = async (
  request,
  response,
) => {
  const customer = getAuthenticatedCustomer(request.user);
  const pagination = parseDashboardPagination(
    request.query as Record<string, unknown>,
    10,
  );
  const result = await dashboardService.getCustomerDashboardActivity(
    customer.id,
    pagination,
  );
  response.status(200).json({
    success: true,
    message: "Customer activity fetched successfully.",
    data: result.items,
    pagination: result.pagination,
  });
};
