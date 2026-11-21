import { Types } from "mongoose";
import {
  Equipment,
  type EquipmentFields,
} from "../models/Equipment.js";
import type { EquipmentStatus } from "../models/types.js";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import { parseEquipmentId } from "../utils/equipment-validation.js";
import type {
  CreateEquipmentInput,
  UpdateEquipmentInput,
} from "../utils/equipment-validation.js";

const reviewRequiredFields = [
  "name",
  "description",
  "category",
  "price",
  "rentalType",
  "availableQuantity",
  "image",
  "terms",
] as const satisfies readonly (keyof UpdateEquipmentInput)[];

function hasReviewRequiredChange(
  current: EquipmentFields,
  updates: UpdateEquipmentInput,
): boolean {
  return reviewRequiredFields.some(
    (field) =>
      Object.hasOwn(updates, field) &&
      current[field] !== updates[field],
  );
}

function notFound(): never {
  throw new HttpError(404, "Equipment not found.");
}

function validateId(id: unknown): Types.ObjectId {
  const validId = parseEquipmentId(id);
  return new Types.ObjectId(validId);
}

export async function listPublicEquipment() {
  return Equipment.find({ status: "approved", isDeleted: false })
    .lean()
    .exec();
}

export async function listOwnerEquipment(ownerId: Types.ObjectId) {
  return Equipment.find({ ownerId }).lean().exec();
}

export async function listAllEquipment() {
  return Equipment.find({}).lean().exec();
}

export async function getEquipmentDetails(
  rawId: unknown,
  viewer?: AuthenticatedUser,
) {
  const equipment = await Equipment.findById(validateId(rawId)).lean().exec();
  if (!equipment) notFound();

  const isOwner =
    viewer?.role === "owner" &&
    equipment.ownerId.toString() === viewer.id.toString();
  if (viewer?.role === "admin" || isOwner) {
    return equipment;
  }

  if (equipment.status === "approved" && equipment.isDeleted === false) {
    return equipment;
  }

  notFound();
}

export async function createEquipment(
  ownerId: Types.ObjectId,
  fields: CreateEquipmentInput,
) {
  const equipmentData = {
    name: fields.name,
    description: fields.description,
    category: fields.category,
    location: fields.location,
    price: fields.price,
    rentalType: fields.rentalType,
    availableQuantity: fields.availableQuantity,
    image: fields.image,
    ownerId,
    status: "pending",
    isDeleted: false,
    ...(fields.condition === undefined ? {} : { condition: fields.condition }),
    ...(fields.brand === undefined ? {} : { brand: fields.brand }),
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.terms === undefined ? {} : { terms: fields.terms }),
  } satisfies EquipmentFields;

  return Equipment.create(equipmentData);
}

export async function updateOwnerEquipment(
  rawId: unknown,
  ownerId: Types.ObjectId,
  updates: UpdateEquipmentInput,
) {
  const equipment = await Equipment.findById(validateId(rawId)).exec();
  if (!equipment || equipment.isDeleted) notFound();

  if (equipment.ownerId.toString() !== ownerId.toString()) {
    throw new HttpError(403, "You can only update your own equipment.");
  }

  const needsReview =
    equipment.status === "approved" &&
    hasReviewRequiredChange(equipment, updates);

  equipment.set(updates);
  if (needsReview) {
    equipment.status = "pending";
  }
  await equipment.save();
  return equipment;
}

export async function softDeleteOwnerEquipment(
  rawId: unknown,
  ownerId: Types.ObjectId,
) {
  const equipment = await Equipment.findById(validateId(rawId)).exec();
  if (!equipment || equipment.isDeleted) notFound();

  if (equipment.ownerId.toString() !== ownerId.toString()) {
    throw new HttpError(403, "You can only delete your own equipment.");
  }

  equipment.isDeleted = true;
  await equipment.save();
  return equipment;
}

export async function updateAdminEquipment(
  rawId: unknown,
  updates: UpdateEquipmentInput,
) {
  const equipment = await Equipment.findById(validateId(rawId)).exec();
  if (!equipment || equipment.isDeleted) notFound();

  const needsReview =
    equipment.status === "approved" &&
    hasReviewRequiredChange(equipment, updates);

  equipment.set(updates);
  if (needsReview) {
    equipment.status = "pending";
  }
  await equipment.save();
  return equipment;
}

export async function setEquipmentStatus(
  rawId: unknown,
  status: EquipmentStatus,
) {
  const equipment = await Equipment.findById(validateId(rawId)).exec();
  if (!equipment || equipment.isDeleted) notFound();

  equipment.status = status;
  await equipment.save();
  return equipment;
}

export async function softDeleteAdminEquipment(rawId: unknown) {
  const equipment = await Equipment.findById(validateId(rawId)).exec();
  if (!equipment || equipment.isDeleted) notFound();

  equipment.isDeleted = true;
  await equipment.save();
  return equipment;
}
