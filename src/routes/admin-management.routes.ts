import { Router } from "express";
import {
  getAdminBookingAnalytics,
  getAdminEquipmentAnalytics,
  getAdminRevenueAnalytics,
  getAdminUserAnalytics,
  getAdminAnalyticsOverview,
} from "../controllers/analytics.controller.js";
import {
  getAdminBookings,
  getAdminBookingDetails,
  getAdminDashboardOverview,
  getAdminDashboardProfile,
  getAdminPayments,
  getAdminUserDetails,
  getAdminUsers,
  updateAdminDashboardProfile,
  updateAdminUserRole,
  updateAdminUserStatus,
} from "../controllers/admin-management.controller.js";
import { verifyAdmin, verifyToken } from "../middleware/auth.middleware.js";
import {
  accountWriteLimiter,
  analyticsReadLimiter,
} from "../middleware/rate-limit.middleware.js";

const adminManagementRouter = Router();

adminManagementRouter.use(verifyToken, verifyAdmin);
adminManagementRouter.get(
  "/analytics/overview",
  analyticsReadLimiter,
  getAdminAnalyticsOverview,
);
adminManagementRouter.get(
  "/analytics/revenue",
  analyticsReadLimiter,
  getAdminRevenueAnalytics,
);
adminManagementRouter.get(
  "/analytics/bookings",
  analyticsReadLimiter,
  getAdminBookingAnalytics,
);
adminManagementRouter.get(
  "/analytics/equipment",
  analyticsReadLimiter,
  getAdminEquipmentAnalytics,
);
adminManagementRouter.get(
  "/analytics/users",
  analyticsReadLimiter,
  getAdminUserAnalytics,
);
adminManagementRouter.get("/dashboard/overview", getAdminDashboardOverview);
adminManagementRouter.get("/dashboard/profile", getAdminDashboardProfile);
adminManagementRouter.patch(
  "/dashboard/profile",
  accountWriteLimiter,
  updateAdminDashboardProfile,
);
adminManagementRouter.get("/users", getAdminUsers);
adminManagementRouter.get("/users/:id", getAdminUserDetails);
adminManagementRouter.patch(
  "/users/:id/role",
  accountWriteLimiter,
  updateAdminUserRole,
);
adminManagementRouter.patch(
  "/users/:id/status",
  accountWriteLimiter,
  updateAdminUserStatus,
);
adminManagementRouter.get("/bookings", getAdminBookings);
adminManagementRouter.get("/bookings/:id", getAdminBookingDetails);
adminManagementRouter.get("/payments", getAdminPayments);

export default adminManagementRouter;
