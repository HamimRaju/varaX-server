import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-payment-tests";
process.env.STRIPE_SECRET_KEY = "sk_test_varax_payment_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_varax_payment_tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const customerId = new mongoose.Types.ObjectId();
const otherCustomerId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const otherOwnerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const bookingId = new mongoose.Types.ObjectId();
const otherBookingId = new mongoose.Types.ObjectId();
const equipmentId = new mongoose.Types.ObjectId();
const otherEquipmentId = new mongoose.Types.ObjectId();
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const users = new Map();
const equipment = new Map();
let bookings = [];
let payments = [];
let transactionQueue = Promise.resolve();
let transactionsSupported = true;
let apiServer;
let authServer;
let apiBase;
let authBase;
let privateKey;
let keyId;
let tokens;
let models;
let stripeClient;
let restoreMethods;
let stripeCallCount = 0;
let refundCallCount = 0;
let stripeCreateError;
let stripeRefundError;
let checkoutByIdempotencyKey;
let checkoutById;
let capturedCheckoutParams;
let capturedCheckoutOptions;

function idKey(value) {
  return String(value);
}

function sameId(left, right) {
  return idKey(left) === idKey(right);
}

function matchesValue(actual, expected) {
  if (
    expected &&
    typeof expected === "object" &&
    !expected._bsontype &&
    !expected.toHexString
  ) {
    if ("$in" in expected) {
      return expected.$in.some((item) => sameId(actual, item));
    }
    if ("$ne" in expected && sameId(actual, expected.$ne)) return false;
    if ("$exists" in expected && Boolean(actual !== undefined) !== expected.$exists) {
      return false;
    }
    if ("$lt" in expected && !(actual < expected.$lt)) return false;
    if ("$gt" in expected && !(actual > expected.$gt)) return false;
    if ("$lte" in expected && !(actual <= expected.$lte)) return false;
    if ("$gte" in expected && !(actual >= expected.$gte)) return false;
    return true;
  }
  return sameId(actual, expected);
}

function matchesFilter(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") {
      return expected.some((clause) => matchesFilter(row, clause));
    }
    if (field === "$and") {
      return expected.every((clause) => matchesFilter(row, clause));
    }
    return matchesValue(row[field], expected);
  });
}

function applyUpdate(row, update) {
  for (const [key, value] of Object.entries(update.$set ?? {})) {
    row[key] = value;
  }
  for (const [key, value] of Object.entries(update.$inc ?? {})) {
    row[key] = (row[key] ?? 0) + value;
  }
  for (const [key, value] of Object.entries(update.$unset ?? {})) {
    if (value !== undefined) delete row[key];
  }
  for (const [key, value] of Object.entries(update.$addToSet ?? {})) {
    row[key] ??= [];
    if (!row[key].some((item) => sameId(item, value))) row[key].push(value);
  }
}

function query(exec) {
  return {
    session() {
      return this;
    },
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean() {
      return this;
    },
    async exec() {
      return exec();
    },
  };
}

function startOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dateOffset(days) {
  const date = startOfToday();
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function makeBooking(id = bookingId, overrides = {}) {
  return {
    _id: id,
    customerId,
    ownerId,
    equipmentId,
    startDate: dateOffset(5),
    endDate: dateOffset(7),
    quantity: 1,
    rentalType: "daily",
    unitPrice: 6.17,
    rentalDuration: 2,
    subtotal: 12.34,
    totalAmount: 12.34,
    bookingStatus: "pending",
    paymentStatus: "unpaid",
    stripeSessionId: undefined,
    checkoutAttemptVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEquipment(id = equipmentId, owner = ownerId, overrides = {}) {
  return {
    _id: id,
    ownerId: owner,
    name: "Rental camera",
    status: "approved",
    isDeleted: false,
    availableQuantity: 2,
    reservationVersion: 0,
    ...overrides,
  };
}

function makePayment(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    bookingId,
    customerId,
    ownerId,
    equipmentId,
    stripeSessionId: "cs_test_payment_01",
    stripePaymentIntentId: undefined,
    checkoutAttemptId: "attempt-payment-01",
    checkoutUrl: undefined,
    checkoutExpiresAt: undefined,
    amount: 12.34,
    amountMinorUnits: 1234,
    currency: "bdt",
    paymentStatus: "pending",
    fulfillmentStatus: "pending",
    activeBookingId: bookingId,
    paymentMethod: undefined,
    paidAt: undefined,
    stripeEventIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function apiCall(method, path, token, body, headers = {}) {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function checkoutSession(payment, overrides = {}) {
  return {
    id: payment.stripeSessionId,
    object: "checkout.session",
    url: `https://checkout.stripe.test/${payment.stripeSessionId}`,
    status: "complete",
    mode: "payment",
    payment_status: "paid",
    amount_total: payment.amountMinorUnits,
    currency: payment.currency,
    client_reference_id: payment.bookingId.toString(),
    payment_intent: "pi_test_payment_01",
    payment_method_types: ["card"],
    metadata: {
      paymentId: payment._id.toString(),
      bookingId: payment.bookingId.toString(),
      customerId: payment.customerId.toString(),
      checkoutAttemptId: payment.checkoutAttemptId,
    },
    ...overrides,
  };
}

function stripeEvent(type, object, id = `evt_${Math.random().toString(16).slice(2)}`) {
  return {
    id,
    object: "event",
    api_version: "2026-01-28.clover",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  };
}

async function sendWebhook(event, signatureOverride) {
  const payload = JSON.stringify(event);
  const signature =
    signatureOverride ??
    stripeClient.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });
  return fetch(`${apiBase}/api/payments/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  });
}

function addPayment(values = {}) {
  const payment = makePayment(values);
  payments.push(payment);
  return payment;
}

before(async () => {
  let publicJwk;
  authServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  authBase = await listen(authServer);
  process.env.CLIENT_URL = authBase;
  process.env.JWT_ISSUER = authBase;
  process.env.JWKS_URL = `${authBase}/api/auth/jwks`;

  const keyPair = await generateKeyPair("EdDSA");
  privateKey = keyPair.privateKey;
  keyId = "payment-test-key";
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: keyId,
    alg: "EdDSA",
    use: "sig",
  };

  const { User } = await import("../dist/models/User.js");
  const { Equipment } = await import("../dist/models/Equipment.js");
  const { Booking } = await import("../dist/models/Booking.js");
  const { Payment } = await import("../dist/models/Payment.js");
  const { stripe } = await import("../dist/config/stripe.js");
  models = { User, Equipment, Booking, Payment };
  stripeClient = stripe;

  for (const [id, role, name] of [
    [customerId, "customer", "Payment Customer"],
    [otherCustomerId, "customer", "Other Customer"],
    [ownerId, "owner", "Payment Owner"],
    [otherOwnerId, "owner", "Other Owner"],
    [adminId, "admin", "Payment Admin"],
  ]) {
    users.set(idKey(id), {
      _id: id,
      name,
      email: `${role}-${idKey(id).slice(-4)}@example.test`,
      role,
      isActive: true,
    });
  }

  const originals = {
    userFindById: User.findById,
    equipmentFindById: Equipment.findById,
    equipmentUpdateOne: Equipment.updateOne,
    bookingFindOne: Booking.findOne,
    bookingUpdateOne: Booking.updateOne,
    bookingAggregate: Booking.aggregate,
    paymentCreate: Payment.create,
    paymentFindOne: Payment.findOne,
    paymentUpdateOne: Payment.updateOne,
    mongooseStartSession: mongoose.startSession,
    stripeCreate: stripe.checkout.sessions.create,
    stripeExpire: stripe.checkout.sessions.expire,
    stripeRefundCreate: stripe.refunds.create,
  };

  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return query(() => users.get(idKey(id)) ?? null);
    },
  });

  Object.defineProperty(Equipment, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return query(() => equipment.get(idKey(id)) ?? null);
    },
  });

  Object.defineProperty(Equipment, "updateOne", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query(() => {
        const row = equipment.get(idKey(filter._id));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        applyUpdate(row, update);
        return { matchedCount: 1, modifiedCount: 1 };
      });
    },
  });

  Object.defineProperty(Booking, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() => bookings.find((row) => matchesFilter(row, filter)) ?? null);
    },
  });

  Object.defineProperty(Booking, "updateOne", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query(() => {
        const row = bookings.find((booking) => matchesFilter(booking, filter));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        applyUpdate(row, update);
        row.updatedAt = new Date();
        return { matchedCount: 1, modifiedCount: 1 };
      });
    },
  });

  Object.defineProperty(Booking, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return {
        session() {
          return this;
        },
        async exec() {
          const filter = pipeline[0].$match;
          const total = bookings
            .filter((booking) => matchesFilter(booking, filter))
            .reduce((sum, booking) => sum + booking.quantity, 0);
          return total ? [{ _id: null, reservedQuantity: total }] : [];
        },
      };
    },
  });

  Object.defineProperty(Payment, "create", {
    configurable: true,
    writable: true,
    async value(documents) {
      return documents.map((document) => {
        const payment = {
          _id: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...document,
        };
        payments.push(payment);
        return payment;
      });
    },
  });

  Object.defineProperty(Payment, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() => payments.find((row) => matchesFilter(row, filter)) ?? null);
    },
  });

  Object.defineProperty(Payment, "updateOne", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query(() => {
        const row = payments.find((payment) => matchesFilter(payment, filter));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        applyUpdate(row, update);
        row.updatedAt = new Date();
        return { matchedCount: 1, modifiedCount: 1 };
      });
    },
  });

  Object.defineProperty(mongoose, "startSession", {
    configurable: true,
    writable: true,
    value: async () => ({
      async withTransaction(callback) {
        let release;
        const previous = transactionQueue;
        transactionQueue = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
        const snapshots = {
          bookings: bookings.map((row) => [row, { ...row }]),
          payments: payments.map((row) => [row, { ...row }]),
          equipment: [...equipment].map(([key, row]) => [key, { ...row }]),
        };
        try {
          if (!transactionsSupported) {
            const error = new Error(
              "Transaction numbers are only allowed on a replica set member or mongos",
            );
            error.code = 20;
            throw error;
          }
          return await callback();
        } catch (error) {
          for (const [row, state] of snapshots.bookings) Object.assign(row, state);
          for (const [row, state] of snapshots.payments) Object.assign(row, state);
          bookings.splice(0, bookings.length, ...snapshots.bookings.map(([row]) => row));
          payments.splice(0, payments.length, ...snapshots.payments.map(([row]) => row));
          for (const [key, state] of snapshots.equipment) {
            const row = equipment.get(key);
            if (row) Object.assign(row, state);
          }
          throw error;
        } finally {
          release();
        }
      },
      async endSession() {},
    }),
  });

  const createStripeCheckout = async (params, options) => {
    stripeCallCount += 1;
    capturedCheckoutParams = params;
    capturedCheckoutOptions = options;
    if (stripeCreateError) throw stripeCreateError;
    if (checkoutByIdempotencyKey.has(options.idempotencyKey)) {
      return checkoutByIdempotencyKey.get(options.idempotencyKey);
    }
    const id = `cs_test_${String(stripeCallCount).padStart(6, "0")}`;
    const session = {
      id,
      object: "checkout.session",
      url: `https://checkout.stripe.test/${id}`,
      status: "open",
      mode: params.mode,
      payment_status: "unpaid",
      amount_total: params.line_items[0].price_data.unit_amount,
      currency: params.line_items[0].price_data.currency,
      client_reference_id: params.client_reference_id,
      payment_intent: null,
      payment_method_types: ["card"],
      metadata: params.metadata,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    checkoutByIdempotencyKey.set(options.idempotencyKey, session);
    checkoutById.set(id, session);
    return session;
  };
  Object.defineProperty(stripe.checkout.sessions, "create", {
    configurable: true,
    writable: true,
    value: createStripeCheckout,
  });
  Object.defineProperty(stripe.checkout.sessions, "expire", {
    configurable: true,
    writable: true,
    value: async (id) => {
      const session = checkoutById.get(id);
      if (session) session.status = "expired";
      return session;
    },
  });
  Object.defineProperty(stripe.refunds, "create", {
    configurable: true,
    writable: true,
    value: async (params, options) => {
      refundCallCount += 1;
      if (stripeRefundError) throw stripeRefundError;
      return {
        id: `re_test_${refundCallCount}`,
        object: "refund",
        status: "succeeded",
        payment_intent: params.payment_intent,
        amount: 1234,
        currency: "bdt",
        metadata: params.metadata,
        idempotencyKey: options.idempotencyKey,
      };
    },
  });

  restoreMethods = () => {
    const restore = (target, key, value) =>
      Object.defineProperty(target, key, {
        configurable: true,
        writable: true,
        value,
      });
    restore(User, "findById", originals.userFindById);
    restore(Equipment, "findById", originals.equipmentFindById);
    restore(Equipment, "updateOne", originals.equipmentUpdateOne);
    restore(Booking, "findOne", originals.bookingFindOne);
    restore(Booking, "updateOne", originals.bookingUpdateOne);
    restore(Booking, "aggregate", originals.bookingAggregate);
    restore(Payment, "create", originals.paymentCreate);
    restore(Payment, "findOne", originals.paymentFindOne);
    restore(Payment, "updateOne", originals.paymentUpdateOne);
    restore(mongoose, "startSession", originals.mongooseStartSession);
    restore(stripe.checkout.sessions, "create", originals.stripeCreate);
    restore(stripe.checkout.sessions, "expire", originals.stripeExpire);
    restore(stripe.refunds, "create", originals.stripeRefundCreate);
  };

  const sign = async (id, role) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: "EdDSA", kid: keyId })
      .setIssuer(authBase)
      .setAudience("varax-api")
      .setSubject(id.toString())
      .setExpirationTime("5m")
      .sign(privateKey);
  tokens = {
    customer: await sign(customerId, "customer"),
    otherCustomer: await sign(otherCustomerId, "customer"),
    owner: await sign(ownerId, "owner"),
    otherOwner: await sign(otherOwnerId, "owner"),
    admin: await sign(adminId, "admin"),
  };

  const app = (await import("../dist/app.js")).default;
  apiServer = createServer(app);
  apiBase = await listen(apiServer);
});

