import { Types } from "mongoose";
import { Equipment } from "../models/Equipment.js";
import { Favorite } from "../models/Favorite.js";
import { HttpError } from "../utils/http-error.js";
import {
  parseFavoriteEquipmentId,
  type FavoritePaginationQuery,
} from "../utils/favorite-validation.js";

interface FavoriteEquipmentSummary {
  _id: Types.ObjectId;
  name: string;
  image: string;
  category: string;
  location: string;
  price: number;
  rentalType: string;
  availableQuantity: number;
  available: boolean;
}

interface FavoritePageItem {
  _id: Types.ObjectId;
  createdAt: Date;
  equipmentId: FavoriteEquipmentSummary;
}

interface FavoritePageAggregate {
  items: FavoritePageItem[];
  metadata: { totalItems: number }[];
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

export async function addFavorite(
  userId: Types.ObjectId,
  rawEquipmentId: unknown,
) {
  const equipmentId = new Types.ObjectId(
    parseFavoriteEquipmentId(rawEquipmentId),
  );

  const equipment = await Equipment.findOne({
    _id: equipmentId,
    status: "approved",
    isDeleted: false,
  })
    .select("_id")
    .lean()
    .exec();

  if (!equipment) {
    throw new HttpError(404, "Approved equipment not found.");
  }

  const existing = await Favorite.findOne({
    equipmentId,
    $or: [{ userId }, { customerId: userId }],
  })
    .select("_id")
    .lean()
    .exec();

  if (existing) {
    throw new HttpError(409, "Equipment is already in your favorites.");
  }

  try {
    // customerId is written during the compatibility period for existing favorites.
    return await Favorite.create({ userId, customerId: userId, equipmentId });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new HttpError(409, "Equipment is already in your favorites.");
    }
    throw error;
  }
}

export async function listCustomerFavorites(
  userId: Types.ObjectId,
  pagination: FavoritePaginationQuery,
) {
  const offset = (pagination.page - 1) * pagination.limit;
  const [result] = await Favorite.aggregate<FavoritePageAggregate>([
    {
      $match: {
        $or: [{ userId }, { customerId: userId }],
      },
    },
    {
      $lookup: {
        from: "equipment",
        localField: "equipmentId",
        foreignField: "_id",
        as: "equipment",
      },
    },
    { $unwind: "$equipment" },
    {
      $match: {
        "equipment.status": "approved",
        "equipment.isDeleted": false,
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        items: [
          { $skip: offset },
          { $limit: pagination.limit },
          {
            $project: {
              _id: 1,
              createdAt: 1,
              equipmentId: {
                _id: "$equipment._id",
                name: "$equipment.name",
                image: "$equipment.image",
                category: "$equipment.category",
                location: "$equipment.location",
                price: "$equipment.price",
                rentalType: "$equipment.rentalType",
                availableQuantity: "$equipment.availableQuantity",
                available: { $gt: ["$equipment.availableQuantity", 0] },
              },
            },
          },
        ],
        metadata: [{ $count: "totalItems" }],
      },
    },
  ]).exec();

  const items = result?.items ?? [];
  const totalItems = result?.metadata[0]?.totalItems ?? 0;
  const totalPages = Math.ceil(totalItems / pagination.limit);

  return {
    items,
    pagination: {
      currentPage: pagination.page,
      totalPages,
      totalItems,
      limit: pagination.limit,
      hasNextPage: pagination.page < totalPages,
      hasPrevPage: pagination.page > 1,
    },
  };
}

export async function removeFavorite(
  userId: Types.ObjectId,
  rawEquipmentId: unknown,
) {
  const equipmentId = new Types.ObjectId(
    parseFavoriteEquipmentId(rawEquipmentId),
  );
  const favorite = await Favorite.findOneAndDelete({
    equipmentId,
    $or: [{ userId }, { customerId: userId }],
  })
    .select("_id equipmentId createdAt")
    .lean()
    .exec();

  if (!favorite) {
    throw new HttpError(404, "Favorite not found.");
  }

  return favorite;
}
