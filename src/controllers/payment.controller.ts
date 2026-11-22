import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { stripe, stripeWebhookSecret } from "../config/stripe.js";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import {
  parseCreateCheckoutInput,
  parsePaymentBookingId,
} from "../utils/payment-validation.js";
import * as paymentService from "../services/payment.service.js";

function getAuthenticatedUser(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const createCheckoutSession: RequestHandler = async (
  request,
  response,
) => {
  const user = getAuthenticatedUser(request.user);
  const { bookingId } = parseCreateCheckoutInput(request.body);
  const checkout = await paymentService.createCheckoutSession(
    bookingId,
    user,
  );
  response.status(checkout.reused ? 200 : 201).json({
    success: true,
    message: checkout.reused
      ? "Existing Checkout Session returned."
      : "Checkout Session created.",
    data: {
      paymentId: checkout.paymentId,
      sessionId: checkout.sessionId,
      url: checkout.url,
      expiresAt: checkout.expiresAt,
    },
  });
};

export const getPaymentStatus: RequestHandler = async (request, response) => {
  const user = getAuthenticatedUser(request.user);
  const bookingId = parsePaymentBookingId(request.params.bookingId);
  const payment = await paymentService.getPaymentStatus(bookingId, user);
  response.status(200).json({ success: true, data: payment });
};

export const completeDemoPayment: RequestHandler = async (request, response) => {
  if (env.NODE_ENV === "production" || !env.ENABLE_DEMO_PAYMENTS) {
    throw new HttpError(404, "Not found.");
  }
  const user = getAuthenticatedUser(request.user);
  const { bookingId } = parseCreateCheckoutInput(request.body);
  const payment = await paymentService.completeDemoPayment(bookingId, user);
  response.status(200).json({
    success: true,
    message: "Demo payment completed. No real charge was made.",
    data: payment,
  });
};

export const stripeWebhook: RequestHandler = async (request, response) => {
  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({
      success: false,
      message: "A raw Stripe webhook request body is required.",
    });
    return;
  }

  const signature = request.get("stripe-signature");
  if (!signature) {
    response.status(400).json({
      success: false,
      message: "Stripe-Signature header is required.",
    });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      signature,
      stripeWebhookSecret,
    );
  } catch {
    response.status(400).json({
      success: false,
      message: "Invalid Stripe webhook signature.",
    });
    return;
  }

  await paymentService.handleStripeWebhookEvent(event);
  response.status(200).json({ received: true });
};
