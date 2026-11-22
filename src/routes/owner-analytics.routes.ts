import { Router } from "express";
import {
  getOwnerAnalyticsOverview,
  getOwnerEquipmentAnalytics,
  getOwnerRevenueAnalytics,
} from "../controllers/analytics.controller.js";
import { verifyOwner, verifyToken } from "../middleware/auth.middleware.js";
import { analyticsReadLimiter } from "../middleware/rate-limit.middleware.js";

const ownerAnalyticsRouter = Router();

ownerAnalyticsRouter.use(verifyToken, verifyOwner);
ownerAnalyticsRouter.get(
  "/overview",
  analyticsReadLimiter,
  getOwnerAnalyticsOverview,
);
ownerAnalyticsRouter.get(
  "/revenue",
  analyticsReadLimiter,
  getOwnerRevenueAnalytics,
);
ownerAnalyticsRouter.get(
  "/equipment",
  analyticsReadLimiter,
  getOwnerEquipmentAnalytics,
);

export default ownerAnalyticsRouter;
