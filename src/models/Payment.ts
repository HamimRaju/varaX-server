import mongoose, { Schema, Types, type Model } from "mongoose";
import { PAYMENT_STATUSES, type PaymentStatus } from "./types.js";

export interface PaymentFields {
  bookingId: Types.ObjectId;
  customerId: Types.ObjectId;
  /** Snapshotted major-unit amount retained for compatibility with Step 02. */
  ownerId?: Types.ObjectId;
  equipmentId?: Types.ObjectId;
  stripeSessionId: string;
  stripePaymentIntentId?: string;
  amount: number;
  /** Authoritative Stripe amount, in integer currency minor units. */
  amountMinorUnits?: number;
  /** Amount and currency reported by Stripe on a successful paid event. */
  receivedAmountMinorUnits?: number;
  receivedCurrency?: string;
  currency?: string;
  paymentStatus?: PaymentStatus;
  status?: PaymentStatus;
  paymentMethod?: string;
  paidAt?: Date;
  checkoutAttemptId?: string;
  checkoutUrl?: string;
  checkoutExpiresAt?: Date;
  activeBookingId?: Types.ObjectId;
  fulfillmentStatus?:
    | "pending"
    | "fulfilled"
    | "refund_pending"
    | "refund_required"
    | "refunded"
    | "review_required";
  reconciliationReason?: string;
  stripeEventIds?: string[];
  stripeRefundId?: string;
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
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    equipmentId: {
      type: Schema.Types.ObjectId,
      ref: "Equipment",
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
    amountMinorUnits: {
      type: Number,
      min: [1, "Payment amount in minor units must be positive."],
      validate: {
        validator: (value: number | undefined) =>
          value === undefined || Number.isSafeInteger(value),
        message: "Payment amount in minor units must be a safe integer.",
      },
    },
    receivedAmountMinorUnits: {
      type: Number,
      min: [0, "Received amount in minor units cannot be negative."],
      validate: {
        validator: (value: number | undefined) =>
          value === undefined || Number.isSafeInteger(value),
        message: "Received amount in minor units must be a safe integer.",
      },
    },
    receivedCurrency: {
      type: String,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 3,
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
      alias: "status",
    },
    paymentMethod: { type: String, trim: true, maxlength: 64 },
    paidAt: { type: Date },
    checkoutAttemptId: { type: String, trim: true, maxlength: 128 },
    checkoutUrl: { type: String, trim: true },
    checkoutExpiresAt: { type: Date },
    activeBookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
    },
    fulfillmentStatus: {
      type: String,
      enum: [
        "pending",
        "fulfilled",
        "refund_pending",
        "refund_required",
        "refunded",
        "review_required",
      ],
      default: "pending",
    },
    reconciliationReason: { type: String, trim: true, maxlength: 500 },
    stripeEventIds: {
      type: [String],
      default: [],
    },
    stripeRefundId: { type: String, trim: true },
  },
  { timestamps: true, collection: "payments" },
);

paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ customerId: 1 });
paymentSchema.index({ ownerId: 1 });
paymentSchema.index({ equipmentId: 1 });
paymentSchema.index({ bookingId: 1, createdAt: -1 });
paymentSchema.index(
  { activeBookingId: 1 },
  {
    unique: true,
    partialFilterExpression: { activeBookingId: { $type: "objectId" } },
    name: "payments_one_active_checkout_per_booking_uidx",
  },
);
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
