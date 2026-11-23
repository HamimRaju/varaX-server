import { z } from "zod";
import {
  EQUIPMENT_CATEGORIES,
  RENTAL_TYPES,
  type EquipmentCategory,
} from "../models/types.js";
import { HttpError } from "./http-error.js";

const frontendCategoryAliases: Record<string, EquipmentCategory> = {
  construction: "Construction Equipment",
  photography: "Photography Equipment",
  vehicles: "Vehicles & Transportation",
  agriculture: "Agriculture Equipment",
  electronics: "Electronics",
  event: "Event Equipment",
};

export const equipmentCategorySchema = z
  .string()
  .trim()
  .transform(
    (category) =>
      frontendCategoryAliases[category.toLowerCase()] ?? category,
  )
  .pipe(z.enum(EQUIPMENT_CATEGORIES));

export const equipmentRentalTypeSchema = z
  .string()
  .trim()
  .transform((rentalType) => rentalType.toLowerCase())
  .pipe(z.enum(RENTAL_TYPES));

const hostedImageUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url("Image must be a valid hosted URL.")
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  }, "Image URL must use HTTP or HTTPS and cannot contain credentials.");

const positiveNumberInput = z
  .union([
    z.number().finite(),
    z
      .string()
      .trim()
      .regex(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/)
      .transform(Number),
  ])
  .pipe(z.number().finite().positive());

const positiveIntegerInput = z
  .union([
    z.number().int(),
    z.string().trim().regex(/^\d+$/).transform(Number),
  ])
  .pipe(z.number().int().min(1));

const nonNegativeIntegerInput = z
  .union([
    z.number().int(),
    z.string().trim().regex(/^\d+$/).transform(Number),
  ])
  .pipe(z.number().int().min(0));

const equipmentFieldsSchema = z.object({
  name: z.string().trim().min(1).max(90),
  description: z.string().trim().min(1).max(1_000),
  category: equipmentCategorySchema,
  location: z.string().trim().min(1).max(160),
  price: positiveNumberInput,
  rentalType: equipmentRentalTypeSchema,
  availableQuantity: positiveIntegerInput,
  condition: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(100).optional(),
  model: z.string().trim().max(100).optional(),
  image: hostedImageUrlSchema,
  terms: z.string().trim().max(2_000).optional(),
});

const createEquipmentSchema = equipmentFieldsSchema.strict();
const updateEquipmentSchema = equipmentFieldsSchema
  .partial()
  .extend({ availableQuantity: nonNegativeIntegerInput.optional() })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "Provide at least one equipment field to update.",
  });

export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectProtectedFields(
  value: unknown,
  fields: readonly string[],
): void {
  if (!isRecord(value)) return;

  if (fields.some((field) => Object.hasOwn(value, field))) {
    throw new HttpError(
      403,
      "Owner, approval status, and deletion fields cannot be set in this request.",
    );
  }
}

function normalizeFrontendFields(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = { ...value };

  if (
    normalized.availableQuantity === undefined &&
    normalized.quantity !== undefined
  ) {
    normalized.availableQuantity = normalized.quantity;
  }
  delete normalized.quantity;

  // The existing preview form sends a display-only categoryLabel.
  delete normalized.categoryLabel;

  if (normalized.rentalType === undefined && Array.isArray(normalized.rentals)) {
    if (normalized.rentals.length !== 1) {
      throw new HttpError(
        400,
        "Provide exactly one rentalType; equipment records store one rental period.",
      );
    }
    normalized.rentalType = normalized.rentals[0];
  }
  delete normalized.rentals;

  return normalized;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export function parseCreateEquipmentInput(
  value: unknown,
): CreateEquipmentInput {
  rejectProtectedFields(value, ["ownerId", "status", "isDeleted"]);
  const result = createEquipmentSchema.safeParse(
    normalizeFrontendFields(value),
  );
  if (!result.success) {
    throw new HttpError(400, validationMessage(result.error));
  }
  return result.data;
}

export function parseUpdateEquipmentInput(
  value: unknown,
): UpdateEquipmentInput {
  rejectProtectedFields(value, ["ownerId", "status", "isDeleted"]);
  const result = updateEquipmentSchema.safeParse(
    normalizeFrontendFields(value),
  );
  if (!result.success) {
    throw new HttpError(400, validationMessage(result.error));
  }
  return result.data;
}

export function parseAdminUpdateEquipmentInput(
  value: unknown,
): UpdateEquipmentInput {
  rejectProtectedFields(value, ["ownerId", "status", "isDeleted"]);
  return parseUpdateEquipmentInput(value);
}

export function parseEquipmentStatus(value: unknown) {
  const statusSchema = z
    .object({ status: z.enum(["pending", "approved", "rejected"]) })
    .strict();
  const result = statusSchema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, validationMessage(result.error));
  }
  return result.data.status;
}

export function parseEquipmentId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw new HttpError(400, "Invalid equipment ID.");
  }
  return id;
}
