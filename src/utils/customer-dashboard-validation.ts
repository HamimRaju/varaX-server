import {
  BOOKING_STATUSES,
  BOOKING_PAYMENT_STATUSES,
  type BookingPaymentStatus,
  type BookingStatus,
} from "../models/types.js";
import { HttpError } from "./http-error.js";
import type { DashboardPagination } from "../services/customer-dashboard.service.js";

export interface CustomerBookingHistoryQuery {
  pagination: DashboardPagination;
  status?: BookingStatus;
  paymentStatus?: BookingPaymentStatus;
  sort: "newest" | "oldest";
}

export interface ProfileUpdate {
  set: Record<string, string>;
  unset: string[];
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a single value.`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  field: string,
  defaultValue: number,
  max?: number,
): number {
  const text = queryString(value, field);
  if (text === undefined) return defaultValue;
  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, `${field} must be a positive integer.`);
  }
  const parsed = Number(text);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    (max !== undefined && parsed > max)
  ) {
    throw new HttpError(
      400,
      max === undefined
        ? `${field} must be a positive integer.`
        : `${field} must be between 1 and ${max}.`,
    );
  }
  return parsed;
}

export function parseDashboardPagination(
  query: Record<string, unknown>,
  defaultLimit = 10,
): DashboardPagination {
  return {
    page: positiveInteger(query.page, "page", 1),
    limit: positiveInteger(query.limit, "limit", defaultLimit, 50),
  };
}

export function parseCustomerBookingHistoryQuery(
  query: Record<string, unknown>,
): CustomerBookingHistoryQuery {
  const pagination = parseDashboardPagination(query, 10);
  const rawStatus = queryString(query.status, "status");
  const rawPaymentStatus = queryString(query.paymentStatus, "paymentStatus");
  const rawSort = queryString(query.sort, "sort") ?? "newest";

  if (
    rawStatus !== undefined &&
    !BOOKING_STATUSES.some((status) => status === rawStatus)
  ) {
    throw new HttpError(
      400,
      `status must be one of: ${BOOKING_STATUSES.join(", ")}.`,
    );
  }
  if (
    rawPaymentStatus !== undefined &&
    !BOOKING_PAYMENT_STATUSES.some(
      (paymentStatus) => paymentStatus === rawPaymentStatus,
    )
  ) {
    throw new HttpError(
      400,
      `paymentStatus must be one of: ${BOOKING_PAYMENT_STATUSES.join(", ")}.`,
    );
  }
  if (rawSort !== "newest" && rawSort !== "oldest") {
    throw new HttpError(400, "sort must be newest or oldest.");
  }

  return {
    pagination,
    ...(rawStatus ? { status: rawStatus as BookingStatus } : {}),
    ...(rawPaymentStatus
      ? { paymentStatus: rawPaymentStatus as BookingPaymentStatus }
      : {}),
    sort: rawSort,
  };
}

export function parseProfileUpdate(value: unknown): ProfileUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "A JSON request body is required.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["name", "image", "phone"]);
  const protectedOrUnknown = Object.keys(input).find((key) => !allowed.has(key));
  if (protectedOrUnknown) {
    throw new HttpError(
      400,
      `${protectedOrUnknown} cannot be updated through this endpoint.`,
    );
  }
  if (Object.keys(input).length === 0) {
    throw new HttpError(400, "Provide at least one profile field to update.");
  }

  const set: Record<string, string> = {};
  const unset: string[] = [];
  if (Object.hasOwn(input, "name")) {
    if (
      typeof input.name !== "string" ||
      input.name.trim().length < 1 ||
      input.name.trim().length > 120
    ) {
      throw new HttpError(400, "name must be between 1 and 120 characters.");
    }
    set.name = input.name.trim();
  }
  if (Object.hasOwn(input, "image")) {
    if (typeof input.image !== "string" || input.image.trim().length > 2048) {
      throw new HttpError(400, "image must be a URL no longer than 2048 characters.");
    }
    const image = input.image.trim();
    if (!image) {
      unset.push("image");
    } else {
      let parsedImage: URL;
      try {
        parsedImage = new URL(image);
      } catch {
        throw new HttpError(400, "image must be an absolute HTTP(S) URL.");
      }
      if (parsedImage.protocol !== "https:" && parsedImage.protocol !== "http:") {
        throw new HttpError(400, "image must be an absolute HTTP(S) URL.");
      }
      set.image = image;
    }
  }
  if (Object.hasOwn(input, "phone")) {
    if (typeof input.phone !== "string" || input.phone.trim().length > 32) {
      throw new HttpError(400, "phone must be no longer than 32 characters.");
    }
    const phone = input.phone.trim();
    if (!phone) {
      unset.push("phone");
    } else if (!/^[+()\d .-]{5,32}$/.test(phone)) {
      throw new HttpError(400, "phone must be a valid contact number.");
    } else {
      set.phone = phone;
    }
  }
  return { set, unset };
}
