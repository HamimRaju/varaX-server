import { Types } from "mongoose";
import {
  BOOKING_PAYMENT_STATUSES,
  BOOKING_STATUSES,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  PAYMENT_STATUSES,
  USER_ROLES,
  type BookingPaymentStatus,
  type BookingStatus,
  type EquipmentCategory,
  type EquipmentStatus,
  type PaymentStatus,
  type UserRole,
} from "../models/types.js";
import { HttpError } from "./http-error.js";

export interface AdminPagination {
  page: number;
  limit: number;
}

export interface AdminUserQuery extends AdminPagination {
  role?: UserRole;
  search?: string;
  sort: "newest" | "oldest";
}

export interface AdminEquipmentQuery extends AdminPagination {
  status?: EquipmentStatus;
  search?: string;
  category?: EquipmentCategory;
  sort: "newest" | "oldest" | "price_asc" | "price_desc";
}

export interface AdminBookingQuery extends AdminPagination {
  status?: BookingStatus;
  paymentStatus?: BookingPaymentStatus;
  search?: string;
  sort: "newest" | "oldest";
}

export interface AdminPaymentQuery extends AdminPagination {
  status?: PaymentStatus;
  sort: "newest" | "oldest";
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a single value.`);
  }
  return value;
}

function validateQueryKeys(
  query: Record<string, unknown>,
  supported: readonly string[],
) {
  const fields = new Set(supported);
  const unexpected = Object.keys(query).find((field) => !fields.has(field));
  if (unexpected) {
    throw new HttpError(
      400,
      `${unexpected} is not a supported query parameter.`,
    );
  }
}

function parsePagination(query: Record<string, unknown>): AdminPagination {
  const pageText = queryString(query.page, "page");
  const limitText = queryString(query.limit, "limit");
  const page = pageText === undefined ? 1 : Number(pageText);
  const limit = limitText === undefined ? 10 : Number(limitText);
  if (
    pageText !== undefined &&
    (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1)
  ) {
    throw new HttpError(400, "page must be a positive integer.");
  }
  if (
    limitText !== undefined &&
    (!/^\d+$/.test(limitText) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50)
  ) {
    throw new HttpError(400, "limit must be an integer between 1 and 50.");
  }
  if (!Number.isSafeInteger((page - 1) * limit)) {
    throw new HttpError(400, "page is too large.");
  }
  return { page, limit };
}

function parseSearch(value: unknown): string | undefined {
  const text = queryString(value, "search");
  if (text === undefined) return undefined;
  if (text.trim().length > 120) {
    throw new HttpError(400, "search cannot exceed 120 characters.");
  }
  return text.trim() || undefined;
}

function parseSort(value: unknown): "newest" | "oldest" {
  const sort = queryString(value, "sort") ?? "newest";
  if (sort !== "newest" && sort !== "oldest") {
    throw new HttpError(400, "sort must be newest or oldest.");
  }
  return sort;
}

export function parseAdminUserQuery(
  query: Record<string, unknown>,
): AdminUserQuery {
  validateQueryKeys(query, ["page", "limit", "role", "search", "sort"]);
  const pagination = parsePagination(query);
  const role = queryString(query.role, "role");
  if (role !== undefined && !USER_ROLES.some((item) => item === role)) {
    throw new HttpError(400, `role must be one of: ${USER_ROLES.join(", ")}.`);
  }
  const search = parseSearch(query.search);
  return {
    ...pagination,
    ...(role ? { role: role as UserRole } : {}),
    ...(search ? { search } : {}),
    sort: parseSort(query.sort),
  };
}

export function parseAdminEquipmentQuery(
  query: Record<string, unknown>,
): AdminEquipmentQuery {
  validateQueryKeys(query, [
    "page",
    "limit",
    "status",
    "search",
    "category",
    "sort",
  ]);
  const pagination = parsePagination(query);
  const status = queryString(query.status, "status");
  const category = queryString(query.category, "category");
  const sort = queryString(query.sort, "sort") ?? "newest";
  if (
    status !== undefined &&
    !EQUIPMENT_STATUSES.some((item) => item === status)
  ) {
    throw new HttpError(
      400,
      `status must be one of: ${EQUIPMENT_STATUSES.join(", ")}.`,
    );
  }
  if (
    category !== undefined &&
    !EQUIPMENT_CATEGORIES.some((item) => item === category)
  ) {
    throw new HttpError(
      400,
      `category must be one of: ${EQUIPMENT_CATEGORIES.join(", ")}.`,
    );
  }
  if (
    sort !== "newest" &&
    sort !== "oldest" &&
    sort !== "price_asc" &&
    sort !== "price_desc"
  ) {
    throw new HttpError(
      400,
      "sort must be newest, oldest, price_asc, or price_desc.",
    );
  }
  const search = parseSearch(query.search);
  return {
    ...pagination,
    ...(status ? { status: status as EquipmentStatus } : {}),
    ...(category ? { category: category as EquipmentCategory } : {}),
    ...(search ? { search } : {}),
    sort,
  };
}

export function parseAdminBookingQuery(
  query: Record<string, unknown>,
): AdminBookingQuery {
  validateQueryKeys(query, [
    "page",
    "limit",
    "status",
    "paymentStatus",
    "search",
    "sort",
  ]);
  const pagination = parsePagination(query);
  const status = queryString(query.status, "status");
  const paymentStatus = queryString(query.paymentStatus, "paymentStatus");
  if (
    status !== undefined &&
    !BOOKING_STATUSES.some((item) => item === status)
  ) {
    throw new HttpError(
      400,
      `status must be one of: ${BOOKING_STATUSES.join(", ")}.`,
    );
  }
  if (
    paymentStatus !== undefined &&
    !BOOKING_PAYMENT_STATUSES.some((item) => item === paymentStatus)
  ) {
    throw new HttpError(
      400,
      `paymentStatus must be one of: ${BOOKING_PAYMENT_STATUSES.join(", ")}.`,
    );
  }
  const search = parseSearch(query.search);
  return {
    ...pagination,
    ...(status ? { status: status as BookingStatus } : {}),
    ...(paymentStatus
      ? { paymentStatus: paymentStatus as BookingPaymentStatus }
      : {}),
    ...(search ? { search } : {}),
    sort: parseSort(query.sort),
  };
}

export function parseAdminPaymentQuery(
  query: Record<string, unknown>,
): AdminPaymentQuery {
  validateQueryKeys(query, ["page", "limit", "status", "sort"]);
  const pagination = parsePagination(query);
  const status = queryString(query.status, "status");
  if (
    status !== undefined &&
    !PAYMENT_STATUSES.some((item) => item === status)
  ) {
    throw new HttpError(
      400,
      `status must be one of: ${PAYMENT_STATUSES.join(", ")}.`,
    );
  }
  return {
    ...pagination,
    ...(status ? { status: status as PaymentStatus } : {}),
    sort: parseSort(query.sort),
  };
}

export function parseAdminUserId(value: unknown): Types.ObjectId {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "User ID must be a valid ObjectId.");
  }
  return new Types.ObjectId(value);
}

export function parseAdminBookingId(value: unknown): Types.ObjectId {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "Booking ID must be a valid ObjectId.");
  }
  return new Types.ObjectId(value);
}

export function parseAdminRoleUpdate(
  value: unknown,
): { role: UserRole } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "A JSON request body is required.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((field) => field !== "role")) {
    throw new HttpError(400, "Only the role field can be updated.");
  }
  if (!USER_ROLES.some((role) => role === body.role)) {
    throw new HttpError(400, `role must be one of: ${USER_ROLES.join(", ")}.`);
  }
  return { role: body.role as UserRole };
}

export function parseAdminStatusUpdate(
  value: unknown,
): { isActive: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "A JSON request body is required.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((field) => field !== "isActive")) {
    throw new HttpError(400, "Only the isActive field can be updated.");
  }
  if (typeof body.isActive !== "boolean") {
    throw new HttpError(400, "isActive must be a boolean.");
  }
  return { isActive: body.isActive };
}
