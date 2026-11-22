import { Router } from "express";
import {
  getOwnerDashboardEarnings,
  getOwnerDashboardEquipment,
  getOwnerDashboardOverview,
  getOwnerDashboardProfile,
  getOwnerDashboardRentalRequests,
  updateOwnerDashboardProfile,
} from "../controllers/owner-dashboard.controller.js";
import { verifyOwner, verifyToken } from "../middleware/auth.middleware.js";

const ownerDashboardRouter = Router();

ownerDashboardRouter.use(verifyToken, verifyOwner);
ownerDashboardRouter.get("/overview", getOwnerDashboardOverview);
ownerDashboardRouter.get("/equipment", getOwnerDashboardEquipment);
ownerDashboardRouter.get("/rental-requests", getOwnerDashboardRentalRequests);
ownerDashboardRouter.get("/earnings", getOwnerDashboardEarnings);
ownerDashboardRouter.get("/profile", getOwnerDashboardProfile);
ownerDashboardRouter.patch("/profile", updateOwnerDashboardProfile);

export default ownerDashboardRouter;
