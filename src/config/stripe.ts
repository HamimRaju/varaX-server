import Stripe from "stripe";
import { env } from "./env.js";

export const STRIPE_CURRENCY = "bdt";
export const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET;

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  appInfo: {
    name: "VaraX Server",
  },
});
