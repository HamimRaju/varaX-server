import mongoose, { Schema, Types, type Model } from "mongoose";
import {
  BOOKING_STATUSES,
  BOOKING_PAYMENT_STATUSES,
  RENTAL_TYPES,
  type BookingStatus,
  type BookingPaymentStatus,
  type RentalType,
} from "./types.js";

export interface BookingFields {
  customerId: Types.ObjectId;
  ownerId: Types.ObjectId;
  equipmentId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  quantity: number;
  contactNumber: string;
  deliveryAddress: string;
  additionalNotes?: string;
  rentalType: RentalType;
  /** Price captured when the booking is created; independent of current equipment price. */
  unitPrice: number;
  totalAmount: number;
  bookingStatus?: BookingStatus;
  paymentStatus?: BookingPaymentStatus;
  stripeSessionId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const bookingSchema = new Schema<BookingFields>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    equipmentId: {
      type: Schema.Types.ObjectId,
      ref: "Equipment",
      required: true,
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Quantity must be at least one."],
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be a whole number.",
      },
    },
    contactNumber: { type: String, required: true, trim: true },
    deliveryAddress: { type: String, required: true, trim: true },
    additionalNotes: { type: String, trim: true },
    rentalType: {
      type: String,
      required: true,
      enum: RENTAL_TYPES,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: [0.01, "Unit price must be greater than zero."],
      validate: {
        validator: Number.isFinite,
        message: "Unit price must be a finite number.",
      },
    },
    totalAmount: {
      type: Number,
      required: true,
      min: [0.01, "Total amount must be greater than zero."],
      validate: {
        validator: Number.isFinite,
        message: "Total amount must be a finite number.",
      },
    },
    bookingStatus: {
      type: String,
      enum: BOOKING_STATUSES,
      default: "pending",
    },
    paymentStatus: {
      type: String,
      enum: BOOKING_PAYMENT_STATUSES,
      default: "unpaid",
    },
    stripeSessionId: { type: String, trim: true },
  },
  { timestamps: true, collection: "bookings" },
);

bookingSchema.pre("validate", function () {
  if (
    this.startDate instanceof Date &&
    this.endDate instanceof Date &&
    this.startDate.getTime() >= this.endDate.getTime()
  ) {
    this.invalidate("endDate", "End date must be after start date.");
  }
});

bookingSchema.index({ customerId: 1 });
bookingSchema.index({ ownerId: 1 });
bookingSchema.index({ equipmentId: 1 });
bookingSchema.index({ bookingStatus: 1 });
bookingSchema.index({ paymentStatus: 1 });
bookingSchema.index({ startDate: 1, endDate: 1 });

export const Booking =
  (mongoose.models.Booking as Model<BookingFields> | undefined) ??
  mongoose.model<BookingFields>("Booking", bookingSchema, "bookings");
