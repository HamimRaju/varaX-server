import mongoose, { Schema, Types, type Model } from "mongoose";

export interface FavoriteFields {
  customerId: Types.ObjectId;
  equipmentId: Types.ObjectId;
  createdAt?: Date;
}

const favoriteSchema = new Schema<FavoriteFields>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    equipmentId: {
      type: Schema.Types.ObjectId,
      ref: "Equipment",
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "favorites",
  },
);

favoriteSchema.index(
  { customerId: 1, equipmentId: 1 },
  { unique: true, name: "favorites_customer_equipment_unique" },
);

export const Favorite =
  (mongoose.models.Favorite as Model<FavoriteFields> | undefined) ??
  mongoose.model<FavoriteFields>("Favorite", favoriteSchema, "favorites");
