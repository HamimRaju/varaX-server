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

const adminManagementRouter = Router();

adminManagementRouter.use(verifyToken, verifyAdmin);
adminManagementRouter.get("/analytics/overview", getAdminAnalyticsOverview);
adminManagementRouter.get("/analytics/revenue", getAdminRevenueAnalytics);
adminManagementRouter.get("/analytics/bookings", getAdminBookingAnalytics);
adminManagementRouter.get("/analytics/equipment", getAdminEquipmentAnalytics);
adminManagementRouter.get("/analytics/users", getAdminUserAnalytics);
adminManagementRouter.get("/dashboard/overview", getAdminDashboardOverview);
adminManagementRouter.get("/dashboard/profile", getAdminDashboardProfile);
adminManagementRouter.patch("/dashboard/profile", updateAdminDashboardProfile);
adminManagementRouter.get("/users", getAdminUsers);
adminManagementRouter.get("/users/:id", getAdminUserDetails);
adminManagementRouter.patch("/users/:id/role", updateAdminUserRole);
adminManagementRouter.patch("/users/:id/status", updateAdminUserStatus);
adminManagementRouter.get("/bookings", getAdminBookings);
adminManagementRouter.get("/bookings/:id", getAdminBookingDetails);
adminManagementRouter.get("/payments", getAdminPayments);

export default adminManagementRouter;
