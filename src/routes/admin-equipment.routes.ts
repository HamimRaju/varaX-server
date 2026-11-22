import { Router } from "express";
import {
  deleteEquipmentAsAdmin,
  listAllEquipment,
  updateEquipmentAsAdmin,
  updateEquipmentStatus,
} from "../controllers/admin-equipment.controller.js";
import { verifyAdmin, verifyToken } from "../middleware/auth.middleware.js";
import { accountWriteLimiter } from "../middleware/rate-limit.middleware.js";

const adminEquipmentRouter = Router();

adminEquipmentRouter.use(verifyToken, verifyAdmin);
adminEquipmentRouter.get("/", listAllEquipment);
adminEquipmentRouter.patch(
  "/:id/status",
  accountWriteLimiter,
  updateEquipmentStatus,
);
adminEquipmentRouter.patch("/:id", accountWriteLimiter, updateEquipmentAsAdmin);
adminEquipmentRouter.delete("/:id", accountWriteLimiter, deleteEquipmentAsAdmin);

export default adminEquipmentRouter;
