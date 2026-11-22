import { Router } from "express";
import {
  getOwnerAnalyticsOverview,
  getOwnerEquipmentAnalytics,
  getOwnerRevenueAnalytics,
} from "../controllers/analytics.controller.js";
import { verifyOwner, verifyToken } from "../middleware/auth.middleware.js";

const ownerAnalyticsRouter = Router();

ownerAnalyticsRouter.use(verifyToken, verifyOwner);
ownerAnalyticsRouter.get("/overview", getOwnerAnalyticsOverview);
ownerAnalyticsRouter.get("/revenue", getOwnerRevenueAnalytics);
ownerAnalyticsRouter.get("/equipment", getOwnerEquipmentAnalytics);

export default ownerAnalyticsRouter;
