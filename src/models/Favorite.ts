import mongoose, { Schema, Types, type Model } from "mongoose";

export interface FavoriteFields {
  userId: Types.ObjectId;
  /** Legacy Step 02 field retained so existing favorites remain readable. */
  customerId?: Types.ObjectId;
  equipmentId: Types.ObjectId;
  createdAt?: Date;
}

const favoriteSchema = new Schema<FavoriteFields>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Keep the old persisted field during the transition; new API writes both IDs.
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
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
  { userId: 1, equipmentId: 1 },
  {
    unique: true,
    // Exclude legacy records that only have customerId from this index.
    partialFilterExpression: { userId: { $type: "objectId" } },
    name: "favorites_user_equipment_unique",
  },
);
favoriteSchema.index(
  { customerId: 1, equipmentId: 1 },
  { unique: true, name: "favorites_customer_equipment_unique" },
);

export const Favorite =
  (mongoose.models.Favorite as Model<FavoriteFields> | undefined) ??
  mongoose.model<FavoriteFields>("Favorite", favoriteSchema, "favorites");
