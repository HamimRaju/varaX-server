import { Router } from "express";
import {
  createCheckoutSession,
  getPaymentStatus,
} from "../controllers/payment.controller.js";
import {
  verifyRenter,
  verifyToken,
} from "../middleware/auth.middleware.js";
import { checkoutLimiter } from "../middleware/rate-limit.middleware.js";

const paymentRouter = Router();

paymentRouter.post(
  "/create-checkout-session",
  verifyToken,
  verifyRenter,
  checkoutLimiter,
  createCheckoutSession,
);
paymentRouter.get("/:bookingId/status", verifyToken, getPaymentStatus);

export default paymentRouter;
