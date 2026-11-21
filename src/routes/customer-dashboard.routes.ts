import { Router } from "express";
import {
  getCustomerDashboardActivity,
  getCustomerDashboardBookings,
  getCustomerDashboardFavorites,
  getCustomerDashboardOverview,
  getCustomerDashboardProfile,
  updateCustomerDashboardProfile,
} from "../controllers/customer-dashboard.controller.js";
import {
  verifyRenter,
  verifyToken,
} from "../middleware/auth.middleware.js";

const customerDashboardRouter = Router();

customerDashboardRouter.use(verifyToken, verifyRenter);
customerDashboardRouter.get("/overview", getCustomerDashboardOverview);
customerDashboardRouter.get("/bookings", getCustomerDashboardBookings);
customerDashboardRouter.get("/favorites", getCustomerDashboardFavorites);
customerDashboardRouter.get("/profile", getCustomerDashboardProfile);
customerDashboardRouter.patch("/profile", updateCustomerDashboardProfile);
customerDashboardRouter.get("/activity", getCustomerDashboardActivity);

export default customerDashboardRouter;
