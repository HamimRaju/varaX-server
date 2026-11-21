import { createHash } from "node:crypto";
import mongoose, { Types, type ClientSession } from "mongoose";
import { Booking } from "../models/Booking.js";
import { Equipment } from "../models/Equipment.js";
import type {
  BookingStatus,
  RentalType,
} from "../models/types.js";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import type {
  AvailabilityInput,
  BookingPagination,
  CreateBookingInput,
  OwnerBookingStatusInput,
} from "../utils/booking-validation.js";
import {
  parseBookingEquipmentId,
  isRentalType,
  parseBookingId,
  validateBookingStartDate,
} from "../utils/booking-validation.js";

const RESERVING_STATUSES: readonly BookingStatus[] = ["confirmed", "active"];
const POPULATED_EQUIPMENT_FIELDS =
  "_id name image category location rentalType price availableQuantity";

type DateRange = Pick<AvailabilityInput, "startDate" | "endDate">;

function notFound(): never {
  throw new HttpError(404, "Booking or equipment not found.");
}

function transactionRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    codeName?: unknown;
    message?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message : "";
  return (
    candidate.code === 20 ||
    candidate.code === 303 ||
    candidate.codeName === "IllegalOperation" ||
    /Transaction numbers are only allowed on a replica set member or mongos|transactions are not supported|does not support transactions/i.test(
      message,
    )
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function normalizeTransactionError(error: unknown): never {
  if (transactionRequired(error)) {
    throw new HttpError(
      503,
      "Booking inventory requires MongoDB transactions. Configure MongoDB as a replica set or sharded cluster and retry.",
    );
  }
  throw error;
}

function isFinitePositivePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function addCalendarMonths(start: Date, amount: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + amount;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = start.getUTCDate();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(day, lastDay),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

/**
 * Rental dates are UTC date-only values with an exclusive end date.
 * Weekly periods are seven days; monthly periods follow calendar-month
 * anniversaries (clamped to the final day of shorter months), rounded up.
 */
export function calculateRentalDuration(
  startDate: Date,
  endDate: Date,
  rentalType: RentalType,
): number {
  const dayCount =
    (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    throw new HttpError(400, "endDate must be after startDate.");
  }
  if (rentalType === "daily") return dayCount;
  if (rentalType === "weekly") return Math.ceil(dayCount / 7);

  let months = Math.max(
    1,
    (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      endDate.getUTCMonth() -
      startDate.getUTCMonth(),
  );
  if (addCalendarMonths(startDate, months).getTime() < endDate.getTime()) {
    months += 1;
  }
  return months;
}

export function calculateRentalPrice(input: {
  startDate: Date;
  endDate: Date;
  quantity: number;
  rentalType: RentalType;
  pricePerUnit: number;
}) {
  const rentalDuration = calculateRentalDuration(
    input.startDate,
    input.endDate,
    input.rentalType,
  );
  const subtotal = Number(
    (input.pricePerUnit * rentalDuration * input.quantity).toFixed(2),
  );
  return { rentalDuration, subtotal, totalAmount: subtotal };
}

function fingerprintBookingInput(input: CreateBookingInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        equipmentId: input.equipmentId.toString(),
        startDate: input.startDate.toISOString(),
        endDate: input.endDate.toISOString(),
        quantity: input.quantity,
        contactNumber: input.contactNumber,
        deliveryAddress: input.deliveryAddress,
        notes: input.notes ?? "",
      }),
    )
    .digest("hex");
}

function idempotencyConflict(): never {
  throw new HttpError(
    409,
    "This Idempotency-Key was already used with a different booking request.",
  );
}

async function findIdempotentBooking(
  customerId: Types.ObjectId,
  key: string,
  fingerprint: string,
) {
  const booking = await Booking.findOne({
    customerId,
    idempotencyKey: key,
  })
    .select("+requestFingerprint")
    .exec();
  if (!booking) return undefined;
  if (booking.requestFingerprint !== fingerprint) idempotencyConflict();
  return booking;
}

async function getReservedQuantity(
  equipmentId: Types.ObjectId,
  range: DateRange,
  session?: ClientSession,
  excludeBookingId?: Types.ObjectId,
): Promise<number> {
  const match: Record<string, unknown> = {
    equipmentId,
    bookingStatus: { $in: RESERVING_STATUSES },
    startDate: { $lt: range.endDate },
    endDate: { $gt: range.startDate },
  };
  if (excludeBookingId) match._id = { $ne: excludeBookingId };

  const aggregate = Booking.aggregate([
    { $match: match },
    { $group: { _id: null, reservedQuantity: { $sum: "$quantity" } } },
  ]);
  if (session) aggregate.session(session);
  const [result] = await aggregate.exec();
  return result?.reservedQuantity ?? 0;
}