beforeEach(() => {
  bookings = [
    makeBooking(),
    makeBooking(otherBookingId, {
      customerId: otherCustomerId,
      ownerId: otherOwnerId,
      equipmentId: otherEquipmentId,
    }),
  ];
  payments = [];
  equipment.clear();
  equipment.set(idKey(equipmentId), makeEquipment(equipmentId, ownerId));
  equipment.set(idKey(otherEquipmentId), makeEquipment(otherEquipmentId, otherOwnerId));
  transactionQueue = Promise.resolve();
  transactionsSupported = true;
  stripeCallCount = 0;
  refundCallCount = 0;
  stripeCreateError = undefined;
  stripeRefundError = undefined;
  checkoutByIdempotencyKey = new Map();
  checkoutById = new Map();
  capturedCheckoutParams = undefined;
  capturedCheckoutOptions = undefined;
});

after(async () => {
  restoreMethods?.();
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

test("Payment reuses the existing collection and supports Stripe and recovery fields", () => {
  assert.equal(models.Payment.collection.collectionName, "payments");
  for (const path of [
    "bookingId",
    "customerId",
    "ownerId",
    "equipmentId",
    "stripeSessionId",
    "stripePaymentIntentId",
    "amount",
    "amountMinorUnits",
    "receivedAmountMinorUnits",
    "receivedCurrency",
    "currency",
    "paymentStatus",
    "status",
    "paymentMethod",
    "paidAt",
    "fulfillmentStatus",
    "stripeEventIds",
  ]) {
    assert.ok(
      models.Payment.schema.path(path) ||
        models.Payment.schema.virtualpath(path),
      `missing Payment schema field ${path}`,
    );
  }
  assert.ok(
    models.Payment.schema.indexes().some(
      ([keys, options]) =>
        keys.activeBookingId === 1 &&
        options.unique === true &&
        options.partialFilterExpression?.activeBookingId?.$type === "objectId",
    ),
  );
});

test("Checkout endpoint requires an authenticated customer", async () => {
  assert.equal(
    (
      await apiCall(
        "POST",
        "/api/payments/create-checkout-session",
        undefined,
        { bookingId: bookingId.toString() },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await apiCall(
        "POST",
        "/api/payments/create-checkout-session",
        tokens.owner,
        { bookingId: bookingId.toString() },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await apiCall(
        "POST",
        "/api/payments/create-checkout-session",
        tokens.admin,
        { bookingId: bookingId.toString() },
      )
    ).status,
    403,
  );
});

test("Invalid booking IDs and another customer's booking are rejected", async () => {
  assert.equal(
    (
      await apiCall(
        "POST",
        "/api/payments/create-checkout-session",
        tokens.customer,
        { bookingId: "not-an-id" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "POST",
        "/api/payments/create-checkout-session",
        tokens.otherCustomer,
        { bookingId: bookingId.toString() },
      )
    ).status,
    404,
  );
});

test("Already-paid bookings cannot start another Checkout Session", async () => {
  bookings[0].bookingStatus = "confirmed";
  bookings[0].paymentStatus = "paid";
  const response = await apiCall(
    "POST",
    "/api/payments/create-checkout-session",
    tokens.customer,
    { bookingId: bookingId.toString() },
  );
  assert.equal(response.status, 409);
  assert.equal(stripeCallCount, 0);
});

test("Checkout ignores client amounts and uses stored amount and BDT minor units", async () => {
  const response = await apiCall(
    "POST",
    "/api/payments/create-checkout-session",
    tokens.customer,
    {
      bookingId: bookingId.toString(),
      amount: 0.01,
      amountMinorUnits: 1,
      currency: "usd",
      customerId: otherCustomerId.toString(),
      ownerId: otherOwnerId.toString(),
      paymentStatus: "paid",
    },
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.url, "https://checkout.stripe.test/cs_test_000001");
  assert.equal(capturedCheckoutParams.line_items[0].price_data.unit_amount, 1234);
  assert.equal(capturedCheckoutParams.line_items[0].price_data.currency, "bdt");
  assert.equal(capturedCheckoutParams.client_reference_id, bookingId.toString());
  assert.equal(capturedCheckoutParams.metadata.customerId, customerId.toString());
  assert.equal(capturedCheckoutParams.metadata.ownerId, ownerId.toString());
  assert.match(capturedCheckoutParams.success_url, /payment-success/);
  assert.match(capturedCheckoutParams.success_url, /\{CHECKOUT_SESSION_ID\}/);
  assert.match(capturedCheckoutParams.cancel_url, /payment-cancel\?/);
  assert.match(capturedCheckoutOptions.idempotencyKey, /^varax-checkout-/);
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(bookings[0].bookingStatus, "pending");
  assert.equal(payments[0].amount, 12.34);
  assert.equal(payments[0].amountMinorUnits, 1234);
});

test("Duplicate checkout requests reuse one active Stripe Session", async () => {
  const body = { bookingId: bookingId.toString() };
  const first = await apiCall(
    "POST",
    "/api/payments/create-checkout-session",
    tokens.customer,
    body,
  );
  const second = await apiCall(
    "POST",
    "/api/payments/create-checkout-session",
    tokens.customer,
    body,
  );
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(stripeCallCount, 1);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].activeBookingId.toString(), bookingId.toString());
});

test("Invalid webhook signatures are rejected", async () => {
  const response = await sendWebhook(
    stripeEvent("checkout.session.completed", {}),
    "t=1,v1=invalid",
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /signature/i);
});

test("A verified paid checkout marks Payment paid and confirms the booking", async () => {
  const payment = addPayment();
  const session = checkoutSession(payment);
  const response = await sendWebhook(
    stripeEvent("checkout.session.completed", session, "evt_paid_once"),
  );
  assert.equal(response.status, 200);
  assert.equal(payment.paymentStatus, "paid");
  assert.equal(payment.fulfillmentStatus, "fulfilled");
  assert.equal(payment.stripePaymentIntentId, "pi_test_payment_01");
  assert.equal(payment.paymentMethod, "card");
  assert.ok(payment.paidAt instanceof Date);
  assert.equal(bookings[0].paymentStatus, "paid");
  assert.equal(bookings[0].bookingStatus, "confirmed");
  assert.equal(equipment.get(idKey(equipmentId)).availableQuantity, 2);
});

test("Repeated webhook events are idempotent", async () => {
  const payment = addPayment();
  const session = checkoutSession(payment);
  const event = stripeEvent("checkout.session.completed", session, "evt_repeat");
  assert.equal((await sendWebhook(event)).status, 200);
  const versionAfterFirst = equipment.get(idKey(equipmentId)).reservationVersion;
  assert.equal((await sendWebhook(event)).status, 200);
  assert.equal(payment.stripeEventIds.filter((id) => id === "evt_repeat").length, 1);
  assert.equal(
    equipment.get(idKey(equipmentId)).reservationVersion,
    versionAfterFirst,
  );
  assert.equal(bookings[0].bookingStatus, "confirmed");
});

test("Expired Checkout Sessions fail the payment and never confirm a booking", async () => {
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.expired",
      checkoutSession(payment, {
        status: "expired",
        payment_status: "unpaid",
        payment_intent: null,
      }),
      "evt_expired",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(payment.paymentStatus, "failed");
  assert.equal(payment.activeBookingId, undefined);
  assert.equal(bookings[0].paymentStatus, "failed");
  assert.equal(bookings[0].bookingStatus, "pending");
});

test("Failed PaymentIntents do not mark bookings paid", async () => {
  const payment = addPayment({
    checkoutUrl: "https://checkout.stripe.test/cs_test_payment_01",
    checkoutExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  const response = await sendWebhook(
    stripeEvent(
      "payment_intent.payment_failed",
      {
        id: "pi_test_payment_01",
        object: "payment_intent",
        amount: 1234,
        currency: "bdt",
        metadata: {
          paymentId: payment._id.toString(),
          checkoutAttemptId: payment.checkoutAttemptId,
        },
      },
      "evt_intent_failed",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(payment.paymentStatus, "failed");
  assert.equal(bookings[0].paymentStatus, "failed");
  assert.notEqual(bookings[0].paymentStatus, "paid");
  assert.equal(bookings[0].bookingStatus, "pending");
  assert.equal(payment.activeBookingId.toString(), bookingId.toString());
  const retry = await apiCall(
    "POST",
    "/api/payments/create-checkout-session",
    tokens.customer,
    { bookingId: bookingId.toString() },
  );
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.url, payment.checkoutUrl);
  assert.equal(stripeCallCount, 0);
});

test("Unpaid checkout completion events do not update payment or booking status", async () => {
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment, { payment_status: "unpaid" }),
      "evt_async_pending",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(payment.paymentStatus, "pending");
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(bookings[0].bookingStatus, "pending");
});

test("Amount mismatches trigger a durable paid/refund recovery, not confirmation", async () => {
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment, { amount_total: 500 }),
      "evt_amount_mismatch",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(refundCallCount, 1);
  assert.equal(payment.paymentStatus, "refunded");
  assert.equal(payment.fulfillmentStatus, "refunded");
  assert.equal(payment.receivedAmountMinorUnits, 500);
  assert.equal(bookings[0].paymentStatus, "refunded");
  assert.equal(bookings[0].bookingStatus, "pending");
});

test("Currency mismatches trigger recovery refund and do not confirm", async () => {
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment, { currency: "usd" }),
      "evt_currency_mismatch",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(refundCallCount, 1);
  assert.equal(payment.paymentStatus, "refunded");
  assert.equal(bookings[0].bookingStatus, "pending");
});

test("Mismatched Checkout metadata is recorded and refunded instead of discarded", async () => {
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment, {
        metadata: {
          ...checkoutSession(payment).metadata,
          customerId: otherCustomerId.toString(),
        },
      }),
      "evt_metadata_mismatch",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(refundCallCount, 1);
  assert.equal(payment.paymentStatus, "refunded");
  assert.equal(bookings[0].bookingStatus, "pending");
});

test("Missing equipment after successful payment is recorded for refund", async () => {
  const payment = addPayment();
  equipment.delete(idKey(equipmentId));
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment),
      "evt_equipment_missing",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(payment.paymentStatus, "refunded");
  assert.equal(payment.fulfillmentStatus, "refunded");
  assert.equal(bookings[0].bookingStatus, "pending");
  assert.equal(bookings[0].paymentStatus, "refunded");
});

test("Paid sessions with missing Payment records create a durable refund record", async () => {
  const missingPaymentId = new mongoose.Types.ObjectId();
  const session = {
    ...checkoutSession(
      makePayment({
        _id: missingPaymentId,
        stripeSessionId: "cs_test_orphan",
      }),
      { id: "cs_test_orphan" },
    ),
    metadata: {
      paymentId: missingPaymentId.toString(),
      bookingId: bookingId.toString(),
      customerId: customerId.toString(),
      ownerId: ownerId.toString(),
      equipmentId: equipmentId.toString(),
      checkoutAttemptId: "missing-attempt",
    },
  };
  const response = await sendWebhook(
    stripeEvent("checkout.session.completed", session, "evt_orphan_paid"),
  );
  assert.equal(response.status, 200);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].stripeSessionId, "cs_test_orphan");
  assert.equal(payments[0].paymentStatus, "refunded");
  assert.equal(
    payments[0].reconciliationReason,
    "payment_record_missing_after_success",
  );
  assert.equal(bookings[0].bookingStatus, "pending");
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(refundCallCount, 1);
});

