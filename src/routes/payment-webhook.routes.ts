import express, { Router } from "express";
import { stripeWebhook } from "../controllers/payment.controller.js";
import { stripeWebhookLimiter } from "../middleware/rate-limit.middleware.js";

const paymentWebhookRouter = Router();

paymentWebhookRouter.post(
  "/",
  stripeWebhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  stripeWebhook,
);

export default paymentWebhookRouter;
