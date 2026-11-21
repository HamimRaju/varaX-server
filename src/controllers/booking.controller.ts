import type { RequestHandler } from "express";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import {
  parseAvailabilityInput,
  parseBookingPagination,
  parseBookingStatusFilter,
  parseCancellationReason,
  parseCreateBookingInput,
  parseIdempotencyKey,
  parseOwnerBookingStatusInput,
} from "../utils/booking-validation.js";
import * as bookingService from "../services/booking.service.js";

function getAuthenticatedUser(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return user;
}

export const createBooking: RequestHandler = async (request, response) => {
  const user = getAuthenticatedUser(request.user);
  const input = parseCreateBookingInput(request.body);
  const idempotencyKey = parseIdempotencyKey(
    request.get("Idempotency-Key"),
  );
  const result = await bookingService.createBooking(
    user.id,
    input,
    idempotencyKey,
  );
  response.status(result.replayed ? 200 : 201).json({
    success: true,
    message: result.replayed
      ? "Existing booking returned for this idempotency key."
      : "Booking request created. Payment is required before confirmation.",
    data: bookingService.serializeBooking(result.booking),
  });
};

export const getMyBookings: RequestHandler = async (request, response) => {
  const user = getAuthenticatedUser(request.user);
  const pagination = parseBookingPagination(
    request.query as Record<string, unknown>,
  );
  const result = await bookingService.listCustomerBookings(user.id, pagination);
  response.status(200).json({
    success: true,
    data: result.bookings,
    pagination: result.pagination,
  });
};

export const getBookingDetails: RequestHandler = async (request, response) => {
  const user = getAuthenticatedUser(request.user);
  const booking = await bookingService.getBookingDetails(
    request.params.id,
    user,
  );
  response.status(200).json({ success: true, data: booking });
};

export const cancelBooking: RequestHandler = async (request, response) => {
  const user = getAuthenticatedUser(request.user);
  const reason = parseCancellationReason(request.body);
  const booking = await bookingService.cancelCustomerBooking(
    request.params.id,
    user.id,
    reason,
  );
  response.status(200).json({
    success: true,
    message:
      "Booking cancelled. Any completed payment remains unchanged until the payment refund workflow processes it.",
    data: booking,
  });
};

export const getOwnerBookingRequests: RequestHandler = async (
  request,
  response,
) => {
  const user = getAuthenticatedUser(request.user);
  const query = request.query as Record<string, unknown>;
  const pagination = parseBookingPagination(query);
  const status = parseBookingStatusFilter(query.status);
  const result = await bookingService.listOwnerBookingRequests(
    user.id,
    pagination,
    status,
  );
  response.status(200).json({
    success: true,
    data: result.bookings,
    pagination: result.pagination,
  });
};

export const updateBookingStatus: RequestHandler = async (
  request,
  response,
) => {
  const user = getAuthenticatedUser(request.user);
  const input = parseOwnerBookingStatusInput(request.body);
  const booking = await bookingService.updateOwnerBookingStatus(
    request.params.id,
    user.id,
    input,
  );
  response.status(200).json({
    success: true,
    message: `Booking status changed to ${input.status}.`,
    data: booking,
  });
};

export const getEquipmentAvailability: RequestHandler = async (
  request,
  response,
) => {
  const input = parseAvailabilityInput(
    request.query as Record<string, unknown>,
  );
  const availability = await bookingService.getEquipmentAvailability(
    request.params.id,
    input,
  );
  response.status(200).json({ success: true, data: availability });
};
