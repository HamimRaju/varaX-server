import { Router, type RequestHandler } from "express";
import {
  verifyOwner,
  verifyToken,
} from "../middleware/auth.middleware.js";
import {
  createEquipment,
  deleteMyEquipment,
  getEquipmentDetails,
  listMyEquipment,
  listPublicEquipment,
  updateMyEquipment,
} from "../controllers/equipment.controller.js";
import { getEquipmentAvailability } from "../controllers/booking.controller.js";
import {
  accountWriteLimiter,
  publicReadLimiter,
} from "../middleware/rate-limit.middleware.js";

const equipmentRouter = Router();

const optionalVerifyToken: RequestHandler = (request, response, next) => {
  if (!request.get("authorization")) {
    next();
    return;
  }
  void verifyToken(request, response, next);
};

equipmentRouter.get("/", publicReadLimiter, listPublicEquipment);
equipmentRouter.post(
  "/",
  verifyToken,
  verifyOwner,
  accountWriteLimiter,
  createEquipment,
);
equipmentRouter.get(
  "/my-equipment",
  verifyToken,
  verifyOwner,
  listMyEquipment,
);
equipmentRouter.get(
  "/:id/availability",
  publicReadLimiter,
  getEquipmentAvailability,
);
equipmentRouter.get("/:id", optionalVerifyToken, getEquipmentDetails);
equipmentRouter.patch(
  "/:id",
  verifyToken,
  verifyOwner,
  accountWriteLimiter,
  updateMyEquipment,
);
equipmentRouter.delete(
  "/:id",
  verifyToken,
  verifyOwner,
  accountWriteLimiter,
  deleteMyEquipment,
);

export default equipmentRouter;
