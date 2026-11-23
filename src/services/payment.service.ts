import { randomUUID } from "node:crypto";
import mongoose, { Types, type ClientSession } from "mongoose";
import type Stripe from "stripe";
import { env } from "../config/env.js";
import { STRIPE_CURRENCY, stripe } from "../config/stripe.js";
import { Booking } from "../models/Booking.js";
import { Equipment } from "../models/Equipment.js";
import { Payment, type PaymentFields } from "../models/Payment.js";
import type { AuthenticatedUser } from "../types/authenticated-user.js";
import { HttpError } from "../utils/http-error.js";
import {
  getReservedQuantity,
  lockEquipmentInventory,
} from "./booking.service.js";

const PLACEHOLDER_SESSION_PREFIX = "pending_";

function transactionNotSupported(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    codeName?: unknown;
    message?: unknown;
  };
  const message = typeof value.message === "string" ? value.message : "";
  return (
    value.code === 20 ||
    value.code === 303 ||
    value.codeName === "IllegalOperation" ||
    /Transaction numbers are only allowed on a replica set member or mongos|transactions are not supported|does not support transactions/i.test(
      message,
    )
  );
}

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result!: T;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } catch (error) {
    if (transactionNotSupported(error)) {
      throw new HttpError(
        503,
        "Payments require MongoDB transactions. Configure MongoDB as a replica set or sharded cluster and retry.",
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

function objectIdString(value: unknown): string | undefined {
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === "string" && /^[a-f\d]{24}$/i.test(value)) return value;
  return undefined;
}

function toMinorUnits(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(409, "Booking has an invalid payable amount.");
  }
  const scaledAmount = amount * 100;
  const minorUnits = Math.round(scaledAmount);
  if (
    !Number.isSafeInteger(minorUnits) ||
    minorUnits < 1 ||
    Math.abs(scaledAmount - minorUnits) > 1e-7
  ) {
    throw new HttpError(409, "Booking amount cannot be represented in BDT.");
  }
  return minorUnits;
}

function tryToMinorUnits(amount: unknown): number | undefined {
  try {
    return toMinorUnits(amount);
  } catch {
    return undefined;
  }
}

function clientUrl(path: string, bookingId: Types.ObjectId): string {
  let target: URL;
  try {
    target = new URL(path, env.CLIENT_URL);
  } catch {
    throw new HttpError(503, "CLIENT_URL must be configured before checkout can be used.");
  }
  target.searchParams.set("bookingId", bookingId.toString());
  return target.toString();
}

function getCheckoutUrls(bookingId: Types.ObjectId) {
  const success = clientUrl("/payment-success", bookingId);
  return {
    successUrl: `${success}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: clientUrl("/payment-cancel", bookingId),
  };
}

function stripeErrorSummary(error: unknown) {
  if (!error || typeof error !== "object") {
    return { type: "unknown", code: "unknown" };
  }
  const value = error as {
    type?: unknown;
    code?: unknown;
  };
  return {
    type: typeof value.type === "string" ? value.type : "unknown",
    code: typeof value.code === "string" ? value.code : "unknown",
  };
}

function getPaymentIntentId(
  value: string | Stripe.PaymentIntent | null | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  return value && typeof value.id === "string" ? value.id : undefined;
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

async function findBookingForCustomer(
  bookingId: Types.ObjectId,
  customerId: Types.ObjectId,
  session: ClientSession,
) {
  const booking = await Booking.findOne({
    _id: bookingId,
    customerId,
  })
    .session(session)
    .exec();
  if (!booking) {
    throw new HttpError(404, "Booking not found.");
  }
  return booking;
}

async function createOrReusePaymentAttempt(
  bookingId: Types.ObjectId,
  customer: AuthenticatedUser,
) {
  const attemptId = randomUUID();
  return inTransaction(async (session) => {
    const booking = await findBookingForCustomer(
      bookingId,
      customer.id,
      session,
    );
    if (
      booking.bookingStatus !== "pending" ||
      (booking.paymentStatus !== "unpaid" &&
        booking.paymentStatus !== "failed")
    ) {
      throw new HttpError(
        409,
        "Only unpaid or failed pending bookings can start checkout.",
      );
    }

    const amountMinorUnits = toMinorUnits(booking.totalAmount);
    const write = await Booking.updateOne(
      {
        _id: bookingId,
        customerId: customer.id,
        bookingStatus: "pending",
      },
      { $inc: { checkoutAttemptVersion: 1 } },
    )
      .session(session)
      .exec();
    if (write.matchedCount !== 1) {
      throw new HttpError(409, "Booking changed while checkout was starting.");
    }

    const activePayment = await Payment.findOne({
      activeBookingId: bookingId,
    })
      .session(session)
      .exec();
    if (activePayment) {
      return { payment: activePayment, reused: true };
    }

    const [payment] = await Payment.create(
      [
        {
          bookingId,
          customerId: booking.customerId,
          ownerId: booking.ownerId,
          equipmentId: booking.equipmentId,
          stripeSessionId: `${PLACEHOLDER_SESSION_PREFIX}${attemptId}`,
          checkoutAttemptId: attemptId,
          amount: Number(booking.totalAmount.toFixed(2)),
          amountMinorUnits,
          currency: STRIPE_CURRENCY,
          paymentStatus: "pending",
          fulfillmentStatus: "pending",
          activeBookingId: bookingId,
          stripeEventIds: [],
        },
      ],
      { session },
    );
    if (!payment) {
      throw new HttpError(500, "Payment attempt could not be created.");
    }
    return { payment, reused: false };
  });
}

async function persistCreatedCheckoutSession(
  paymentId: Types.ObjectId,
  bookingId: Types.ObjectId,
  checkoutSession: Stripe.Checkout.Session,
) {
  return inTransaction(async (session) => {
    const payment = await Payment.findOne({ _id: paymentId })
      .session(session)
      .exec();
    if (!payment) {
      throw new HttpError(500, "Checkout payment record could not be found.");
    }
    const booking = await Booking.findOne({ _id: bookingId })
      .session(session)
      .exec();
    if (!booking) {
      if (payment.paymentStatus === "pending") {
        await Payment.updateOne(
          { _id: paymentId, paymentStatus: "pending" },
          {
            $set: {
              paymentStatus: "failed",
              fulfillmentStatus: "pending",
              reconciliationReason: "booking_no_longer_pending",
            },
            $unset: { activeBookingId: 1 },
          },
        )
          .session(session)
          .exec();
      }
      return { eligible: false, payment };
    }

    if (payment.paymentStatus !== "pending") {
      return {
        eligible:
          payment.paymentStatus === "paid" &&
          booking.paymentStatus === "paid",
        payment,
      };
    }
    if (booking.bookingStatus !== "pending") {
      await Payment.updateOne(
        { _id: paymentId, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "failed",
            fulfillmentStatus: "pending",
            reconciliationReason: "booking_no_longer_pending",
          },
          $unset: { activeBookingId: 1 },
        },
      )
        .session(session)
        .exec();
      return { eligible: false, payment };
    }
    if (
      !payment.stripeSessionId.startsWith(PLACEHOLDER_SESSION_PREFIX) &&
      payment.stripeSessionId !== checkoutSession.id
    ) {
      throw new HttpError(409, "A different Stripe Checkout Session is already attached.");
    }

    await Payment.updateOne(
      { _id: paymentId, paymentStatus: "pending" },
      {
        $set: {
          stripeSessionId: checkoutSession.id,
          checkoutUrl: checkoutSession.url ?? undefined,
          ...(checkoutSession.expires_at
            ? {
                checkoutExpiresAt: new Date(
                  checkoutSession.expires_at * 1000,
                ),
              }
            : {}),
        },
      },
    )
      .session(session)
      .exec();
    await Booking.updateOne(
      { _id: bookingId },
      { $set: { stripeSessionId: checkoutSession.id } },
    )
      .session(session)
      .exec();
    return { eligible: true, payment };
  });
}

async function failRejectedCheckoutAttempt(
  paymentId: Types.ObjectId,
  bookingId: Types.ObjectId,
  reason: string,
) {
  await inTransaction(async (session) => {
    const payment = await Payment.findOne({
      _id: paymentId,
      paymentStatus: "pending",
    })
      .session(session)
      .exec();
    if (!payment) return;
    await Payment.updateOne(
      { _id: paymentId, paymentStatus: "pending" },
      {
        $set: {
          paymentStatus: "failed",
          reconciliationReason: reason,
        },
        $unset: { activeBookingId: 1 },
      },
    )
      .session(session)
      .exec();
    await Booking.updateOne(
      {
        _id: bookingId,
        bookingStatus: "pending",
        paymentStatus: { $in: ["unpaid", "failed"] },
      },
      { $set: { paymentStatus: "failed" } },
    )
      .session(session)
      .exec();
  });
}

export async function createCheckoutSession(
  rawBookingId: unknown,
  customer: AuthenticatedUser,
) {
  if (!(rawBookingId instanceof Types.ObjectId)) {
    throw new HttpError(400, "bookingId must be a valid ObjectId.");
  }
  const bookingId = rawBookingId;
  const attempt = await createOrReusePaymentAttempt(
    bookingId,
    customer,
  );
  const payment = attempt.payment;
  const reused = attempt.reused;
  if (!payment) {
    throw new HttpError(500, "Payment attempt could not be loaded.");
  }
  const ownerId = objectIdString(payment.ownerId);
  const equipmentId = objectIdString(payment.equipmentId);
  const checkoutAttemptId = payment.checkoutAttemptId;
  const amountMinorUnits = payment.amountMinorUnits;
  if (
    !ownerId ||
    !equipmentId ||
    !checkoutAttemptId ||
    !Number.isSafeInteger(amountMinorUnits) ||
    !amountMinorUnits
  ) {
    throw new HttpError(409, "Payment attempt is missing required checkout details.");
  }

  if (payment.checkoutUrl) {
    if (
      payment.checkoutExpiresAt &&
      payment.checkoutExpiresAt.getTime() <= Date.now()
    ) {
      throw new HttpError(
        409,
        "The existing Checkout Session expired. Wait for its webhook before retrying.",
      );
    }
    return {
      paymentId: payment._id,
      sessionId: payment.stripeSessionId,
      url: payment.checkoutUrl,
      expiresAt: payment.checkoutExpiresAt,
      reused: true,
    };
  }

  const { successUrl, cancelUrl } = getCheckoutUrls(bookingId);
  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: bookingId.toString(),
        customer_email: customer.email,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          paymentId: payment._id.toString(),
          bookingId: bookingId.toString(),
          customerId: customer.id.toString(),
          ownerId,
          equipmentId,
          checkoutAttemptId,
        },
        payment_intent_data: {
          metadata: {
            paymentId: payment._id.toString(),
            bookingId: bookingId.toString(),
            checkoutAttemptId,
          },
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: STRIPE_CURRENCY,
              unit_amount: amountMinorUnits,
              product_data: {
                name: `VaraX rental booking ${bookingId.toString()}`,
                description: "Equipment rental payment",
              },
            },
          },
        ],
      },
      { idempotencyKey: `varax-checkout-${checkoutAttemptId}` },
    );
  } catch (error) {
    const summary = stripeErrorSummary(error);
    console.error("Stripe Checkout session creation failed.", summary);
    const errorType = summary.type;
    if (
      errorType === "StripeInvalidRequestError" ||
      errorType === "StripeAuthenticationError" ||
      errorType === "StripePermissionError"
    ) {
      await failRejectedCheckoutAttempt(
        payment._id,
        bookingId,
        "stripe_checkout_rejected",
      );
    }
    throw new HttpError(502, "Stripe Checkout is temporarily unavailable.");
  }

  const persisted = await persistCreatedCheckoutSession(
    payment._id,
    bookingId,
    checkoutSession,
  );
  if (!persisted.eligible) {
    try {
      if (checkoutSession.status === "open") {
        await stripe.checkout.sessions.expire(checkoutSession.id);
      }
    } catch (error) {
      console.error(
        "Could not expire a Checkout Session for a changed booking.",
        stripeErrorSummary(error),
      );
    }
    throw new HttpError(
      409,
      "The booking is no longer eligible for checkout.",
    );
  }
  if (!checkoutSession.url) {
    throw new HttpError(502, "Stripe did not return a Checkout URL.");
  }

  return {
    paymentId: payment._id,
    sessionId: checkoutSession.id,
    url: checkoutSession.url,
    expiresAt: checkoutSession.expires_at
      ? new Date(checkoutSession.expires_at * 1000)
      : undefined,
    reused,
  };
}

function paymentStatusDto(booking: any, payment: any) {
  if (!payment) {
    return {
      bookingId: booking._id,
      amount: Number(booking.totalAmount.toFixed(2)),
      currency: STRIPE_CURRENCY,
      status: booking.paymentStatus ?? "unpaid",
      paidAt: null,
      paymentMethod: null,
    };
  }
  return {
    bookingId: booking._id,
    amount: payment.amount,
    amountMinorUnits: payment.amountMinorUnits,
    currency: payment.currency,
    status: payment.paymentStatus,
    paidAt: payment.paidAt ?? null,
    paymentMethod: payment.paymentMethod ?? null,
    fulfillmentStatus: payment.fulfillmentStatus,
  };
}

export async function getPaymentStatus(
  rawBookingId: unknown,
  viewer: AuthenticatedUser,
) {
  if (!(rawBookingId instanceof Types.ObjectId)) {
    throw new HttpError(400, "bookingId must be a valid ObjectId.");
  }
  const bookingFilter =
    viewer.role === "admin"
      ? { _id: rawBookingId }
      : viewer.role === "owner"
        ? { _id: rawBookingId, ownerId: viewer.id }
        : { _id: rawBookingId, customerId: viewer.id };
  const booking = await Booking.findOne(bookingFilter).lean().exec();
  if (!booking) {
    throw new HttpError(404, "Booking not found.");
  }
  const payment = await Payment.findOne({ bookingId: rawBookingId })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  return paymentStatusDto(booking, payment);
}

function getSessionPaymentIntentId(
  session: Stripe.Checkout.Session,
): string | undefined {
  return getPaymentIntentId(session.payment_intent);
}

function sessionMatchesPayment(
  session: Stripe.Checkout.Session,
  payment: any,
): boolean {
  return (
    payment.stripeSessionId === session.id ||
    payment.stripeSessionId.startsWith(PLACEHOLDER_SESSION_PREFIX)
  );
}

async function findPaymentForCheckoutSession(
  sessionObject: Stripe.Checkout.Session,
  session: ClientSession,
) {
  let payment = await Payment.findOne({
    stripeSessionId: sessionObject.id,
  })
    .session(session)
    .exec();
  if (!payment) {
    const paymentId = objectIdString(sessionObject.metadata?.paymentId);
    if (paymentId) {
      payment = await Payment.findOne({ _id: new Types.ObjectId(paymentId) })
        .session(session)
        .exec();
    }
  }
  return payment;
}

async function recordUnmatchedPaidSession(
  sessionObject: Stripe.Checkout.Session,
  eventId: string,
  session: ClientSession,
) {
  const bookingId = objectIdString(sessionObject.metadata?.bookingId);
  const customerId = objectIdString(sessionObject.metadata?.customerId);
  const amountMinorUnits = sessionObject.amount_total;
  const currency = sessionObject.currency?.toLowerCase();
  if (
    !bookingId ||
    !customerId ||
    !Number.isSafeInteger(amountMinorUnits) ||
    !amountMinorUnits ||
    !currency ||
    currency.length !== 3
  ) {
    return undefined;
  }
  const receivedAmountMinorUnits = amountMinorUnits as number;
  const metadata = sessionObject.metadata ?? {};
  const metadataOwnerId = objectIdString(metadata.ownerId);
  const metadataEquipmentId = objectIdString(metadata.equipmentId);
  const paymentIntentId = getSessionPaymentIntentId(sessionObject);

  const existing = await Payment.findOne({
    stripeSessionId: sessionObject.id,
  })
    .session(session)
    .exec();
  if (existing) {
    return {
      paymentId: existing._id as Types.ObjectId,
      bookingId: existing.bookingId as Types.ObjectId,
      paymentIntentId:
        getSessionPaymentIntentId(sessionObject) ??
        existing.stripePaymentIntentId,
      refundRequired:
        existing.paymentStatus === "paid" &&
        existing.fulfillmentStatus !== "refunded",
    };
  }

  const paymentData = {
    bookingId: new Types.ObjectId(bookingId),
    customerId: new Types.ObjectId(customerId),
    ...(metadataOwnerId ? { ownerId: new Types.ObjectId(metadataOwnerId) } : {}),
    ...(metadataEquipmentId
      ? { equipmentId: new Types.ObjectId(metadataEquipmentId) }
      : {}),
    stripeSessionId: sessionObject.id,
    ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    checkoutAttemptId: metadata.checkoutAttemptId ?? randomUUID(),
    amount: receivedAmountMinorUnits / 100,
    amountMinorUnits: receivedAmountMinorUnits,
    receivedAmountMinorUnits,
    currency,
    receivedCurrency: currency,
    paymentStatus: "paid" as const,
    fulfillmentStatus: "refund_required" as const,
    reconciliationReason: "payment_record_missing_after_success",
    paidAt: new Date(),
    stripeEventIds: [eventId],
  } satisfies PaymentFields;
  const [payment] = await Payment.create([paymentData], { session });
  if (!payment) return undefined;
  console.error("Paid Checkout Session had no payment record; refund recovery started.", {
    paymentId: payment._id.toString(),
    bookingId,
  });
  return {
    paymentId: payment._id as Types.ObjectId,
    bookingId: payment.bookingId as Types.ObjectId,
    paymentIntentId: getSessionPaymentIntentId(sessionObject),
    refundRequired: true,
  };
}

async function updatePaidPayment(
  payment: any,
  booking: any,
  sessionObject: Stripe.Checkout.Session,
  eventId: string,
  session: ClientSession,
  fulfillmentStatus: "fulfilled" | "refund_required",
  reason?: string,
) {
  const paymentIntentId = getSessionPaymentIntentId(sessionObject);
  const paymentMethod =
    sessionObject.payment_method_types?.length === 1
      ? sessionObject.payment_method_types[0]
      : undefined;
  const eventCreated = new Date();
  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        paymentStatus: "paid",
        fulfillmentStatus,
        ...(reason ? { reconciliationReason: reason } : {}),
        ...(paymentIntentId
          ? { stripePaymentIntentId: paymentIntentId }
          : {}),
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(sessionObject.amount_total === null
          ? {}
          : { receivedAmountMinorUnits: sessionObject.amount_total }),
        ...(sessionObject.currency
          ? { receivedCurrency: sessionObject.currency.toLowerCase() }
          : {}),
        paidAt: eventCreated,
        stripeSessionId: sessionObject.id,
      },
      $unset: { activeBookingId: 1 },
      $addToSet: { stripeEventIds: eventId },
    },
  )
    .session(session)
    .exec();

  if (booking) {
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          paymentStatus: "paid",
          stripeSessionId: sessionObject.id,
          ...(fulfillmentStatus === "fulfilled"
            ? { bookingStatus: "confirmed" }
            : {}),
        },
      },
    )
      .session(session)
      .exec();
  }
  return {
    paymentId: payment._id as Types.ObjectId,
    bookingId: payment.bookingId as Types.ObjectId,
    paymentIntentId,
    refundRequired: fulfillmentStatus === "refund_required",
  };
}

async function processPaidCheckoutSession(
  sessionObject: Stripe.Checkout.Session,
  eventId: string,
) {
  return inTransaction(async (session) => {
    const payment = await findPaymentForCheckoutSession(
      sessionObject,
      session,
    );
    if (!payment) {
      if (sessionObject.payment_status === "paid") {
        const recovery = await recordUnmatchedPaidSession(
          sessionObject,
          eventId,
          session,
        );
        if (recovery) {
          return { matched: true as const, ...recovery };
        }
      }
      console.error("Paid Checkout Session has no matching payment record.");
      return { matched: false as const };
    }

    if (payment.stripeEventIds?.includes(eventId)) {
      return {
        matched: true as const,
        paymentId: payment._id,
        bookingId: payment.bookingId,
        paymentIntentId:
          getSessionPaymentIntentId(sessionObject) ??
          payment.stripePaymentIntentId,
        refundRequired: payment.fulfillmentStatus === "refund_required",
      };
    }
    if (!sessionMatchesPayment(sessionObject, payment)) {
      console.error("Checkout Session metadata does not match its payment record.", {
        paymentId: payment._id.toString(),
      });
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return { matched: false as const };
    }
    if (sessionObject.payment_status !== "paid") {
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return { matched: true as const, refundRequired: false as const };
    }

    const paymentIntentId = getSessionPaymentIntentId(sessionObject);
    const priorIntentPayment = paymentIntentId
      ? await Payment.findOne({
          stripePaymentIntentId: paymentIntentId,
          _id: { $ne: payment._id },
        })
          .session(session)
          .exec()
      : null;
    const booking = await Booking.findOne({ _id: payment.bookingId })
      .session(session)
      .exec();

    if (
      payment.paymentStatus === "refunded" ||
      (payment.paymentStatus === "paid" &&
        payment.fulfillmentStatus === "fulfilled")
    ) {
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return { matched: true as const, refundRequired: false as const };
    }

    const bookingMinorUnits = booking
      ? tryToMinorUnits(booking.totalAmount)
      : undefined;
    const amountMatches =
      sessionObject.amount_total === payment.amountMinorUnits &&
      payment.amountMinorUnits === bookingMinorUnits &&
      payment.amountMinorUnits === tryToMinorUnits(payment.amount);
    const currencyMatches =
      sessionObject.currency?.toLowerCase() === payment.currency &&
      payment.currency === STRIPE_CURRENCY;
    const metadataMatches =
      (!sessionObject.metadata?.paymentId ||
        sessionObject.metadata.paymentId === payment._id.toString()) &&
      (!sessionObject.metadata?.checkoutAttemptId ||
        sessionObject.metadata.checkoutAttemptId === payment.checkoutAttemptId) &&
      (!sessionObject.client_reference_id ||
        sessionObject.client_reference_id === payment.bookingId.toString()) &&
      (!sessionObject.metadata?.bookingId ||
        sessionObject.metadata.bookingId === payment.bookingId.toString()) &&
      (!sessionObject.metadata?.customerId ||
        sessionObject.metadata.customerId === payment.customerId.toString());

    if (payment.paymentStatus === "paid" && payment.fulfillmentStatus === "refunded") {
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return { matched: true as const, refundRequired: false as const };
    }

    let fulfillmentStatus: "fulfilled" | "refund_required" = "refund_required";
    let reason = !booking
      ? "booking_missing_after_payment"
      : !amountMatches
        ? "paid_amount_mismatch"
        : !currencyMatches
          ? "paid_currency_mismatch"
          : !metadataMatches
            ? "checkout_metadata_mismatch"
            : priorIntentPayment
              ? "payment_intent_already_linked"
              : "booking_not_fulfillable";

    const canTryFulfillment =
      booking !== null &&
      amountMatches &&
      currencyMatches &&
      metadataMatches &&
      !priorIntentPayment &&
      booking.bookingStatus === "pending" &&
      (booking.paymentStatus === "unpaid" ||
        booking.paymentStatus === "failed") &&
      booking.startDate.getTime() >= todayUtc().getTime() &&
      booking.endDate.getTime() > todayUtc().getTime();

    if (canTryFulfillment && booking) {
      const equipment = await Equipment.findById(booking.equipmentId)
        .session(session)
        .lean()
        .exec();
      if (equipment) {
        await lockEquipmentInventory(booking.equipmentId, session);
      }
      const reservedQuantity = equipment
        ? await getReservedQuantity(
            booking.equipmentId,
            booking,
            session,
            booking._id,
          )
        : 0;
      if (
        equipment &&
        equipment.status === "approved" &&
        equipment.isDeleted === false &&
        Number.isSafeInteger(equipment.availableQuantity) &&
        booking.quantity <= equipment.availableQuantity - reservedQuantity
      ) {
        fulfillmentStatus = "fulfilled";
        reason = "";
      } else {
        reason = equipment
          ? "inventory_unavailable_after_payment"
          : "equipment_missing_after_payment";
      }
    } else if (
      booking?.bookingStatus === "confirmed" &&
      booking.paymentStatus === "paid" &&
      amountMatches &&
      currencyMatches &&
      metadataMatches &&
      !priorIntentPayment
    ) {
      fulfillmentStatus = "fulfilled";
      reason = "";
    } else if (booking) {
      // Serialize payment success against cancellation/status writes, even when
      // this paid booking cannot be fulfilled and needs a refund.
      await Booking.updateOne(
        { _id: booking._id },
        { $inc: { checkoutAttemptVersion: 1 } },
      )
        .session(session)
        .exec();
    }

    const updated = await updatePaidPayment(
      payment,
      booking,
      sessionObject,
      eventId,
      session,
      fulfillmentStatus,
      reason || undefined,
    );
    return { matched: true as const, ...updated };
  });
}

async function markCheckoutSessionFailed(
  sessionObject: Stripe.Checkout.Session,
  eventId: string,
  reason: string,
) {
  return inTransaction(async (session) => {
    if (sessionObject.payment_status === "paid") {
      return;
    }
    const payment = await findPaymentForCheckoutSession(
      sessionObject,
      session,
    );
    if (!payment) {
      console.warn("Expired or failed Checkout Session has no payment record.");
      return;
    }
    if (payment.stripeEventIds?.includes(eventId)) return;
    if (!sessionMatchesPayment(sessionObject, payment)) {
      console.error("Failed Checkout Session does not match its payment record.", {
        paymentId: payment._id.toString(),
      });
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return;
    }
    if (payment.paymentStatus === "paid" || payment.paymentStatus === "refunded") {
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return;
    }
    await Payment.updateOne(
      {
        _id: payment._id,
        paymentStatus: { $in: ["pending", "failed"] },
      },
      {
        $set: {
          paymentStatus: "failed",
          stripeSessionId: sessionObject.id,
          reconciliationReason: reason,
        },
        $unset: { activeBookingId: 1 },
        $addToSet: { stripeEventIds: eventId },
      },
    )
      .session(session)
      .exec();
    await Booking.updateOne(
      {
        _id: payment.bookingId,
        bookingStatus: "pending",
        paymentStatus: "unpaid",
      },
      {
        $set: {
          paymentStatus: "failed",
          stripeSessionId: sessionObject.id,
        },
      },
    )
      .session(session)
      .exec();
  });
}

async function markPaymentIntentFailed(
  paymentIntent: Stripe.PaymentIntent,
  eventId: string,
) {
  return inTransaction(async (session) => {
    let payment = await Payment.findOne({
      stripePaymentIntentId: paymentIntent.id,
    })
      .session(session)
      .exec();
    if (!payment) {
      const paymentId = objectIdString(paymentIntent.metadata?.paymentId);
      if (paymentId) {
        payment = await Payment.findOne({ _id: new Types.ObjectId(paymentId) })
          .session(session)
          .exec();
      }
    }
    if (!payment) {
      console.warn("Failed PaymentIntent has no matching payment record.");
      return;
    }
    if (payment.stripeEventIds?.includes(eventId)) return;
    const metadataMatches =
      paymentIntent.metadata?.paymentId === payment._id.toString() &&
      paymentIntent.metadata?.checkoutAttemptId === payment.checkoutAttemptId;
    const amountMatches =
      paymentIntent.amount === payment.amountMinorUnits &&
      paymentIntent.currency.toLowerCase() === payment.currency;
    if (
      !metadataMatches ||
      !amountMatches ||
      (payment.stripePaymentIntentId &&
        payment.stripePaymentIntentId !== paymentIntent.id)
    ) {
      console.error("PaymentIntent failure does not match its payment record.", {
        paymentId: payment._id.toString(),
      });
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return;
    }
    if (payment.paymentStatus === "paid" || payment.paymentStatus === "refunded") {
      await Payment.updateOne(
        { _id: payment._id },
        { $addToSet: { stripeEventIds: eventId } },
      )
        .session(session)
        .exec();
      return;
    }
    await Payment.updateOne(
      {
        _id: payment._id,
        paymentStatus: { $in: ["pending", "failed"] },
      },
      {
        $set: {
          paymentStatus: "failed",
          stripePaymentIntentId: paymentIntent.id,
          reconciliationReason: "stripe_payment_intent_failed",
        },
        $addToSet: { stripeEventIds: eventId },
      },
    )
      .session(session)
      .exec();
    await Booking.updateOne(
      {
        _id: payment.bookingId,
        bookingStatus: "pending",
        paymentStatus: { $in: ["unpaid", "failed"] },
      },
      { $set: { paymentStatus: "failed" } },
    )
      .session(session)
      .exec();
  });
}

async function recordRefundResult(
  paymentId: Types.ObjectId,
  refund: Stripe.Refund,
) {
  await inTransaction(async (session) => {
    const payment = await Payment.findOne({ _id: paymentId })
      .session(session)
      .exec();
    if (!payment) return;
    const succeeded = refund.status === "succeeded";
    const refundPending = refund.status === "pending";
    await Payment.updateOne(
      { _id: paymentId },
      {
        $set: {
          ...(succeeded ? { paymentStatus: "refunded" } : {}),
          fulfillmentStatus: succeeded
            ? "refunded"
            : refundPending
              ? "refund_pending"
              : "refund_required",
          stripeRefundId: refund.id,
          ...(!succeeded
            ? {
                reconciliationReason: refundPending
                  ? "stripe_refund_pending"
                  : "stripe_refund_failed",
              }
            : {}),
        },
      },
    )
      .session(session)
      .exec();
    if (
      succeeded &&
      payment.reconciliationReason !== "payment_record_missing_after_success"
    ) {
      await Booking.updateOne(
        { _id: payment.bookingId, paymentStatus: "paid" },
        { $set: { paymentStatus: "refunded" } },
      )
        .session(session)
        .exec();
    }
  });
}

async function recordRefundFailure(
  paymentId: Types.ObjectId,
  reason: string,
) {
  await inTransaction(async (session) => {
    await Payment.updateOne(
      { _id: paymentId },
      {
        $set: {
          fulfillmentStatus: "refund_required",
          reconciliationReason: reason,
        },
      },
    )
      .session(session)
      .exec();
  });
}

async function attemptRecoveryRefund(
  paymentId: Types.ObjectId,
  bookingId: Types.ObjectId,
  paymentIntentId: string | undefined,
) {
  if (!paymentIntentId) {
    console.error("Paid booking requires a refund but has no PaymentIntent ID.", {
      paymentId: paymentId.toString(),
      bookingId: bookingId.toString(),
    });
    return;
  }
  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: {
          varaxPaymentId: paymentId.toString(),
          bookingId: bookingId.toString(),
          reason: "booking_unfulfillable",
        },
      },
      { idempotencyKey: `varax-recovery-refund-${paymentId.toString()}` },
    );
  } catch (error) {
    console.error("Automatic refund for an unfulfillable booking failed.", {
      paymentId: paymentId.toString(),
      ...stripeErrorSummary(error),
    });
    await recordRefundFailure(paymentId, "stripe_refund_attempt_failed");
    return;
  }
  await recordRefundResult(paymentId, refund);
}

async function processChargeRefunded(charge: Stripe.Charge, eventId: string) {
  const paymentIntentId = getPaymentIntentId(charge.payment_intent);
  if (!paymentIntentId) return;
  await inTransaction(async (session) => {
    const payment = await Payment.findOne({
      stripePaymentIntentId: paymentIntentId,
    })
      .session(session)
      .exec();
    if (!payment || payment.stripeEventIds?.includes(eventId)) return;
    const fullRefund =
      charge.refunded ||
      (payment.amountMinorUnits !== undefined &&
        charge.amount_refunded >= payment.amountMinorUnits);
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: fullRefund
          ? {
              paymentStatus: "refunded",
              fulfillmentStatus: "refunded",
            }
          : { fulfillmentStatus: "refund_pending" },
        $addToSet: { stripeEventIds: eventId },
      },
    )
      .session(session)
      .exec();
    if (fullRefund) {
      await Booking.updateOne(
        { _id: payment.bookingId, paymentStatus: "paid" },
        { $set: { paymentStatus: "refunded" } },
      )
        .session(session)
        .exec();
    }
  });
}

export async function handleStripeWebhookEvent(event: Stripe.Event) {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const outcome = await processPaidCheckoutSession(
      event.data.object as Stripe.Checkout.Session,
      event.id,
    );
    if (outcome.matched && outcome.refundRequired) {
      await attemptRecoveryRefund(
        outcome.paymentId,
        outcome.bookingId,
        outcome.paymentIntentId,
      );
    }
    return;
  }
  if (event.type === "checkout.session.expired") {
    await markCheckoutSessionFailed(
      event.data.object as Stripe.Checkout.Session,
      event.id,
      "checkout_session_expired",
    );
    return;
  }
  if (event.type === "checkout.session.async_payment_failed") {
    await markCheckoutSessionFailed(
      event.data.object as Stripe.Checkout.Session,
      event.id,
      "checkout_async_payment_failed",
    );
    return;
  }
  if (event.type === "payment_intent.payment_failed") {
    await markPaymentIntentFailed(
      event.data.object as Stripe.PaymentIntent,
      event.id,
    );
    return;
  }
  if (event.type === "charge.refunded") {
    await processChargeRefunded(event.data.object as Stripe.Charge, event.id);
  }
}
