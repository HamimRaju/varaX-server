import {
  BOOKING_STATUSES,
  EQUIPMENT_STATUSES,
  type BookingStatus,
  type EquipmentStatus,
} from "../models/types.js";
import { HttpError } from "./http-error.js";

interface DashboardPagination {
  page: number;
  limit: number;
}

export interface OwnerEquipmentQuery extends DashboardPagination {
  status?: EquipmentStatus;
  search?: string;
  sort: "newest" | "oldest" | "price_asc" | "price_desc";
}

export interface OwnerRentalRequestsQuery extends DashboardPagination {
  status?: BookingStatus;
  sort: "newest" | "oldest";
}

export interface OwnerEarningsQuery extends DashboardPagination {
  startDate?: Date;
  endDate?: Date;
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a single value.`);
  }
  return value;
}

function validateKeys(
  query: Record<string, unknown>,
  supported: readonly string[],
) {
  const fields = new Set(supported);
  const unexpected = Object.keys(query).find((key) => !fields.has(key));
  if (unexpected) {
    throw new HttpError(400, `${unexpected} is not a supported query parameter.`);
  }
}

function parsePagination(query: Record<string, unknown>): DashboardPagination {
  const pageValue = queryString(query.page, "page");
  const limitValue = queryString(query.limit, "limit");
  const page = pageValue === undefined ? 1 : Number(pageValue);
  const limit = limitValue === undefined ? 10 : Number(limitValue);
  if (
    pageValue !== undefined &&
    (!/^\d+$/.test(pageValue) || !Number.isSafeInteger(page) || page < 1)
  ) {
    throw new HttpError(400, "page must be a positive integer.");
  }
  if (
    limitValue !== undefined &&
    (!/^\d+$/.test(limitValue) ||
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

function parseDate(value: unknown, field: string): Date | undefined {
  const text = queryString(value, field);
  if (text === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new HttpError(400, `${field} must be a valid YYYY-MM-DD date.`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
  ) {
    throw new HttpError(400, `${field} must be a valid YYYY-MM-DD date.`);
  }
  return date;
}

export function parseOwnerEquipmentQuery(
  query: Record<string, unknown>,
): OwnerEquipmentQuery {
  validateKeys(query, ["page", "limit", "status", "search", "sort"]);
  const pagination = parsePagination(query);
  const rawStatus = queryString(query.status, "status");
  const rawSearch = queryString(query.search, "search");
  const rawSort = queryString(query.sort, "sort") ?? "newest";

  if (
    rawStatus !== undefined &&
    !EQUIPMENT_STATUSES.some((status) => status === rawStatus)
  ) {
    throw new HttpError(
      400,
      `status must be one of: ${EQUIPMENT_STATUSES.join(", ")}.`,
    );
  }
  if (rawSearch !== undefined && rawSearch.trim().length > 120) {
    throw new HttpError(400, "search cannot exceed 120 characters.");
  }
  if (
    rawSort !== "newest" &&
    rawSort !== "oldest" &&
    rawSort !== "price_asc" &&
    rawSort !== "price_desc"
  ) {
    throw new HttpError(
      400,
      "sort must be newest, oldest, price_asc, or price_desc.",
    );
  }

  return {
    ...pagination,
    ...(rawStatus ? { status: rawStatus as EquipmentStatus } : {}),
    ...(rawSearch?.trim() ? { search: rawSearch.trim() } : {}),
    sort: rawSort,
  };
}

export function parseOwnerRentalRequestsQuery(
  query: Record<string, unknown>,
): OwnerRentalRequestsQuery {
  validateKeys(query, ["page", "limit", "status", "sort"]);
  const pagination = parsePagination(query);
  const rawStatus = queryString(query.status, "status");
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
  if (rawSort !== "newest" && rawSort !== "oldest") {
    throw new HttpError(400, "sort must be newest or oldest.");
  }
  return {
    ...pagination,
    ...(rawStatus ? { status: rawStatus as BookingStatus } : {}),
    sort: rawSort,
  };
}

export function parseOwnerEarningsQuery(
  query: Record<string, unknown>,
): OwnerEarningsQuery {
  validateKeys(query, ["page", "limit", "startDate", "endDate"]);
  const pagination = parsePagination(query);
  const startDate = parseDate(query.startDate, "startDate");
  const endDate = parseDate(query.endDate, "endDate");
  if (
    startDate &&
    endDate &&
    startDate.getTime() > endDate.getTime()
  ) {
    throw new HttpError(400, "startDate must be on or before endDate.");
  }
  return {
    ...pagination,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}