test("A paid booking that lost inventory is refunded without overbooking", async () => {
  equipment.get(idKey(equipmentId)).availableQuantity = 1;
  const reservation = makeBooking(new mongoose.Types.ObjectId(), {
    bookingStatus: "confirmed",
    paymentStatus: "paid",
    quantity: 1,
  });
  bookings.push(reservation);
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment),
      "evt_no_inventory",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(bookings[0].bookingStatus, "pending");
  assert.equal(bookings[0].paymentStatus, "refunded");
  assert.equal(payment.paymentStatus, "refunded");
  assert.equal(payment.fulfillmentStatus, "refunded");
  assert.equal(refundCallCount, 1);
});

test("A failed automatic refund stays visible for manual recovery", async () => {
  stripeRefundError = Object.assign(new Error("secret must not leak"), {
    type: "StripeAPIError",
    code: "api_error",
    requestId: "req_refund_failed",
  });
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment, { amount_total: 999 }),
      "evt_refund_failure",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(payment.paymentStatus, "paid");
  assert.equal(payment.fulfillmentStatus, "refund_required");
  assert.equal(bookings[0].paymentStatus, "paid");
  assert.equal(bookings[0].bookingStatus, "pending");
});

test("Customers, owners, and admins get role-scoped payment status", async () => {
  const payment = addPayment({
    paymentStatus: "paid",
    fulfillmentStatus: "fulfilled",
    paymentMethod: "card",
    paidAt: new Date("2026-01-02T00:00:00.000Z"),
    stripePaymentIntentId: "pi_private_reference",
    checkoutUrl: "https://checkout.stripe.test/private",
  });

  const customerResponse = await apiCall(
    "GET",
    `/api/payments/${bookingId}/status`,
    tokens.customer,
  );
  assert.equal(customerResponse.status, 200);
  const customerData = (await customerResponse.json()).data;
  assert.equal(customerData.status, "paid");
  assert.equal(customerData.amount, 12.34);
  assert.equal(customerData.amountMinorUnits, 1234);
  assert.equal(customerData.currency, "bdt");
  assert.equal(customerData.paymentMethod, "card");
  assert.equal("stripePaymentIntentId" in customerData, false);
  assert.equal("checkoutUrl" in customerData, false);
  assert.equal(
    (
      await apiCall(
        "GET",
        `/api/payments/${bookingId}/status`,
        tokens.otherCustomer,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        `/api/payments/${bookingId}/status`,
        tokens.owner,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        `/api/payments/${bookingId}/status`,
        tokens.otherOwner,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        `/api/payments/${bookingId}/status`,
        tokens.admin,
      )
    ).status,
    200,
  );
  assert.equal(payment.paymentStatus, "paid");
});

