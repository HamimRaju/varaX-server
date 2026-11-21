import mongoose, { Schema, Types, type Model } from "mongoose";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  RENTAL_TYPES,
  type EquipmentCategory,
  type EquipmentStatus,
  type RentalType,
} from "./types.js";

export interface EquipmentFields {
  name: string;
  description: string;
  category: EquipmentCategory;
  location: string;
  price: number;
  rentalType: RentalType;
  availableQuantity: number;
  condition?: string;
  brand?: string;
  model?: string;
  image: string;
  terms?: string;
  ownerId: Types.ObjectId;
  status?: EquipmentStatus;
  isDeleted?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const equipmentSchema = new Schema<EquipmentFields>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: EQUIPMENT_CATEGORIES,
    },
    location: { type: String, required: true, trim: true },
    price: {
      type: Number,
      required: true,
      min: [0.01, "Price must be greater than zero."],
      validate: {
        validator: Number.isFinite,
        message: "Price must be a finite number.",
      },
    },
    rentalType: {
      type: String,
      required: true,
      enum: RENTAL_TYPES,
    },
    availableQuantity: {
      type: Number,
      required: true,
      min: [0, "Available quantity cannot be negative."],
      validate: {
        validator: Number.isInteger,
        message: "Available quantity must be a whole number.",
      },
    },
    condition: { type: String, trim: true },
    brand: { type: String, trim: true },
    model: { type: String, trim: true },
    image: { type: String, required: true, trim: true },
    terms: { type: String, trim: true },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: EQUIPMENT_STATUSES,
      default: "pending",
    },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "equipment" },
);

equipmentSchema.index({ ownerId: 1 });
equipmentSchema.index({ status: 1 });
equipmentSchema.index({ category: 1 });
equipmentSchema.index({ location: 1 });
equipmentSchema.index({ createdAt: -1 });
equipmentSchema.index({ price: 1 });
// Cover the public approved/non-deleted feed and its common sort orders.
equipmentSchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
equipmentSchema.index({ status: 1, isDeleted: 1, price: 1 });

export const Equipment =
  (mongoose.models.Equipment as Model<EquipmentFields> | undefined) ??
  mongoose.model<EquipmentFields>("Equipment", equipmentSchema, "equipment");
