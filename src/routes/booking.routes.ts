import { Router } from "express";
import {
  verifyOwner,
  verifyRenter,
  verifyToken,
} from "../middleware/auth.middleware.js";
import {
  cancelBooking,
  createBooking,
  getBookingDetails,
  getMyBookings,
  getOwnerBookingRequests,
  updateBookingStatus,
} from "../controllers/booking.controller.js";

const bookingRouter = Router();

bookingRouter.get(
  "/owner/requests",
  verifyToken,
  verifyOwner,
  getOwnerBookingRequests,
);
bookingRouter.post("/", verifyToken, verifyRenter, createBooking);
bookingRouter.get("/my-bookings", verifyToken, verifyRenter, getMyBookings);
bookingRouter.get("/:id", verifyToken, getBookingDetails);
bookingRouter.patch("/:id/cancel", verifyToken, verifyRenter, cancelBooking);
bookingRouter.patch(
  "/:id/status",
  verifyToken,
  verifyOwner,
  updateBookingStatus,
);

export default bookingRouter;
