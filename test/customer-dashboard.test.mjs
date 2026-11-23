import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-customer-dashboard-tests";
process.env.STRIPE_SECRET_KEY = "sk_test_varax_dashboard_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_varax_dashboard_tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const customerId = new mongoose.Types.ObjectId();
const otherCustomerId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const equipmentId = new mongoose.Types.ObjectId();
const otherEquipmentId = new mongoose.Types.ObjectId();

const users = new Map();
const equipment = new Map();
let bookings = [];
let payments = [];
let favorites = [];
let apiServer;
let authServer;
let apiBase;
let authBase;
let privateKey;
let keyId;
let tokens;
let models;
let restoreMethods;
let overviewPipeline;
let activityPipeline;

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
      return expected.$in.some((value) => sameId(actual, value));
    }
    if ("$ne" in expected && sameId(actual, expected.$ne)) return false;
    if ("$exists" in expected && Boolean(actual !== undefined) !== expected.$exists) {
      return false;
    }
    return true;
  }
  return sameId(actual, expected);
}

function matchesFilter(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") {
      return expected.some((condition) => matchesFilter(row, condition));
    }
    if (field === "$and") {
      return expected.every((condition) => matchesFilter(row, condition));
    }
    return matchesValue(row[field], expected);
  });
}

function query(execute) {
  return {
    populates: [],
    sortOrder: undefined,
    offset: 0,
    pageSize: undefined,
    populate(path) {
      this.populates.push(typeof path === "string" ? path : path.path);
      return this;
    },
    select() {
      return this;
    },
    sort(value) {
      this.sortOrder = value;
      return this;
    },
    skip(value) {
      this.offset = value;
      return this;
    },
    limit(value) {
      this.pageSize = value;
      return this;
    },
    lean() {
      return this;
    },
    async exec() {
      return execute(this);
    },
  };
}

function dateOffset(days) {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function makeBooking(values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    customerId,
    ownerId,
    equipmentId,
    startDate: dateOffset(5),
    endDate: dateOffset(7),
    quantity: 1,
    contactNumber: "01712345678",
    deliveryAddress: "Dhaka, Bangladesh",
    additionalNotes: "",
    rentalType: "daily",
    unitPrice: 100,
    rentalDuration: 2,
    subtotal: 200,
    totalAmount: 200,
    bookingStatus: "pending",
    paymentStatus: "unpaid",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...values,
  };
}

function makePayment(values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    bookingId: bookings[0]?._id,
    customerId,
    ownerId,
    equipmentId,
    stripeSessionId: `cs_test_${Math.random().toString(16).slice(2)}`,
    amount: 200,
    amountMinorUnits: 20000,
    currency: "bdt",
    paymentStatus: "paid",
    fulfillmentStatus: "fulfilled",
    stripePaymentIntentId: undefined,
    paidAt: new Date(),
    paymentMethod: "card",
    createdAt: new Date(),
    ...values,
  };
}

function makeFavorite(values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: customerId,
    customerId,
    equipmentId,
    createdAt: new Date(),
    ...values,
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

function sortRows(rows, sort) {
  const [field, direction] = Object.entries(sort ?? { createdAt: -1 })[0];
  return [...rows].sort((left, right) => {
    const leftValue = left[field] instanceof Date
      ? left[field].getTime()
      : left[field];
    const rightValue = right[field] instanceof Date
      ? right[field].getTime()
      : right[field];
    return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) *
      direction;
  });
}

function populateBooking(row, paths) {
  const result = { ...row };
  if (paths.includes("equipmentId")) {
    const item = equipment.get(idKey(result.equipmentId));
    result.equipmentId = item
      ? {
          _id: item._id,
          name: item.name,
          image: item.image,
          category: item.category,
          location: item.location,
          rentalType: item.rentalType,
          price: item.price,
          availableQuantity: item.availableQuantity,
        }
      : null;
  }
  if (paths.includes("ownerId")) {
    const owner = users.get(idKey(result.ownerId));
    result.ownerId = owner
      ? { _id: owner._id, name: owner.name, image: owner.image }
      : null;
  }
  return result;
}

