import { Types } from "mongoose";
import { HttpError } from "./http-error.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObjectId(value: unknown, field: string): Types.ObjectId {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, `${field} must be a valid ObjectId.`);
  }
  return new Types.ObjectId(value);
}

export function parseCreateCheckoutInput(value: unknown): {
  bookingId: Types.ObjectId;
} {
  if (!isRecord(value)) {
    throw new HttpError(400, "A JSON request body is required.");
  }
  return { bookingId: parseObjectId(value.bookingId, "bookingId") };
}

export function parsePaymentBookingId(value: unknown): Types.ObjectId {
  return parseObjectId(value, "bookingId");
}