async function lockEquipmentInventory(
  equipmentId: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  // This shared write is intentional: two snapshot transactions that both read
  // the same availability must conflict before either can commit a reservation.
  const result = await Equipment.updateOne(
    { _id: equipmentId },
    { $inc: { reservationVersion: 1 } },
  )
    .session(session)
    .exec();
  if (result.matchedCount === 0) notFound();
}

async function fetchBookableEquipment(
  equipmentId: Types.ObjectId,
  session: ClientSession,
) {
  const equipment = await Equipment.findOne({
    _id: equipmentId,
    status: "approved",
    isDeleted: false,
  })
    .session(session)
    .lean()
    .exec();
  if (!equipment) {
    throw new HttpError(404, "Approved equipment not found.");
  }
  return equipment;
}

function validateEquipmentPricing(equipment: {
  price?: unknown;
  rentalType?: unknown;
}): asserts equipment is { price: number; rentalType: RentalType } {
  if (!isFinitePositivePrice(equipment.price) || !isRentalType(equipment.rentalType)) {
    throw new HttpError(409, "Equipment has invalid rental pricing.");
  }
}

function toBookingDto(booking: any) {
  const value =
    typeof booking?.toObject === "function"
      ? booking.toObject({ virtuals: false })
      : { ...booking };
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...safeBooking
  } = value;
  return {
    ...safeBooking,
    pricePerUnit: safeBooking.unitPrice ?? safeBooking.pricePerUnit,
    rentalDuration: safeBooking.rentalDuration,
    subtotal: safeBooking.subtotal ?? safeBooking.totalAmount,
    status: safeBooking.bookingStatus ?? safeBooking.status,
    notes: safeBooking.additionalNotes ?? safeBooking.notes,
  };
}

export function serializeBooking(booking: unknown) {
  return toBookingDto(booking);
}