function overviewAggregateRows(customer) {
  const customerBookings = bookings.filter((booking) =>
    sameId(booking.customerId, customer),
  );
  const count = (status) =>
    customerBookings.filter((booking) => booking.bookingStatus === status).length;
  const recentBookings = sortRows(customerBookings, {
    createdAt: -1,
    _id: -1,
  })
    .slice(0, 5)
    .map((booking) => {
      const item = equipment.get(idKey(booking.equipmentId));
      return {
        _id: booking._id,
        equipmentId: item
          ? {
              _id: item._id,
              name: item.name,
              image: item.image,
              category: item.category,
              location: item.location,
            }
          : null,
        startDate: booking.startDate,
        endDate: booking.endDate,
        quantity: booking.quantity,
        totalAmount: booking.totalAmount,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        createdAt: booking.createdAt,
      };
    });
  return [{
    stats: [{
      totalBookings: customerBookings.length,
      pendingBookings: count("pending"),
      confirmedBookings: count("confirmed"),
      activeRentals: count("active"),
      completedRentals: count("completed"),
      cancelledBookings: count("cancelled"),
    }],
    recentBookings,
  }];
}

function activityAggregateRows(customer, pipeline) {
  const bookingEvents = bookings
    .filter(
      (booking) =>
        sameId(booking.customerId, customer) &&
        booking.createdAt instanceof Date,
    )
    .map((booking) => ({
      _id: booking._id,
      type: "booking_created",
      timestamp: booking.createdAt,
      bookingId: booking._id,
      equipment: equipment.get(idKey(booking.equipmentId)) ?? null,
      booking: {
        startDate: booking.startDate,
        endDate: booking.endDate,
        quantity: booking.quantity,
        totalAmount: booking.totalAmount,
      },
      payment: null,
    }));
  const successful = payments.filter(
    (payment) =>
      sameId(payment.customerId, customer) &&
      bookings.some(
        (booking) =>
          sameId(booking._id, payment.bookingId) &&
          sameId(booking.customerId, customer),
      ) &&
      payment.paymentStatus === "paid" &&
      payment.fulfillmentStatus !== "refunded" &&
      payment.paidAt instanceof Date,
  );
  const latestPaymentPerIntent = new Map();
  for (const payment of successful) {
    const key = payment.stripePaymentIntentId ?? idKey(payment._id);
    if (!latestPaymentPerIntent.has(key)) {
      latestPaymentPerIntent.set(key, payment);
    }
  }
  const paymentEvents = [...latestPaymentPerIntent.values()].map((payment) => {
    const booking = bookings.find((item) => sameId(item._id, payment.bookingId));
    return {
      _id: payment._id,
      type: "payment_completed",
      timestamp: payment.paidAt,
      bookingId: payment.bookingId,
      equipment: booking
        ? equipment.get(idKey(booking.equipmentId)) ?? null
        : null,
      booking: booking
        ? {
            startDate: booking.startDate,
            endDate: booking.endDate,
            quantity: booking.quantity,
            totalAmount: booking.totalAmount,
          }
        : null,
      payment: {
        amount: payment.amount,
        currency: payment.currency,
        status: "paid",
      },
    };
  });
  const all = [...bookingEvents, ...paymentEvents].sort(
    (left, right) =>
      right.timestamp.getTime() - left.timestamp.getTime() ||
      idKey(right._id).localeCompare(idKey(left._id)),
  );
  const itemsFacet = pipeline.at(-1).$facet.items;
  const offset = itemsFacet.find((stage) => "$skip" in stage).$skip;
  const limit = itemsFacet.find((stage) => "$limit" in stage).$limit;
  const page = all.slice(offset, offset + limit);
  return [{
    items: page,
    metadata: all.length ? [{ totalItems: all.length }] : [],
  }];
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
  keyId = "customer-dashboard-test-key";
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: keyId,
    alg: "EdDSA",
    use: "sig",
  };

  const { User } = await import("../dist/models/User.js");
  const { Booking } = await import("../dist/models/Booking.js");
  const { Payment } = await import("../dist/models/Payment.js");
  const { Favorite } = await import("../dist/models/Favorite.js");
  models = { User, Booking, Payment, Favorite };

  for (const [id, role, name] of [
    [customerId, "customer", "Dashboard Customer"],
    [otherCustomerId, "customer", "Other Customer"],
    [ownerId, "owner", "Dashboard Owner"],
    [adminId, "admin", "Dashboard Admin"],
  ]) {
    users.set(idKey(id), {
      _id: id,
      name,
      email: `${role}-${idKey(id).slice(-4)}@example.test`,
      image: "https://images.example.test/profile.jpg",
      phone: "01712345678",
      role,
      isActive: true,
      emailVerified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const originals = {
    userFindById: User.findById,
    userFindOne: User.findOne,
    userFindOneAndUpdate: User.findOneAndUpdate,
    bookingAggregate: Booking.aggregate,
    bookingFind: Booking.find,
    bookingCountDocuments: Booking.countDocuments,
    paymentAggregate: Payment.aggregate,
    paymentFind: Payment.find,
    favoriteAggregate: Favorite.aggregate,
    favoriteCountDocuments: Favorite.countDocuments,
  };

  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return query(() => users.get(idKey(id)) ?? null);
    },
  });
  Object.defineProperty(User, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() => [...users.values()].find((user) => matchesFilter(user, filter)) ?? null);
    },
  });
  Object.defineProperty(User, "findOneAndUpdate", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query(() => {
        const user = users.get(idKey(filter._id));
        if (!user || !matchesFilter(user, filter)) return null;
        Object.assign(user, update.$set ?? {});
        for (const key of Object.keys(update.$unset ?? {})) delete user[key];
        return user;
      });
    },
  });

  Object.defineProperty(Booking, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return {
        async exec() {
          if (pipeline.some((stage) => stage.$unionWith)) {
            activityPipeline = pipeline;
            return activityAggregateRows(pipeline[0].$match.customerId, pipeline);
          }
          overviewPipeline = pipeline;
          return overviewAggregateRows(pipeline[0].$match.customerId);
        },
      };
    },
  });
  Object.defineProperty(Booking, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        const rows = sortRows(
          bookings.filter((booking) => matchesFilter(booking, filter)),
          builder.sortOrder,
        ).slice(
          builder.offset,
          builder.pageSize === undefined
            ? undefined
            : builder.offset + builder.pageSize,
        );
        return rows.map((row) => populateBooking(row, builder.populates));
      });
    },
  });
  Object.defineProperty(Booking, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() => bookings.filter((booking) => matchesFilter(booking, filter)).length);
    },
  });

  Object.defineProperty(Payment, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return {
        async exec() {
          const filter = pipeline[0].$match;
          const paid = payments.filter(
            (payment) =>
              matchesFilter(payment, filter) &&
              bookings.some(
                (booking) =>
                  sameId(booking._id, payment.bookingId) &&
                  sameId(booking.customerId, filter.customerId),
              ),
          );
          const distinct = new Map();
          for (const payment of paid) {
            const key = payment.stripePaymentIntentId ?? idKey(payment._id);
            distinct.set(key, Math.max(distinct.get(key) ?? 0, payment.amount));
          }
          const totalSpent = [...distinct.values()].reduce((sum, amount) => sum + amount, 0);
          return totalSpent ? [{ totalSpent }] : [];
        },
      };
    },
  });
  Object.defineProperty(Payment, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) =>
        sortRows(
          payments.filter((payment) => matchesFilter(payment, filter)),
          builder.sortOrder,
        ).slice(
          builder.offset,
          builder.pageSize === undefined
            ? undefined
            : builder.offset + builder.pageSize,
        ),
      );
    },
  });

  Object.defineProperty(Favorite, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return {
        async exec() {
          const userId = pipeline[0].$match.$or[0].userId ??
            pipeline[0].$match.$or[1].customerId;
          const matched = favorites
            .filter(
              (favorite) =>
                sameId(favorite.userId, userId) ||
                sameId(favorite.customerId, userId),
            )
            .map((favorite) => ({
              favorite,
              item: equipment.get(idKey(favorite.equipmentId)),
            }))
            .filter(
              ({ item }) => item?.status === "approved" && item.isDeleted === false,
            )
            .sort(
              (left, right) =>
                right.favorite.createdAt.getTime() -
                left.favorite.createdAt.getTime(),
            );
          const facet = pipeline.at(-1).$facet;
          const offset = facet.items.find((stage) => "$skip" in stage).$skip;
          const limit = facet.items.find((stage) => "$limit" in stage).$limit;
          const items = matched.slice(offset, offset + limit).map(({ favorite, item }) => ({
            _id: favorite._id,
            createdAt: favorite.createdAt,
            equipmentId: {
              _id: item._id,
              name: item.name,
              image: item.image,
              category: item.category,
              location: item.location,
              price: item.price,
              rentalType: item.rentalType,
              availableQuantity: item.availableQuantity,
              available: item.availableQuantity > 0,
            },
          }));
          return [{
            items,
            metadata: matched.length ? [{ totalItems: matched.length }] : [],
          }];
        },
      };
    },
  });
  Object.defineProperty(Favorite, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      const userId =
        filter.$or?.[0]?.userId ?? filter.$or?.[1]?.customerId;
      return query(
        () =>
          favorites.filter(
            (favorite) =>
              sameId(favorite.userId, userId) ||
              sameId(favorite.customerId, userId),
          ).length,
      );
    },
  });

  restoreMethods = () => {
    const restore = (model, key, value) =>
      Object.defineProperty(model, key, {
        configurable: true,
        writable: true,
        value,
      });
    restore(User, "findById", originals.userFindById);
    restore(User, "findOne", originals.userFindOne);
    restore(User, "findOneAndUpdate", originals.userFindOneAndUpdate);
    restore(Booking, "aggregate", originals.bookingAggregate);
    restore(Booking, "find", originals.bookingFind);
    restore(Booking, "countDocuments", originals.bookingCountDocuments);
    restore(Payment, "aggregate", originals.paymentAggregate);
    restore(Payment, "find", originals.paymentFind);
    restore(Favorite, "aggregate", originals.favoriteAggregate);
    restore(Favorite, "countDocuments", originals.favoriteCountDocuments);
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
    admin: await sign(adminId, "admin"),
  };

  const app = (await import("../dist/express-app.js")).default;
  apiServer = createServer(app);
  apiBase = await listen(apiServer);
});

