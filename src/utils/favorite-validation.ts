import { z } from "zod";
import { HttpError } from "./http-error.js";
import { parseEquipmentId } from "./equipment-validation.js";

const positiveIntegerQuery = z
  .string()
  .trim()
  .regex(/^\d+$/, "Must be a whole number.")
  .transform(Number)
  .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));

const favoritePaginationSchema = z
  .object({
    page: positiveIntegerQuery.optional().transform((value) => value ?? 1),
    limit: positiveIntegerQuery
      .pipe(z.number().max(50, "Limit cannot exceed 50."))
      .optional()
      .transform((value) => value ?? 9),
  })
  .strict();

export interface FavoritePaginationQuery {
  page: number;
  limit: number;
}

export function parseFavoriteEquipmentId(value: unknown): string {
  return parseEquipmentId(value);
}

export function parseFavoritePagination(
  value: unknown,
): FavoritePaginationQuery {
  const result = favoritePaginationSchema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    throw new HttpError(400, message);
  }
  return result.data;
}
