import { Types } from "mongoose";
import {
  BOOKING_STATUSES,
  RENTAL_TYPES,
  type BookingStatus,
} from "../models/types.js";
import { HttpError } from "./http-error.js";

export interface CreateBookingInput {
  equipmentId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  quantity: number;
  contactNumber: string;
  deliveryAddress: string;
  notes?: string;
}

export interface BookingPagination {
  page: number;
  limit: number;
}

export interface AvailabilityInput {
  startDate: Date;
  endDate: Date;
  quantity: number;
}

export interface OwnerBookingStatusInput {
  status: Extract<BookingStatus, "confirmed" | "rejected" | "active" | "completed">;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDateOnly(value: unknown, field: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new HttpError(400, `${field} must be a valid YYYY-MM-DD date.`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new HttpError(400, `${field} must be a valid YYYY-MM-DD date.`);
  }
  return date;
}

function parseDateRange(
  startValue: unknown,
  endValue: unknown,
): Pick<AvailabilityInput, "startDate" | "endDate"> {
  const startDate = parseDateOnly(startValue, "startDate");
  const endDate = parseDateOnly(endValue, "endDate");
  if (endDate.getTime() <= startDate.getTime()) {
    throw new HttpError(400, "endDate must be after startDate.");
  }
  return { startDate, endDate };
}

function parsePositiveInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `${field} must be a positive integer.`);
  }
  return parsed;
}

export function parseBookingId(value: unknown): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "Booking ID must be a valid ObjectId.");
  }
  return new Types.ObjectId(value);
}

export function parseBookingEquipmentId(value: unknown): Types.ObjectId {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "equipmentId must be a valid ObjectId.");
  }
  return new Types.ObjectId(value);
}

export function parseCreateBookingInput(value: unknown): CreateBookingInput {
  if (!isRecord(value)) {
    throw new HttpError(400, "A JSON request body is required.");
  }
  const equipmentId = parseBookingEquipmentId(value.equipmentId);
  const { startDate, endDate } = parseDateRange(
    value.startDate,
    value.endDate,
  );
  const quantity = parsePositiveInteger(value.quantity, "quantity");

  if (
    typeof value.contactNumber !== "string" ||
    value.contactNumber.trim().length < 5 ||
    value.contactNumber.trim().length > 32
  ) {
    throw new HttpError(400, "contactNumber is required and must be 5–32 characters.");
  }
  if (
    typeof value.deliveryAddress !== "string" ||
    value.deliveryAddress.trim().length < 3 ||
    value.deliveryAddress.trim().length > 1000
  ) {
    throw new HttpError(400, "deliveryAddress is required and must be 3–1000 characters.");
  }
  if (
    value.notes !== undefined &&
    (typeof value.notes !== "string" || value.notes.trim().length > 2000)
  ) {
    throw new HttpError(400, "notes must be a string no longer than 2000 characters.");
  }

  return {
    equipmentId,
    startDate,
    endDate,
    quantity,
    contactNumber: value.contactNumber.trim(),
    deliveryAddress: value.deliveryAddress.trim(),
    ...(typeof value.notes === "string" && value.notes.trim()
      ? { notes: value.notes.trim() }
      : {}),
  };
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a single value.`);
  }
  return value;
}

export function parseBookingPagination(query: Record<string, unknown>): BookingPagination {
  const pageValue = queryString(query.page, "page");
  const limitValue = queryString(query.limit, "limit");
  const page = pageValue === undefined ? 1 : Number(pageValue);
  const limit = limitValue === undefined ? 9 : Number(limitValue);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new HttpError(400, "page must be a positive integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(400, "limit must be an integer between 1 and 50.");
  }
  return { page, limit };
}

export function parseBookingStatusFilter(
  value: unknown,
): BookingStatus | undefined {
  const status = queryString(value, "status");
  if (status === undefined) return undefined;
  if (!BOOKING_STATUSES.some((supportedStatus) => supportedStatus === status)) {
    throw new HttpError(400, `status must be one of: ${BOOKING_STATUSES.join(", ")}.`);
  }
  return status as BookingStatus;
}

export function parseOwnerBookingStatusInput(
  value: unknown,
): OwnerBookingStatusInput {
  if (!isRecord(value)) {
    throw new HttpError(400, "A JSON request body is required.");
  }
  const status = value.status;
  if (
    status !== "confirmed" &&
    status !== "rejected" &&
    status !== "active" &&
    status !== "completed"
  ) {
    throw new HttpError(
      400,
      "status must be confirmed, rejected, active, or completed.",
    );
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" || value.reason.trim().length > 1000)
  ) {
    throw new HttpError(400, "reason must be a string no longer than 1000 characters.");
  }
  if (status === "rejected" && (typeof value.reason !== "string" || !value.reason.trim())) {
    throw new HttpError(400, "A reason is required when rejecting a booking.");
  }
  return {
    status,
    ...(typeof value.reason === "string" && value.reason.trim()
      ? { reason: value.reason.trim() }
      : {}),
  };
}

export function parseCancellationReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new HttpError(400, "Cancellation details must be a JSON object.");
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" || value.reason.trim().length > 1000)
  ) {
    throw new HttpError(400, "reason must be a string no longer than 1000 characters.");
  }
  return typeof value.reason === "string" && value.reason.trim()
    ? value.reason.trim()
    : undefined;
}

export function parseAvailabilityInput(
  query: Record<string, unknown>,
): AvailabilityInput {
  const { startDate, endDate } = parseDateRange(
    query.startDate,
    query.endDate,
  );
  const quantity =
    query.quantity === undefined
      ? 1
      : parsePositiveInteger(query.quantity, "quantity");
  return { startDate, endDate, quantity };
}

export function isRentalType(value: unknown): value is (typeof RENTAL_TYPES)[number] {
  return (
    typeof value === "string" &&
    RENTAL_TYPES.some((rentalType) => rentalType === value)
  );
}

export function parseIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length < 8 ||
    value.trim().length > 128 ||
    !/^[\w\-:.]+$/.test(value.trim())
  ) {
    throw new HttpError(
      400,
      "Idempotency-Key must be 8–128 letters, digits, or . _ : - characters.",
    );
  }
  return value.trim();
}

export function getUtcToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function validateBookingStartDate(startDate: Date): void {
  if (startDate.getTime() < getUtcToday().getTime()) {
    throw new HttpError(400, "startDate cannot be in the past.");
  }
}
