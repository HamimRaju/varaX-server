import { Types } from "mongoose";
import {
  Equipment,
  type EquipmentFields,
} from "../models/Equipment.js";
import { User } from "../models/User.js";
import type { EquipmentStatus } from "../models/types.js";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import { parseEquipmentId } from "../utils/equipment-validation.js";
import type {
  CreateEquipmentInput,
  UpdateEquipmentInput,
} from "../utils/equipment-validation.js";
import type { AdminEquipmentQuery } from "../utils/admin-validation.js";
import {
  escapeRegex,
  type EquipmentSearchQuery,
  type EquipmentSort,
} from "../utils/equipment-search-validation.js";

export const PUBLIC_EQUIPMENT_PROJECTION =
  "_id name category location price rentalType availableQuantity image createdAt";

type EquipmentFilter = ReturnType<
  ReturnType<typeof Equipment.find>["getFilter"]
>;

const equipmentSortOrders: Record<EquipmentSort, Record<string, 1 | -1>> = {
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: -1 },
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
};

export function buildPublicEquipmentFilter(
  query: EquipmentSearchQuery,
): EquipmentFilter {
  const filter: EquipmentFilter = {
    status: "approved",
    isDeleted: false,
  };

  if (query.search) {
    const regex = escapeRegex(query.search);
    filter.$or = ["name", "description", "brand", "model", "location"].map(
      (field) => ({
        [field]: { $regex: regex, $options: "i" },
      }),
    );
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.location) {
    filter.location = {
      $regex: escapeRegex(query.location),
      $options: "i",
    };
  }

  if (query.rentalType) {
    filter.rentalType = query.rentalType;
  }

  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = {
      ...(query.minPrice === undefined ? {} : { $gte: query.minPrice }),
      ...(query.maxPrice === undefined ? {} : { $lte: query.maxPrice }),
    };
  }

  if (query.availability !== undefined) {
    filter.availableQuantity = query.availability ? { $gt: 0 } : 0;
  }

  return filter;
}

export interface EquipmentPagination {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export async function searchPublicEquipment(query: EquipmentSearchQuery) {
  const filter = buildPublicEquipmentFilter(query);
  const skip = (query.page - 1) * query.limit;

  const [equipment, totalItems] = await Promise.all([
    Equipment.find(filter)
      .select(PUBLIC_EQUIPMENT_PROJECTION)
      .sort(equipmentSortOrders[query.sort])
      .skip(skip)
      .limit(query.limit)
      .lean()
      .exec(),
    Equipment.countDocuments(filter).exec(),
  ]);

  const totalPages = Math.ceil(totalItems / query.limit);
  const pagination: EquipmentPagination = {
    currentPage: query.page,
    totalPages,
    totalItems,
    limit: query.limit,
    hasNextPage: query.page < totalPages,
    hasPrevPage: query.page > 1,
  };

  return { equipment, pagination };
}

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

export async function listOwnerEquipment(ownerId: Types.ObjectId) {
  return Equipment.find({ ownerId }).lean().exec();
}

export async function listAllEquipment(query: AdminEquipmentQuery) {
  const filter: Record<string, unknown> = {
    isDeleted: { $ne: true },
    ...(query.status ? { status: query.status } : {}),
    ...(query.category ? { category: query.category } : {}),
  };
  if (query.search) {
    const regex = escapeRegex(query.search);
    filter.$or = ["name", "brand", "model", "location"].map((field) => ({
      [field]: { $regex: regex, $options: "i" },
    }));
  }

  const direction: 1 | -1 =
    query.sort === "oldest" || query.sort === "price_asc" ? 1 : -1;
  const sort =
    query.sort === "price_asc" || query.sort === "price_desc"
      ? { price: direction, _id: direction }
      : { createdAt: direction, _id: direction };
  const offset = (query.page - 1) * query.limit;
  const [equipment, totalItems] = await Promise.all([
    Equipment.find(filter)
      .select(
        "_id name description category location price rentalType availableQuantity condition brand model image terms ownerId status isDeleted createdAt updatedAt",
      )
      .populate({
        path: "ownerId",
        select: "_id name email image role isActive",
      })
      .sort(sort)
      .skip(offset)
      .limit(query.limit)
      .lean()
      .exec(),
    Equipment.countDocuments(filter).exec(),
  ]);
  const totalPages = Math.ceil(totalItems / query.limit);
  return {
    equipment,
    pagination: {
      currentPage: query.page,
      totalPages,
      totalItems,
      limit: query.limit,
      hasNextPage: query.page < totalPages,
      hasPrevPage: query.page > 1,
    },
  };
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
  if (
    viewer?.role !== "admin" &&
    !isOwner &&
    !(equipment.status === "approved" && equipment.isDeleted === false)
  ) {
    notFound();
  }

  // Expose the public owner display name without replacing the owner ObjectId.
  const owner = await User.findById(equipment.ownerId)
    .select("name image")
    .lean()
    .exec();
  return {
    ...equipment,
    ownerName: owner?.name ?? "VaraX verified owner",
    ownerImage: owner?.image ?? null,
  };
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
