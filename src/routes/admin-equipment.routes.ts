import { Router } from "express";
import {
  deleteEquipmentAsAdmin,
  listAllEquipment,
  updateEquipmentAsAdmin,
  updateEquipmentStatus,
} from "../controllers/admin-equipment.controller.js";
import { verifyAdmin, verifyToken } from "../middleware/auth.middleware.js";

const adminEquipmentRouter = Router();

adminEquipmentRouter.use(verifyToken, verifyAdmin);
adminEquipmentRouter.get("/", listAllEquipment);
adminEquipmentRouter.patch("/:id/status", updateEquipmentStatus);
adminEquipmentRouter.patch("/:id", updateEquipmentAsAdmin);
adminEquipmentRouter.delete("/:id", deleteEquipmentAsAdmin);

export default adminEquipmentRouter;