beforeEach(() => {
  bookings = [];
  payments = [];
  favorites = [];
  overviewPipeline = undefined;
  activityPipeline = undefined;
  equipment.clear();
  equipment.set(idKey(equipmentId), {
    _id: equipmentId,
    name: "Approved camera",
    image: "https://images.example.test/camera.jpg",
    category: "Photography Equipment",
    location: "Dhaka",
    price: 100,
    rentalType: "daily",
    availableQuantity: 2,
    status: "approved",
    isDeleted: false,
  });
  equipment.set(idKey(otherEquipmentId), {
    _id: otherEquipmentId,
    name: "Pending tractor",
    image: "https://images.example.test/tractor.jpg",
    category: "Agriculture Equipment",
    location: "Gazipur",
    price: 500,
    rentalType: "weekly",
    availableQuantity: 1,
    status: "pending",
    isDeleted: false,
  });
});

after(async () => {
  restoreMethods?.();
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

test("dashboard list and spending queries have supporting indexes", () => {
  assert.ok(
    models.Booking.schema.indexes().some(
      ([keys]) =>
        keys.customerId === 1 &&
        keys.createdAt === -1 &&
        keys._id === -1,
    ),
  );
  assert.ok(
    models.Payment.schema.indexes().some(
      ([keys]) =>
        keys.customerId === 1 &&
        keys.paymentStatus === 1 &&
        keys.paidAt === -1,
    ),
  );
});

test("all customer dashboard endpoints require customer authentication", async () => {
  const paths = [
    "/api/customer/dashboard/overview",
    "/api/customer/dashboard/bookings",
    "/api/customer/dashboard/favorites",
    "/api/customer/dashboard/profile",
    "/api/customer/dashboard/activity",
  ];
  for (const path of paths) {
    assert.equal((await apiCall("GET", path)).status, 401);
    assert.equal((await apiCall("GET", path, tokens.owner)).status, 403);
    assert.equal((await apiCall("GET", path, tokens.admin)).status, 403);
  }
  assert.equal(
    (
      await apiCall(
        "PATCH",
        "/api/customer/dashboard/profile",
        undefined,
        { name: "Unauthenticated" },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await apiCall(
        "PATCH",
        "/api/customer/dashboard/profile",
        tokens.owner,
        { name: "Not a customer" },
      )
    ).status,
    403,
  );
});

test("overview statistics are customer-scoped and use only unique paid spending", async () => {
  const statuses = [
    "pending",
    "confirmed",
    "active",
    "completed",
    "cancelled",
    "rejected",
  ];
  for (const [index, status] of statuses.entries()) {
    bookings.push(
      makeBooking({
        bookingStatus: status,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      }),
    );
  }
  bookings.push(makeBooking({ customerId: otherCustomerId }));
  payments = [
    makePayment({ amount: 120, stripePaymentIntentId: "pi_once" }),
    makePayment({ amount: 120, stripePaymentIntentId: "pi_once" }),
    makePayment({ amount: 35, stripePaymentIntentId: "pi_twice" }),
    makePayment({
      amount: 500,
      paymentStatus: "pending",
      stripePaymentIntentId: "pi_pending",
    }),
    makePayment({
      amount: 600,
      paymentStatus: "failed",
      stripePaymentIntentId: "pi_failed",
    }),
    makePayment({
      amount: 700,
      paymentStatus: "refunded",
      stripePaymentIntentId: "pi_refunded",
    }),
    makePayment({
      amount: 800,
      paymentStatus: "paid",
      fulfillmentStatus: "refunded",
      stripePaymentIntentId: "pi_fulfillment_refunded",
    }),
    makePayment({
      amount: 900,
      customerId: otherCustomerId,
      stripePaymentIntentId: "pi_other_customer",
    }),
    makePayment({
      amount: 950,
      bookingId: bookings.find(
        (booking) => sameId(booking.customerId, otherCustomerId),
      )._id,
      stripePaymentIntentId: "pi_mismatched_customer_record",
    }),
  ];
  favorites = [
    makeFavorite(),
    makeFavorite({
      userId: customerId,
      customerId: undefined,
      equipmentId: otherEquipmentId,
    }),
    makeFavorite({ customerId: otherCustomerId, userId: undefined }),
  ];

  const response = await apiCall(
    "GET",
    "/api/customer/dashboard/overview",
    tokens.customer,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(
    {
      totalBookings: data.totalBookings,
      pendingBookings: data.pendingBookings,
      confirmedBookings: data.confirmedBookings,
      activeRentals: data.activeRentals,
      completedRentals: data.completedRentals,
      cancelledBookings: data.cancelledBookings,
      totalFavorites: data.totalFavorites,
      totalSpent: data.totalSpent,
    },
    {
      totalBookings: 6,
      pendingBookings: 1,
      confirmedBookings: 1,
      activeRentals: 1,
      completedRentals: 1,
      cancelledBookings: 1,
      totalFavorites: 1,
      totalSpent: 155,
    },
  );
  assert.equal(data.recentBookings.length, 5);
  assert.ok(data.recentBookings.every((booking) => booking.equipmentId.name === "Approved camera"));
  assert.ok(overviewPipeline[0].$match.customerId.equals(customerId));
  assert.equal(overviewPipeline[1].$facet.recentBookings[1].$limit, 5);
});

test("empty overview returns zero values and an empty recent list", async () => {
  const response = await apiCall(
    "GET",
    "/api/customer/dashboard/overview",
    tokens.customer,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.totalBookings, 0);
  assert.equal(data.totalFavorites, 0);
  assert.equal(data.totalSpent, 0);
  assert.deepEqual(data.recentBookings, []);
});

test("booking history filters, sorting, pagination, equipment, and safe payment summaries work", async () => {
  const seed = [];
  for (let index = 0; index < 12; index += 1) {
    seed.push(
      makeBooking({
        bookingStatus: index % 2 ? "pending" : "confirmed",
        paymentStatus: index % 2 ? "unpaid" : "paid",
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      }),
    );
  }
  bookings = [
    ...seed,
    makeBooking({
      customerId: otherCustomerId,
      bookingStatus: "confirmed",
      paymentStatus: "paid",
    }),
  ];
  payments = [
    makePayment({
      bookingId: seed[0]._id,
      paymentStatus: "paid",
      amount: 200,
      stripeSessionId: "cs_safe_summary",
      stripePaymentIntentId: "pi_safe_summary",
    }),
  ];
  const response = await apiCall(
    "GET",
    "/api/customer/dashboard/bookings?status=confirmed&paymentStatus=paid&page=2&limit=2&sort=oldest",
    tokens.customer,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 2);
  assert.ok(body.data.every((booking) => booking.status === "confirmed"));
  assert.ok(body.data.every((booking) => booking.paymentStatus === "paid"));
  assert.ok(body.data.every((booking) => booking.customerId.toString() === customerId.toString()));
  assert.ok(body.data.every((booking) => booking.equipmentId.name === "Approved camera"));
  assert.ok(body.data.every((booking) => booking.paymentSummary));
  assert.equal("stripeSessionId" in body.data[0].paymentSummary, false);
  assert.equal(body.pagination.totalItems, 6);
  assert.equal(body.pagination.currentPage, 2);
  assert.equal(body.pagination.limit, 2);
  assert.equal(body.pagination.hasPrevPage, true);
  assert.equal(body.pagination.hasNextPage, true);
});

test("booking history validates filters and pagination", async () => {
  for (const queryString of [
    "page=0",
    "limit=51",
    "status=made-up",
    "paymentStatus=paid%26role=admin",
    "sort=oldest%26status=confirmed",
  ]) {
    assert.equal(
      (
        await apiCall(
          "GET",
          `/api/customer/dashboard/bookings?${queryString}`,
          tokens.customer,
        )
      ).status,
      400,
    );
  }
});

test("favorites use the existing service query and exclude unapproved or deleted equipment", async () => {
  favorites = [
    makeFavorite(),
    makeFavorite({
      userId: undefined,
      customerId,
      equipmentId: otherEquipmentId,
    }),
    makeFavorite({
      customerId: otherCustomerId,
      userId: undefined,
      equipmentId,
    }),
  ];
  const response = await apiCall(
    "GET",
    "/api/customer/dashboard/favorites?page=1&limit=2",
    tokens.customer,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].equipmentId.name, "Approved camera");
  assert.equal(body.pagination.totalItems, 1);
});

test("profile reads only safe customer fields", async () => {
  const response = await apiCall(
    "GET",
    "/api/customer/dashboard/profile",
    tokens.customer,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.id, customerId.toString());
  assert.equal(data.email, users.get(idKey(customerId)).email);
  assert.equal(data.role, "customer");
  assert.equal("emailVerified" in data, false);
  assert.equal("isActive" in data, false);
  assert.equal("password" in data, false);
});

test("customers can update name, image, phone, and address without altering Better Auth protected fields", async () => {
  const response = await apiCall(
    "PATCH",
    "/api/customer/dashboard/profile",
    tokens.customer,
    {
      name: "Updated Customer",
      image: "https://images.example.test/new-profile.jpg",
      phone: "+8801712345678",
      address: "House 12, Dhaka",
    },
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.name, "Updated Customer");
  assert.equal(data.image, "https://images.example.test/new-profile.jpg");
  assert.equal(data.phone, "+8801712345678");
  assert.equal(data.address, "House 12, Dhaka");
  assert.equal(data.role, "customer");
  assert.equal(data.emailVerified, undefined);
});

test("profile updates reject role, email, status, IDs, and invalid values", async () => {
  for (const body of [
    { role: "admin" },
    { email: "new@example.test" },
    { emailVerified: true },
    { isActive: false },
    { id: otherCustomerId.toString() },
    { _id: otherCustomerId.toString() },
    { name: " " },
    { phone: "bad number!" },
    { image: "javascript:alert(1)" },
    { image: "https://user:pass@images.example.test/avatar.jpg" },
  ]) {
    assert.equal(
      (
        await apiCall(
          "PATCH",
          "/api/customer/dashboard/profile",
          tokens.customer,
          body,
        )
      ).status,
      400,
    );
  }
  assert.equal(users.get(idKey(customerId)).role, "customer");
  assert.equal(users.get(idKey(customerId)).emailVerified, true);
});

test("activity feed includes only real booking creation and paid timestamps", async () => {
  const ownBooking = makeBooking({
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    bookingStatus: "completed",
    updatedAt: new Date("2026-04-01T10:00:00.000Z"),
  });
  const otherBooking = makeBooking({
    customerId: otherCustomerId,
    createdAt: new Date("2026-03-02T10:00:00.000Z"),
  });
  const bookingWithoutCreationTimestamp = makeBooking({
    createdAt: undefined,
    updatedAt: new Date("2026-04-01T10:00:00.000Z"),
  });
  bookings = [ownBooking, otherBooking, bookingWithoutCreationTimestamp];
  payments = [
    makePayment({
      bookingId: ownBooking._id,
      paidAt: new Date("2026-03-03T10:00:00.000Z"),
      stripePaymentIntentId: "pi_activity",
      amount: 200,
    }),
    makePayment({
      bookingId: ownBooking._id,
      paidAt: new Date("2026-03-03T10:00:00.000Z"),
      stripePaymentIntentId: "pi_activity",
      amount: 200,
    }),
    makePayment({
      customerId: otherCustomerId,
      bookingId: otherBooking._id,
      stripePaymentIntentId: "pi_other",
      paidAt: new Date("2026-03-04T10:00:00.000Z"),
    }),
    makePayment({
      customerId,
      bookingId: otherBooking._id,
      stripePaymentIntentId: "pi_mismatched_booking_owner",
      paidAt: new Date("2026-03-04T10:00:00.000Z"),
    }),
    makePayment({
      bookingId: ownBooking._id,
      paymentStatus: "refunded",
      stripePaymentIntentId: "pi_refunded",
      paidAt: new Date("2026-03-05T10:00:00.000Z"),
    }),
  ];
  const response = await apiCall(
    "GET",
    "/api/customer/dashboard/activity?page=1&limit=10",
    tokens.customer,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.data.map((event) => event.type).sort(),
    ["booking_created", "payment_completed"].sort(),
  );
  assert.ok(body.data.every((event) => event.bookingId.toString() === ownBooking._id.toString()));
  assert.ok(
    body.data.every(
      (event) =>
        event.type === "booking_created" ||
        event.type === "payment_completed",
    ),
  );
  assert.ok(
    activityPipeline.some(
      (stage) =>
        stage.$unionWith?.coll === "payments" &&
        stage.$unionWith.pipeline.some(
          (paymentStage) =>
            paymentStage.$match?.paymentStatus === "paid" &&
            paymentStage.$match?.paidAt?.$type === "date",
      ),
    ),
  );
  assert.equal(activityPipeline[0].$match.createdAt.$type, "date");
});

test("activity pagination and empty dashboards return consistent metadata", async () => {
  const empty = await apiCall(
    "GET",
    "/api/customer/dashboard/activity",
    tokens.customer,
  );
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json();
  assert.deepEqual(emptyBody.data, []);
  assert.deepEqual(emptyBody.pagination, {
    currentPage: 1,
    totalPages: 0,
    totalItems: 0,
    limit: 10,
    hasNextPage: false,
    hasPrevPage: false,
  });

  for (const path of [
    "/api/customer/dashboard/activity?page=0",
    "/api/customer/dashboard/favorites?limit=100",
  ]) {
    assert.equal(
      (await apiCall("GET", path, tokens.customer)).status,
      400,
    );
  }
});
