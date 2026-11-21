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

const equipmentRouter = Router();

const optionalVerifyToken: RequestHandler = (request, response, next) => {
  if (!request.get("authorization")) {
    next();
    return;
  }
  void verifyToken(request, response, next);
};

equipmentRouter.get("/", listPublicEquipment);
equipmentRouter.post("/", verifyToken, verifyOwner, createEquipment);
equipmentRouter.get(
  "/my-equipment",
  verifyToken,
  verifyOwner,
  listMyEquipment,
);
equipmentRouter.get("/:id/availability", getEquipmentAvailability);
equipmentRouter.get("/:id", optionalVerifyToken, getEquipmentDetails);
equipmentRouter.patch(
  "/:id",
  verifyToken,
  verifyOwner,
  updateMyEquipment,
);
equipmentRouter.delete(
  "/:id",
  verifyToken,
  verifyOwner,
  deleteMyEquipment,
);

export default equipmentRouter;
