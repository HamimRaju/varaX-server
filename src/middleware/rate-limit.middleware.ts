import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const TOO_MANY_REQUESTS = {
  success: false,
  message: "Too many requests. Please try again later.",
};

function byUserOrIp(request: Request) {
  if (request.user?.id) {
    return `user:${request.user.id.toString()}`;
  }
  return ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? "unknown");
}

function makeLimiter(options: {
  windowMs: number;
  limit: number;
  authenticatedUser?: boolean;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: TOO_MANY_REQUESTS,
    ...(options.authenticatedUser
      ? { keyGenerator: byUserOrIp }
      : {}),
  });
}

/** Guards the JWT/database work performed by protected routes. */
export const protectedRequestLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 600,
});

export const publicReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 300,
});

/** Additional per-account guard for inventory and booking mutations. */
export const bookingWriteLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  authenticatedUser: true,
});

/** Checkout creation is more expensive and calls Stripe. */
export const checkoutLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  authenticatedUser: true,
});

/** Limits authenticated profile, favorite, and administrative writes. */
export const accountWriteLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  authenticatedUser: true,
});

/** Aggregations can be expensive; limit repeated analytics reads per account. */
export const analyticsReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  authenticatedUser: true,
});

/**
 * Stripe retries are expected, so this is deliberately much higher than
 * interactive limits. Webhook event idempotency remains the primary control.
 */
export const stripeWebhookLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 500,
});
