import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import { parseProfileUpdate } from "../utils/customer-dashboard-validation.js";
import {
  parseOwnerEarningsQuery,
  parseOwnerEquipmentQuery,
  parseOwnerRentalRequestsQuery,
} from "../utils/owner-dashboard-validation.js";
import * as dashboardService from "../services/owner-dashboard.service.js";

function getAuthenticatedOwner(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const getOwnerDashboardOverview: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const data = await dashboardService.getOwnerDashboardOverview(owner.id);
  response.status(200).json({
    success: true,
    message: "Owner dashboard data fetched successfully.",
    data,
  });
};

export const getOwnerDashboardEquipment: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const query = parseOwnerEquipmentQuery(
    request.query as Record<string, unknown>,
  );
  const result = await dashboardService.getOwnerDashboardEquipment(
    owner.id,
    query,
  );
  response.status(200).json({
    success: true,
    message: "Owner equipment fetched successfully.",
    data: result.items,
    pagination: result.pagination,
  });
};

export const getOwnerDashboardRentalRequests: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const query = parseOwnerRentalRequestsQuery(
    request.query as Record<string, unknown>,
  );
  const result = await dashboardService.getOwnerDashboardRentalRequests(
    owner.id,
    query,
  );
  response.status(200).json({
    success: true,
    message: "Owner rental requests fetched successfully.",
    data: result.items,
    pagination: result.pagination,
  });
};

export const getOwnerDashboardEarnings: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const query = parseOwnerEarningsQuery(
    request.query as Record<string, unknown>,
  );
  const data = await dashboardService.getOwnerDashboardEarnings(
    owner.id,
    query,
  );
  const { pagination, ...earnings } = data;
  response.status(200).json({
    success: true,
    message: "Owner earnings fetched successfully.",
    data: earnings,
    pagination,
  });
};

export const getOwnerDashboardProfile: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const data = await dashboardService.getOwnerDashboardProfile(owner.id);
  if (!data) {
    throw new HttpError(404, "Owner profile not found.");
  }
  response.status(200).json({
    success: true,
    message: "Owner profile fetched successfully.",
    data,
  });
};

export const updateOwnerDashboardProfile: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const update = parseProfileUpdate(request.body);
  const data = await dashboardService.updateOwnerDashboardProfile(
    owner.id,
    update,
  );
  if (!data) {
    throw new HttpError(404, "Owner profile not found.");
  }
  response.status(200).json({
    success: true,
    message: "Owner profile updated successfully.",
    data,
  });
};
