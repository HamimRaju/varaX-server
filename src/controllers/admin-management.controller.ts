import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { parseProfileUpdate } from "../utils/customer-dashboard-validation.js";
import { HttpError } from "../utils/http-error.js";
import {
  parseAdminBookingId,
  parseAdminBookingQuery,
  parseAdminPaymentQuery,
  parseAdminRoleUpdate,
  parseAdminStatusUpdate,
  parseAdminUserId,
  parseAdminUserQuery,
} from "../utils/admin-validation.js";
import * as adminService from "../services/admin-management.service.js";

function getAuthenticatedAdmin(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const getAdminDashboardOverview: RequestHandler = async (
  _request,
  response,
) => {
  const data = await adminService.getAdminDashboardOverview();
  response.status(200).json({
    success: true,
    message: "Admin dashboard data fetched successfully.",
    data,
  });
};

export const getAdminUsers: RequestHandler = async (request, response) => {
  const query = parseAdminUserQuery(
    request.query as Record<string, unknown>,
  );
  const result = await adminService.listAdminUsers(query);
  response.status(200).json({
    success: true,
    message: "Users fetched successfully.",
    data: result.users,
    pagination: result.pagination,
  });
};

export const getAdminUserDetails: RequestHandler = async (
  request,
  response,
) => {
  const userId = parseAdminUserId(request.params.id);
  const data = await adminService.getAdminUserDetails(userId);
  if (!data) {
    throw new HttpError(404, "User not found.");
  }
  response.status(200).json({
    success: true,
    message: "User details fetched successfully.",
    data,
  });
};

export const updateAdminUserRole: RequestHandler = async (
  request,
  response,
) => {
  const admin = getAuthenticatedAdmin(request.user);
  const userId = parseAdminUserId(request.params.id);
  const update = parseAdminRoleUpdate(request.body);
  adminService.validateAdminSelfChange(admin, userId, update);
  const data = await adminService.updateAdminUserRole(userId, update.role);
  if (!data) {
    throw new HttpError(404, "User not found.");
  }
  response.status(200).json({
    success: true,
    message: `User role changed to ${update.role}.`,
    data,
  });
};

export const updateAdminUserStatus: RequestHandler = async (
  request,
  response,
) => {
  const admin = getAuthenticatedAdmin(request.user);
  const userId = parseAdminUserId(request.params.id);
  const update = parseAdminStatusUpdate(request.body);
  adminService.validateAdminSelfChange(admin, userId, update);
  const data = await adminService.updateAdminUserStatus(
    userId,
    update.isActive,
  );
  if (!data) {
    throw new HttpError(404, "User not found.");
  }
  response.status(200).json({
    success: true,
    message: `User account ${update.isActive ? "activated" : "deactivated"}.`,
    data,
  });
};

export const getAdminBookings: RequestHandler = async (
  request,
  response,
) => {
  const query = parseAdminBookingQuery(
    request.query as Record<string, unknown>,
  );
  const result = await adminService.listAdminBookings(query);
  response.status(200).json({
    success: true,
    message: "Bookings fetched successfully.",
    data: result.bookings,
    pagination: result.pagination,
  });
};

export const getAdminBookingDetails: RequestHandler = async (
  request,
  response,
) => {
  const bookingId = parseAdminBookingId(request.params.id);
  const data = await adminService.getAdminBookingDetails(bookingId);
  if (!data) {
    throw new HttpError(404, "Booking not found.");
  }
  response.status(200).json({
    success: true,
    message: "Booking details fetched successfully.",
    data,
  });
};

export const getAdminPayments: RequestHandler = async (
  request,
  response,
) => {
  const query = parseAdminPaymentQuery(
    request.query as Record<string, unknown>,
  );
  const result = await adminService.listAdminPayments(query);
  response.status(200).json({
    success: true,
    message: "Payments fetched successfully.",
    data: result.payments,
    pagination: result.pagination,
  });
};

export const getAdminDashboardProfile: RequestHandler = async (
  request,
  response,
) => {
  const admin = getAuthenticatedAdmin(request.user);
  const data = await adminService.getAdminDashboardProfile(admin.id);
  if (!data) {
    throw new HttpError(404, "Admin profile not found.");
  }
  response.status(200).json({
    success: true,
    message: "Admin profile fetched successfully.",
    data,
  });
};

export const updateAdminDashboardProfile: RequestHandler = async (
  request,
  response,
) => {
  const admin = getAuthenticatedAdmin(request.user);
  const update = parseProfileUpdate(request.body);
  const data = await adminService.updateAdminDashboardProfile(
    admin.id,
    update,
  );
  if (!data) {
    throw new HttpError(404, "Admin profile not found.");
  }
  response.status(200).json({
    success: true,
    message: "Admin profile updated successfully.",
    data,
  });
};