function makePagination(page: number, limit: number, totalItems: number) {
  const totalPages = Math.ceil(totalItems / limit);
  return {
    currentPage: page,
    totalPages,
    totalItems,
    limit,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

function assertStartIsNotPast(startDate: Date): void {
  validateBookingStartDate(startDate);
}

export async function createBooking(
  customerId: Types.ObjectId,
  input: CreateBookingInput,
  idempotencyKey?: string,
) {
  const fingerprint = fingerprintBookingInput(input);
  if (idempotencyKey) {
    const existing = await findIdempotentBooking(
      customerId,
      idempotencyKey,
      fingerprint,
    );
    if (existing) {
      return { booking: existing, replayed: true };
    }
  }
  assertStartIsNotPast(input.startDate);

  const session = await mongoose.startSession();
  let createdBooking: unknown;
  try {
    await session.withTransaction(async () => {
      const equipment = await fetchBookableEquipment(input.equipmentId, session);
      if (equipment.ownerId.toString() === customerId.toString()) {
        throw new HttpError(403, "You cannot book your own equipment.");
      }
      validateEquipmentPricing(equipment);
      if (
        !Number.isSafeInteger(equipment.availableQuantity) ||
        equipment.availableQuantity < 1
      ) {
        throw new HttpError(409, "Equipment is not currently available.");
      }

      await lockEquipmentInventory(input.equipmentId, session);
      const reservedQuantity = await getReservedQuantity(
        input.equipmentId,
        input,
        session,
      );
      const remainingQuantity = equipment.availableQuantity - reservedQuantity;
      if (input.quantity > remainingQuantity) {
        throw new HttpError(409, "Insufficient availability for the requested dates.");
      }

      const pricing = calculateRentalPrice({
        startDate: input.startDate,
        endDate: input.endDate,
        quantity: input.quantity,
        rentalType: equipment.rentalType,
        pricePerUnit: equipment.price,
      });
      const bookingData = {
        customerId,
        ownerId: equipment.ownerId,
        equipmentId: input.equipmentId,
        startDate: input.startDate,
        endDate: input.endDate,
        quantity: input.quantity,
        contactNumber: input.contactNumber,
        deliveryAddress: input.deliveryAddress,
        ...(input.notes ? { additionalNotes: input.notes } : {}),
        rentalType: equipment.rentalType,
        unitPrice: equipment.price,
        rentalDuration: pricing.rentalDuration,
        subtotal: pricing.subtotal,
        totalAmount: pricing.totalAmount,
        bookingStatus: "pending" as const,
        paymentStatus: "unpaid" as const,
        ...(idempotencyKey
          ? { idempotencyKey, requestFingerprint: fingerprint }
          : {}),
      };
      const [booking] = await Booking.create([bookingData], { session });
      createdBooking = booking;
    });
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await findIdempotentBooking(
        customerId,
        idempotencyKey,
        fingerprint,
      );
      if (existing) return { booking: existing, replayed: true };
    }
    normalizeTransactionError(error);
  } finally {
    await session.endSession();
  }

  return { booking: createdBooking, replayed: false };
}

export async function getEquipmentAvailability(
  rawEquipmentId: unknown,
  input: AvailabilityInput,
) {
  const equipmentId = parseBookingEquipmentId(rawEquipmentId);
  assertStartIsNotPast(input.startDate);
  const equipment = await Equipment.findOne({
    _id: equipmentId,
    status: "approved",
    isDeleted: false,
  })
    .select("_id availableQuantity")
    .lean()
    .exec();
  if (!equipment) {
    throw new HttpError(404, "Approved equipment not found.");
  }

  const reservedQuantity = await getReservedQuantity(equipmentId, input);
  const remainingQuantity = Math.max(
    0,
    equipment.availableQuantity - reservedQuantity,
  );
  return {
    availableQuantity: equipment.availableQuantity,
    reservedQuantity,
    remainingQuantity,
    requestedQuantity: input.quantity,
    isAvailable: input.quantity <= remainingQuantity,
  };
}

export async function listCustomerBookings(
  customerId: Types.ObjectId,
  pagination: BookingPagination,
) {
  const filter = { customerId };
  const skip = (pagination.page - 1) * pagination.limit;
  const [bookings, totalItems] = await Promise.all([
    Booking.find(filter)
      .populate({ path: "equipmentId", select: POPULATED_EQUIPMENT_FIELDS })
      .populate({ path: "ownerId", select: "_id name image" })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(pagination.limit)
      .lean()
      .exec(),
    Booking.countDocuments(filter).exec(),
  ]);
  return {
    bookings: bookings.map(toBookingDto),
    pagination: makePagination(
      pagination.page,
      pagination.limit,
      totalItems,
    ),
  };
}

export async function listOwnerBookingRequests(
  ownerId: Types.ObjectId,
  pagination: BookingPagination,
  status?: BookingStatus,
) {
  const filter = {
    ownerId,
    ...(status ? { bookingStatus: status } : {}),
  };
  const skip = (pagination.page - 1) * pagination.limit;
  const [bookings, totalItems] = await Promise.all([
    Booking.find(filter)
      .populate({ path: "equipmentId", select: POPULATED_EQUIPMENT_FIELDS })
      .populate({ path: "customerId", select: "_id name image" })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(pagination.limit)
      .lean()
      .exec(),
    Booking.countDocuments(filter).exec(),
  ]);
  return {
    bookings: bookings.map(toBookingDto),
    pagination: makePagination(
      pagination.page,
      pagination.limit,
      totalItems,
    ),
  };
}

export async function getBookingDetails(
  rawId: unknown,
  viewer: AuthenticatedUser,
) {
  const bookingId = parseBookingId(rawId);
  const filter =
    viewer.role === "admin"
      ? { _id: bookingId }
      : viewer.role === "owner"
        ? { _id: bookingId, ownerId: viewer.id }
        : { _id: bookingId, customerId: viewer.id };
  const booking = await Booking.findOne(filter)
    .populate({ path: "equipmentId", select: POPULATED_EQUIPMENT_FIELDS })
    .populate({ path: "ownerId", select: "_id name image" })
    .populate({ path: "customerId", select: "_id name image" })
    .lean()
    .exec();
  if (!booking) notFound();
  return toBookingDto(booking);
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function cancelCustomerBooking(
  rawId: unknown,
  customerId: Types.ObjectId,
  reason?: string,
) {
  const bookingId = parseBookingId(rawId);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const booking = await Booking.findOne({
        _id: bookingId,
        customerId,
      })
        .session(session)
        .exec();
      if (!booking) notFound();
      if (booking.bookingStatus === "cancelled") {
        throw new HttpError(409, "Booking is already cancelled.");
      }
      if (booking.bookingStatus === "completed") {
        throw new HttpError(409, "A completed booking cannot be cancelled.");
      }
      if (booking.bookingStatus !== "pending" && booking.bookingStatus !== "confirmed") {
        throw new HttpError(409, "Only pending or not-yet-started bookings can be cancelled.");
      }
      if (
        booking.bookingStatus === "confirmed" &&
        booking.startDate.getTime() <= todayUtc().getTime()
      ) {
        throw new HttpError(409, "A confirmed booking cannot be cancelled after its start date.");
      }
      if (booking.bookingStatus === "confirmed") {
        await lockEquipmentInventory(booking.equipmentId, session);
      }
      const updated = await Booking.updateOne(
        {
          _id: bookingId,
          customerId,
          bookingStatus: booking.bookingStatus,
        },
        {
          $set: {
            bookingStatus: "cancelled",
            ...(reason ? { cancellationReason: reason } : {}),
          },
        },
      )
        .session(session)
        .exec();
      if (updated.matchedCount !== 1) {
        throw new HttpError(409, "Booking changed while it was being cancelled. Retry.");
      }
    });
  } catch (error) {
    normalizeTransactionError(error);
  } finally {
    await session.endSession();
  }
  return getBookingDetails(bookingId, {
    id: customerId,
    role: "customer",
    email: "",
    name: "",
  });
}

