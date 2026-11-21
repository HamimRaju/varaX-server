import mongoose, { Schema, Types, type Model } from "mongoose";
import { USER_ROLES, type UserRole } from "./types.js";

export interface UserFields {
  name: string;
  email: string;
  emailVerified?: boolean;
  image?: string;
  role?: UserRole;
  phone?: string;
  address?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const userSchema = new Schema<UserFields>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // Better Auth's core user record includes emailVerified.
    emailVerified: { type: Boolean, default: false },
    image: { type: String, trim: true },
    role: {
      type: String,
      enum: USER_ROLES,
      default: "customer",
    },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "users" },
);

userSchema.index({ email: 1 }, { unique: true, name: "users_email_uidx" });

// Configure Better Auth with user.modelName: "users" to share this collection,
// and keep its user IDs as MongoDB ObjectIds for the other models' ObjectId refs.
// Its role additional field should use input: false so users cannot self-assign roles.
export const User =
  (mongoose.models.User as Model<UserFields> | undefined) ??
  mongoose.model<UserFields>("User", userSchema, "users");

export type UserId = Types.ObjectId;
