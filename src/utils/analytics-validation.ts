import { HttpError } from "./http-error.js";

export const ANALYTICS_PERIODS = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

export interface AnalyticsRevenueQuery {
  period: AnalyticsPeriod;
  startDate: Date;
  endDate: Date;
  endDateExclusive: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS: Record<AnalyticsPeriod, number> = {
  daily: 366,
  weekly: 366 * 5,
  monthly: 366 * 10,
  yearly: 366 * 20,
};

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a single value.`);
  }
  return value;
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

function utcToday(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function mondayOf(date: Date): Date {
  const monday = new Date(date);
  const offset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - offset);
  return monday;
}

function defaultRange(period: AnalyticsPeriod, today: Date) {
  const endDate = today;
  let startDate: Date;
  switch (period) {
    case "daily":
      startDate = new Date(today.getTime() - 29 * DAY_MS);
      break;
    case "weekly": {
      const thisMonday = mondayOf(today);
      startDate = new Date(thisMonday.getTime() - 11 * 7 * DAY_MS);
      break;
    }
    case "monthly":
      startDate = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1),
      );
      break;
    case "yearly":
      startDate = new Date(Date.UTC(today.getUTCFullYear() - 4, 0, 1));
      break;
  }
  return { startDate, endDate };
}

export function parseAnalyticsRevenueQuery(
  query: Record<string, unknown>,
): AnalyticsRevenueQuery {
  const supported = new Set(["period", "startDate", "endDate"]);
  const unexpected = Object.keys(query).find((field) => !supported.has(field));
  if (unexpected) {
    throw new HttpError(
      400,
      `${unexpected} is not a supported query parameter.`,
    );
  }

  const rawPeriod = queryString(query.period, "period") ?? "monthly";
  if (!ANALYTICS_PERIODS.some((period) => period === rawPeriod)) {
    throw new HttpError(
      400,
      `period must be one of: ${ANALYTICS_PERIODS.join(", ")}.`,
    );
  }
  const period = rawPeriod as AnalyticsPeriod;
  const providedStart = parseDate(query.startDate, "startDate");
  const providedEnd = parseDate(query.endDate, "endDate");
  const today = utcToday();
  if ((providedStart && !providedEnd) || (!providedStart && providedEnd)) {
    throw new HttpError(400, "startDate and endDate must be provided together.");
  }

  const range =
    providedStart && providedEnd
      ? { startDate: providedStart, endDate: providedEnd }
      : defaultRange(period, today);

  if (range.startDate.getTime() > range.endDate.getTime()) {
    throw new HttpError(400, "startDate must be on or before endDate.");
  }
  if (range.endDate.getTime() > today.getTime()) {
    throw new HttpError(400, "endDate cannot be in the future.");
  }
  const inclusiveDays =
    Math.floor(
      (range.endDate.getTime() - range.startDate.getTime()) / DAY_MS,
    ) + 1;
  if (inclusiveDays > MAX_RANGE_DAYS[period]) {
    throw new HttpError(
      400,
      `The ${period} date range cannot exceed ${MAX_RANGE_DAYS[period]} days.`,
    );
  }
  return {
    period,
    ...range,
    endDateExclusive: new Date(range.endDate.getTime() + DAY_MS),
  };
}

export function lastTwelveMonthRange(now = new Date()) {
  const currentMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const startDate = new Date(
    Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 11, 1),
  );
  const endDateExclusive = new Date(
    Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, 1),
  );
  return { startDate, endDateExclusive };
}

export function rollingThirtyDayPeriods(now = new Date()) {
  const currentEnd = new Date(now);
  const currentStart = new Date(currentEnd.getTime() - 30 * DAY_MS);
  const previousStart = new Date(currentStart.getTime() - 30 * DAY_MS);
  return {
    currentStart,
    currentEnd,
    previousStart,
    previousEnd: currentStart,
  };
}

export function mongoPeriodFormat(period: AnalyticsPeriod): string {
  switch (period) {
    case "daily":
      return "%Y-%m-%d";
    case "weekly":
      return "%G-W%V";
    case "monthly":
      return "%Y-%m";
    case "yearly":
      return "%Y";
  }
}

function isoWeekLabel(date: Date): string {
  const dayNumber = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() + (3 - dayNumber) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const firstMonday = mondayOf(januaryFourth);
  const currentMonday = mondayOf(date);
  const week =
    Math.floor((currentMonday.getTime() - firstMonday.getTime()) / (7 * DAY_MS)) +
    1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function analyticsPeriodLabel(
  date: Date,
  period: AnalyticsPeriod,
): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  switch (period) {
    case "daily":
      return `${year}-${month}-${day}`;
    case "weekly":
      return isoWeekLabel(date);
    case "monthly":
      return `${year}-${month}`;
    case "yearly":
      return String(year);
  }
}

export function analyticsPeriodLabels(
  startDate: Date,
  endDate: Date,
  period: AnalyticsPeriod,
): string[] {
  const labels: string[] = [];
  if (period === "daily") {
    const cursor = new Date(startDate);
    while (cursor.getTime() <= endDate.getTime()) {
      labels.push(analyticsPeriodLabel(cursor, period));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return labels;
  }
  if (period === "weekly") {
    const cursor = mondayOf(startDate);
    while (cursor.getTime() <= endDate.getTime()) {
      labels.push(analyticsPeriodLabel(cursor, period));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return labels;
  }
  if (period === "monthly") {
    const cursor = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1),
    );
    while (cursor.getTime() <= endDate.getTime()) {
      labels.push(analyticsPeriodLabel(cursor, period));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return labels;
  }
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1));
  while (cursor.getTime() <= endDate.getTime()) {
    labels.push(analyticsPeriodLabel(cursor, period));
    cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
  }
  return labels;
}
