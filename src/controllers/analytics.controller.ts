import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import { parseAnalyticsRevenueQuery } from "../utils/analytics-validation.js";
import * as analyticsService from "../services/analytics.service.js";

function getAuthenticatedOwner(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const getAdminAnalyticsOverview: RequestHandler = async (
  _request,
  response,
) => {
  const data = await analyticsService.getAdminAnalyticsOverview();
  response.status(200).json({
    success: true,
    message: "Admin analytics overview fetched successfully.",
    data,
  });
};

export const getAdminRevenueAnalytics: RequestHandler = async (
  request,
  response,
) => {
  const range = parseAnalyticsRevenueQuery(
    request.query as Record<string, unknown>,
  );
  const data = await analyticsService.getAdminRevenueAnalytics(range);
  response.status(200).json({
    success: true,
    message: "Admin revenue analytics fetched successfully.",
    data,
  });
};

export const getAdminBookingAnalytics: RequestHandler = async (
  _request,
  response,
) => {
  const data = await analyticsService.getAdminBookingAnalytics();
  response.status(200).json({
    success: true,
    message: "Admin booking analytics fetched successfully.",
    data,
  });
};

export const getAdminEquipmentAnalytics: RequestHandler = async (
  _request,
  response,
) => {
  const data = await analyticsService.getAdminEquipmentAnalytics();
  response.status(200).json({
    success: true,
    message: "Admin equipment analytics fetched successfully.",
    data,
  });
};

export const getAdminUserAnalytics: RequestHandler = async (
  _request,
  response,
) => {
  const data = await analyticsService.getAdminUserAnalytics();
  response.status(200).json({
    success: true,
    message: "Admin user analytics fetched successfully.",
    data,
  });
};

export const getOwnerAnalyticsOverview: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const data = await analyticsService.getOwnerAnalyticsOverview(owner.id);
  response.status(200).json({
    success: true,
    message: "Owner analytics overview fetched successfully.",
    data,
  });
};

export const getOwnerRevenueAnalytics: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const range = parseAnalyticsRevenueQuery(
    request.query as Record<string, unknown>,
  );
  const data = await analyticsService.getOwnerRevenueAnalytics(
    owner.id,
    range,
  );
  response.status(200).json({
    success: true,
    message: "Owner revenue analytics fetched successfully.",
    data,
  });
};

export const getOwnerEquipmentAnalytics: RequestHandler = async (
  request,
  response,
) => {
  const owner = getAuthenticatedOwner(request.user);
  const data = await analyticsService.getOwnerEquipmentAnalytics(owner.id);
  response.status(200).json({
    success: true,
    message: "Owner equipment analytics fetched successfully.",
    data,
  });
};
