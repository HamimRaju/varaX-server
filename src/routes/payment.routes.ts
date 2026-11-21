import { Router } from "express";
import {
  createCheckoutSession,
  getPaymentStatus,
} from "../controllers/payment.controller.js";
import {
  verifyRenter,
  verifyToken,
} from "../middleware/auth.middleware.js";

const paymentRouter = Router();

paymentRouter.post(
  "/create-checkout-session",
  verifyToken,
  verifyRenter,
  createCheckoutSession,
);
paymentRouter.get("/:bookingId/status", verifyToken, getPaymentStatus);

export default paymentRouter;