export async function updateOwnerBookingStatus(
  rawId: unknown,
  ownerId: Types.ObjectId,
  input: OwnerBookingStatusInput,
) {
  const bookingId = parseBookingId(rawId);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const booking = await Booking.findOne({
        _id: bookingId,
        ownerId,
      })
        .session(session)
        .exec();
      if (!booking) notFound();

      const currentStatus = booking.bookingStatus;
      if (input.status === "rejected") {
        if (currentStatus !== "pending") {
          throw new HttpError(409, "Only pending bookings can be rejected.");
        }
        if (booking.paymentStatus === "paid") {
          throw new HttpError(
            409,
            "A paid booking cannot be rejected until the payment refund workflow is available.",
          );
        }
      } else if (input.status === "confirmed") {
        if (currentStatus !== "pending") {
          throw new HttpError(409, "Only pending bookings can be confirmed.");
        }
        if (booking.paymentStatus !== "paid") {
          throw new HttpError(409, "A booking must be paid before it can be confirmed.");
        }

        const equipment = await Equipment.findById(booking.equipmentId)
          .session(session)
          .lean()
          .exec();
        if (
          !equipment ||
          equipment.isDeleted ||
          equipment.status !== "approved" ||
          !Number.isSafeInteger(equipment.availableQuantity) ||
          equipment.availableQuantity < 1
        ) {
          throw new HttpError(409, "Equipment is no longer available for booking.");
        }
        await lockEquipmentInventory(booking.equipmentId, session);
        const reservedQuantity = await getReservedQuantity(
          booking.equipmentId,
          booking,
          session,
          bookingId,
        );
        if (booking.quantity > equipment.availableQuantity - reservedQuantity) {
          throw new HttpError(
            409,
            "Insufficient availability to confirm this paid booking.",
          );
        }
      } else if (input.status === "active") {
        if (
          currentStatus !== "confirmed" ||
          booking.startDate.getTime() > todayUtc().getTime() ||
          booking.endDate.getTime() <= todayUtc().getTime()
        ) {
          throw new HttpError(
            409,
            "A booking can become active only during its confirmed rental period.",
          );
        }
      } else if (input.status === "completed") {
        if (
          currentStatus !== "active" ||
          booking.endDate.getTime() > todayUtc().getTime()
        ) {
          throw new HttpError(
            409,
            "A booking can be completed only after its active rental period ends.",
          );
        }
        await lockEquipmentInventory(booking.equipmentId, session);
      }

      const updated = await Booking.updateOne(
        {
          _id: bookingId,
          ownerId,
        },
        {
          $set: {
            bookingStatus: input.status,
            ...(input.status === "rejected" && input.reason
              ? { rejectionReason: input.reason }
              : {}),
          },
        },
      )
        .session(session)
        .exec();
      if (updated.matchedCount !== 1) {
        throw new HttpError(409, "Booking changed while its status was being updated. Retry.");
      }
    });
  } catch (error) {
    normalizeTransactionError(error);
  } finally {
    await session.endSession();
  }
  return getBookingDetails(bookingId, {
    id: ownerId,
    role: "owner",
    email: "",
    name: "",
  });
}
