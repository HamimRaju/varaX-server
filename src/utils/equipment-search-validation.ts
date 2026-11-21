import { z } from "zod";
import type { EquipmentCategory, RentalType } from "../models/types.js";
import { HttpError } from "./http-error.js";
import {
  equipmentCategorySchema,
  equipmentRentalTypeSchema,
} from "./equipment-validation.js";

const nonNegativePriceQuery = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().finite().min(0));

const positiveIntegerQuery = z
  .string()
  .trim()
  .regex(/^\d+$/, "Must be a whole number.")
  .transform(Number)
  .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));

const equipmentSearchQuerySchema = z
  .object({
    search: z
      .string()
      .trim()
      .max(120, "Search text cannot exceed 120 characters.")
      .optional(),
    category: equipmentCategorySchema.optional(),
    location: z
      .string()
      .trim()
      .max(160, "Location cannot exceed 160 characters.")
      .optional(),
    rentalType: equipmentRentalTypeSchema.optional(),
    minPrice: nonNegativePriceQuery.optional(),
    maxPrice: nonNegativePriceQuery.optional(),
    availability: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    sort: z
      .enum(["price_asc", "price_desc", "newest", "oldest"])
      .optional()
      .transform((value) => value ?? "newest"),
    page: positiveIntegerQuery.optional().transform((value) => value ?? 1),
    limit: positiveIntegerQuery
      .pipe(z.number().max(50, "Limit cannot exceed 50."))
      .optional()
      .transform((value) => value ?? 9),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxPrice"],
        message: "maxPrice must be greater than or equal to minPrice.",
      });
    }
  });

export type EquipmentSort =
  | "price_asc"
  | "price_desc"
  | "newest"
  | "oldest";

export interface EquipmentSearchQuery {
  search?: string | undefined;
  category?: EquipmentCategory | undefined;
  location?: string | undefined;
  rentalType?: RentalType | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  availability?: boolean | undefined;
  sort: EquipmentSort;
  page: number;
  limit: number;
}

export function parseEquipmentSearchQuery(
  value: unknown,
): EquipmentSearchQuery {
  const result = equipmentSearchQuerySchema.safeParse(value);
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

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