test("Stripe request failures return a safe message without credentials", async () => {
  stripeCreateError = Object.assign(
    new Error("authorization failed with sk_test_super_secret"),
    {
      type: "StripeInvalidRequestError",
      code: "invalid_request_error",
      requestId: "req_checkout_error",
    },
  );
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const response = await apiCall(
      "POST",
      "/api/payments/create-checkout-session",
      tokens.customer,
      { bookingId: bookingId.toString(), amount: 1 },
    );
    assert.equal(response.status, 502);
    const responseText = await response.text();
    assert.doesNotMatch(responseText, /sk_test_super_secret/);
    assert.match(responseText, /temporarily unavailable/i);
    assert.equal(payments[0].paymentStatus, "failed");
    assert.ok(logged.length > 0);
    assert.doesNotMatch(JSON.stringify(logged), /sk_test_super_secret/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("Concurrent successful checkouts cannot confirm more units than are available", async () => {
  equipment.get(idKey(equipmentId)).availableQuantity = 1;
  const firstBooking = bookings[0];
  const secondBooking = makeBooking(new mongoose.Types.ObjectId(), {
    customerId: otherCustomerId,
    startDate: firstBooking.startDate,
    endDate: firstBooking.endDate,
  });
  bookings.push(secondBooking);
  const firstPayment = addPayment({
    bookingId: firstBooking._id,
    customerId: firstBooking.customerId,
    stripeSessionId: "cs_test_concurrent_1",
    checkoutAttemptId: "attempt-concurrent-1",
  });
  const secondPayment = addPayment({
    bookingId: secondBooking._id,
    customerId: secondBooking.customerId,
    stripeSessionId: "cs_test_concurrent_2",
    checkoutAttemptId: "attempt-concurrent-2",
  });
  const [first, second] = await Promise.all([
    sendWebhook(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession(firstPayment, { payment_intent: "pi_concurrent_1" }),
        "evt_concurrent_1",
      ),
    ),
    sendWebhook(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession(secondPayment, { payment_intent: "pi_concurrent_2" }),
        "evt_concurrent_2",
      ),
    ),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(
    bookings.filter((booking) => booking.bookingStatus === "confirmed").length,
    1,
  );
  assert.equal(
    payments.filter((payment) => payment.paymentStatus === "refunded").length,
    1,
  );
  assert.equal(refundCallCount, 1);
});

test("Webhook processing fails closed when MongoDB transactions are unavailable", async () => {
  transactionsSupported = false;
  const payment = addPayment();
  const response = await sendWebhook(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession(payment),
      "evt_no_transactions",
    ),
  );
  assert.equal(response.status, 503);
  assert.equal(payment.paymentStatus, "pending");
  assert.equal(bookings[0].bookingStatus, "pending");
});
