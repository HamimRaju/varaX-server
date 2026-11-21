import mongoose, { Schema, Types, type Model } from "mongoose";
import { PAYMENT_STATUSES, type PaymentStatus } from "./types.js";

export interface PaymentFields {
  bookingId: Types.ObjectId;
  customerId: Types.ObjectId;
  stripeSessionId: string;
  stripePaymentIntentId?: string;
  amount: number;
  currency?: string;
  paymentStatus?: PaymentStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

const paymentSchema = new Schema<PaymentFields>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    stripeSessionId: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (value: string) => value.length > 0,
        message: "Stripe session ID cannot be empty.",
      },
    },
    stripePaymentIntentId: {
      type: String,
      trim: true,
      validate: {
        validator: (value: string | undefined) =>
          value === undefined || value.length > 0,
        message: "Stripe payment intent ID cannot be empty.",
      },
    },
    amount: {
      type: Number,
      required: true,
      min: [0.01, "Payment amount must be greater than zero."],
      validate: {
        validator: Number.isFinite,
        message: "Payment amount must be a finite number.",
      },
    },
    currency: {
      type: String,
      default: "bdt",
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 3,
    },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "pending",
    },
  },
  { timestamps: true, collection: "payments" },
);

paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ customerId: 1 });
paymentSchema.index(
  { stripeSessionId: 1 },
  { unique: true, name: "payments_stripe_session_unique" },
);
paymentSchema.index(
  { stripePaymentIntentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      stripePaymentIntentId: { $type: "string" },
    },
    name: "payments_stripe_intent_unique",
  },
);

export const Payment =
  (mongoose.models.Payment as Model<PaymentFields> | undefined) ??
  mongoose.model<PaymentFields>("Payment", paymentSchema, "payments");
