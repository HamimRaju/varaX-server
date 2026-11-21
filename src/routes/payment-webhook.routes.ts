import express, { Router } from "express";
import { stripeWebhook } from "../controllers/payment.controller.js";

const paymentWebhookRouter = Router();

paymentWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  stripeWebhook,
);

export default paymentWebhookRouter;
