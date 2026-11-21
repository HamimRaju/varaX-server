import mongoose, { Schema, Types, type Model } from "mongoose";

export interface ReviewFields {
  customerId: Types.ObjectId;
  equipmentId: Types.ObjectId;
  bookingId: Types.ObjectId;
  rating: number;
  comment: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const reviewSchema = new Schema<ReviewFields>(
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
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: [1, "Rating must be at least 1."],
      max: [5, "Rating cannot be greater than 5."],
      validate: {
        validator: Number.isInteger,
        message: "Rating must be a whole number.",
      },
    },
    comment: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, "Comment is required."],
    },
  },
  { timestamps: true, collection: "reviews" },
);

reviewSchema.index({ equipmentId: 1 });
reviewSchema.index({ customerId: 1 });
reviewSchema.index(
  { bookingId: 1 },
  { unique: true, name: "reviews_booking_unique" },
);

export const Review =
  (mongoose.models.Review as Model<ReviewFields> | undefined) ??
  mongoose.model<ReviewFields>("Review", reviewSchema, "reviews");
