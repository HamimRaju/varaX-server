import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-owner-dashboard-tests";
process.env.STRIPE_SECRET_KEY = "sk_test_varax_owner_dashboard_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_varax_owner_dashboard_tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const ownerId = new mongoose.Types.ObjectId();
const otherOwnerId = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const equipmentIds = {
  approved: new mongoose.Types.ObjectId(),
  pending: new mongoose.Types.ObjectId(),
  rejected: new mongoose.Types.ObjectId(),
  deleted: new mongoose.Types.ObjectId(),
  other: new mongoose.Types.ObjectId(),
};
const userRows = new Map();
let equipmentRows = [];
let bookings = [];
let payments = [];
let apiServer;
let authServer;
let apiBase;
let authBase;
let privateKey;
let keyId;
let tokens;
let models;
let originals;

function key(value) {
  return String(value);
}

function sameId(left, right) {
  return key(left) === key(right);
}

function date(month, day) {
  return new Date(Date.UTC(2026, month - 1, day));
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

function sortRows(rows, sort = { createdAt: -1, _id: -1 }) {
  const [field, direction] = Object.entries(sort)[0];
  return [...rows].sort((left, right) => {
    const a = left[field] instanceof Date ? left[field].getTime() : left[field];
    const b = right[field] instanceof Date ? right[field].getTime() : right[field];
    return (a < b ? -1 : a > b ? 1 : 0) * direction;
  });
}

function makeEquipment(id, name, status, values = {}) {
  return {
    _id: id,
    ownerId,
    name,
    description: `${name} description`,
    category: "Photography Equipment",
    location: "Dhaka",
    price: 100,
    rentalType: "daily",
    availableQuantity: 2,
    image: `https://images.example.test/${name.replaceAll(" ", "-")}.jpg`,
    status,
    isDeleted: false,
    createdAt: date(1, 1),
    updatedAt: date(1, 1),
    ...values,
  };
}

function makeBooking(equipmentId, bookingStatus, paymentStatus, values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    customerId,
    equipmentId,
    startDate: date(5, 10),
    endDate: date(5, 12),
    quantity: 1,
    rentalType: "daily",
    totalAmount: 100,
    bookingStatus,
    paymentStatus,
    createdAt: date(1, 5),
    updatedAt: date(1, 5),
    contactNumber: "01712345678",
    deliveryAddress: "Private customer address",
    additionalNotes: "Private customer note",
    idempotencyKey: "private-idempotency-key",
    stripeSessionId: "cs_private_session",
    ...values,
  };
}

function makePayment(booking, amount, values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    bookingId: booking._id,
    ownerId: booking.ownerId,
    equipmentId: booking.equipmentId,
    customerId: booking.customerId,
    amount,
    amountMinorUnits: amount * 100,
    receivedAmountMinorUnits: amount * 100,
    currency: "bdt",
    receivedCurrency: "bdt",
    paymentStatus: "paid",
    fulfillmentStatus: "fulfilled",
    stripePaymentIntentId: `pi_${Math.random().toString(16).slice(2)}`,
    paidAt: date(1, 10),
    createdAt: date(1, 10),
    stripeSessionId: "cs_private_session",
    ...values,
  };
}

function apiCall(method, path, token, body) {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function getBookingPopulation(row, paths) {
  const result = { ...row };
  if (paths.includes("equipmentId")) {
    const item = equipmentRows.find((entry) => sameId(entry._id, row.equipmentId));
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
  if (paths.includes("customerId")) {
    const customer = userRows.get(key(row.customerId));
    result.customerId = customer
      ? { _id: customer._id, name: customer.name, image: customer.image }
      : null;
  }
  return result;
}

function ownerEquipmentRows(owner) {
  return equipmentRows.filter(
    (item) => sameId(item.ownerId, owner) && item.isDeleted !== true,
  );
}

function isSuccessfulPayment(payment) {
  return (
    payment.paymentStatus === "paid" &&
    ![
      "refunded",
      "refund_pending",
      "refund_required",
      "review_required",
    ].includes(payment.fulfillmentStatus)
  );
}

function getOwnerPayments(owner, pipeline) {
  const ownerBookings = bookings.filter((booking) => sameId(booking.ownerId, owner));
  const dateMatch = pipeline.find((stage) => stage.$match?.earningDate)?.$match
    ?.earningDate;
  const matched = payments
    .filter(
      (payment) =>
        isSuccessfulPayment(payment) &&
        ownerBookings.some((booking) => sameId(booking._id, payment.bookingId)),
    )
    .map((payment) => {
      const booking = ownerBookings.find((row) => sameId(row._id, payment.bookingId));
      return {
        payment,
        booking,
        paidAt: payment.paidAt ?? payment.createdAt,
        amount:
          payment.receivedAmountMinorUnits !== undefined
            ? payment.receivedAmountMinorUnits / 100
            : payment.amountMinorUnits !== undefined
              ? payment.amountMinorUnits / 100
              : payment.amount,
        currency: payment.receivedCurrency ?? payment.currency ?? "bdt",
        key: payment.stripePaymentIntentId ?? key(payment._id),
      };
    })
    .filter(({ paidAt }) => {
      if (!(paidAt instanceof Date)) return false;
      if (dateMatch?.$gte && paidAt < dateMatch.$gte) return false;
      if (dateMatch?.$lt && paidAt >= dateMatch.$lt) return false;
      return true;
    });
  const distinct = new Map();
  for (const row of sortRows(
    matched,
    { paidAt: -1, "_id": -1 },
  )) {
    const current = distinct.get(row.key);
    if (!current || row.amount > current.amount) {
      distinct.set(row.key, row);
    }
  }
  return [...distinct.values()].sort(
    (left, right) => right.paidAt.getTime() - left.paidAt.getTime(),
  );
}

function evaluateOwnerEquipment(pipeline) {
  const match = pipeline[0].$match;
  let rows = equipmentRows.filter(
    (item) =>
      sameId(item.ownerId, match.ownerId) &&
      item.isDeleted !== true &&
      (!match.status || item.status === match.status),
  );
  if (match.name) {
    const regex = new RegExp(match.name.$regex, match.name.$options);
    rows = rows.filter((item) => regex.test(item.name));
  }
  const facet = pipeline[1]?.$facet;
  if (!facet) {
    const result = {
      totalEquipment: rows.length,
      approvedEquipment: rows.filter((row) => row.status === "approved").length,
      pendingEquipment: rows.filter((row) => row.status === "pending").length,
      rejectedEquipment: rows.filter((row) => row.status === "rejected").length,
    };
    return rows.length ? [result] : [];
  }

  const sort = facet.items.find((stage) => stage.$sort)?.$sort;
  const offset = facet.items.find((stage) => "$skip" in stage)?.$skip ?? 0;
  const limit = facet.items.find((stage) => "$limit" in stage)?.$limit ?? 10;
  const items = sortRows(rows, sort)
    .slice(offset, offset + limit)
    .map((item) => {
      const itemBookings = bookings.filter((booking) =>
        sameId(booking.equipmentId, item._id),
      );
      return {
        ...item,
        rentalStats: {
          totalRentalRequests: itemBookings.length,
          pendingRequests: itemBookings.filter(
            (booking) => booking.bookingStatus === "pending",
          ).length,
          confirmedBookings: itemBookings.filter(
            (booking) => booking.bookingStatus === "confirmed",
          ).length,
          activeRentals: itemBookings.filter(
            (booking) => booking.bookingStatus === "active",
          ).length,
          completedRentals: itemBookings.filter(
            (booking) => booking.bookingStatus === "completed",
          ).length,
        },
      };
    });
  return [{
    items,
    metadata: rows.length ? [{ totalItems: rows.length }] : [],
  }];
}

function evaluateBookingAggregate(pipeline) {
  const owner = pipeline[0].$match.ownerId;
  if (pipeline[1]?.$lookup?.from === "payments") {
    const uniquePayments = getOwnerPayments(owner, pipeline);
    if (pipeline.some((stage) => stage.$facet)) {
      const facet = pipeline.at(-1).$facet;
      const amounts = uniquePayments.map((item) => item.amount);
      const months = new Map();
      for (const row of uniquePayments) {
        const month = row.paidAt.toISOString().slice(0, 7);
        months.set(month, (months.get(month) ?? 0) + row.amount);
      }
      const offset =
        facet.recentPayments.find((stage) => "$skip" in stage)?.$skip ?? 0;
      const limit =
        facet.recentPayments.find((stage) => "$limit" in stage)?.$limit ?? 10;
      const recentPayments = uniquePayments
        .slice(offset, offset + limit)
        .map((row) => ({
          paymentId: row.payment._id,
          bookingId: row.booking._id,
          amount: row.amount,
          currency: row.currency,
          paymentStatus: "paid",
          paidAt: row.paidAt,
          equipment: (() => {
            const item = equipmentRows.find((entry) =>
              sameId(entry._id, row.booking.equipmentId),
            );
            return item
              ? { _id: item._id, name: item.name, image: item.image }
              : null;
          })(),
          customer: {
            _id: row.booking.customerId,
            name: userRows.get(key(row.booking.customerId))?.name,
            image: userRows.get(key(row.booking.customerId))?.image,
          },
        }));
      return [{
        summary: amounts.length
          ? [{ totalEarnings: amounts.reduce((total, amount) => total + amount, 0) }]
          : [],
        paidBookings: uniquePayments.length
          ? [{ totalPaidBookings: new Set(uniquePayments.map((row) => key(row.booking._id))).size }]
          : [],
        earningsByMonth: [...months.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([month, amount]) => ({ month, amount })),
        recentPayments,
        metadata: uniquePayments.length
          ? [{ totalItems: uniquePayments.length }]
          : [],
      }];
    }
    const totalEarnings = uniquePayments.reduce(
      (total, row) => total + row.amount,
      0,
    );
    return totalEarnings ? [{ totalEarnings }] : [];
  }

  const ownerBookings = bookings.filter((booking) => sameId(booking.ownerId, owner));
  if (pipeline[1]?.$facet) {
    const stats = {
      totalRentalRequests: ownerBookings.length,
      pendingRequests: ownerBookings.filter((row) => row.bookingStatus === "pending").length,
      confirmedBookings: ownerBookings.filter((row) => row.bookingStatus === "confirmed").length,
      activeRentals: ownerBookings.filter((row) => row.bookingStatus === "active").length,
      completedRentals: ownerBookings.filter((row) => row.bookingStatus === "completed").length,
      cancelledBookings: ownerBookings.filter((row) => row.bookingStatus === "cancelled").length,
      pendingEarnings: ownerBookings
        .filter(
          (row) =>
            row.bookingStatus === "pending" &&
            ["unpaid", "failed"].includes(row.paymentStatus),
        )
        .reduce((total, row) => total + row.totalAmount, 0),
    };
    const recentRentalRequests = sortRows(ownerBookings)
      .slice(0, 5)
      .map((booking) => {
        const item = equipmentRows.find((row) =>
          sameId(row._id, booking.equipmentId),
        );
        const customer = userRows.get(key(booking.customerId));
        return {
          _id: booking._id,
          equipment: item
            ? {
                _id: item._id,
                name: item.name,
                image: item.image,
                category: item.category,
                location: item.location,
              }
            : null,
          customer: customer
            ? { _id: customer._id, name: customer.name, image: customer.image }
            : null,
          startDate: booking.startDate,
          endDate: booking.endDate,
          quantity: booking.quantity,
          rentalType: booking.rentalType,
          totalAmount: booking.totalAmount,
          bookingStatus: booking.bookingStatus,
          paymentStatus: booking.paymentStatus,
          createdAt: booking.createdAt,
        };
      });
    return [{ stats: ownerBookings.length ? [stats] : [], recentRentalRequests }];
  }
  return [];
}

before(async () => {
  let publicJwk;
  authServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise((resolve) =>
    authServer.listen(0, "127.0.0.1", () => resolve()),
  );
  authBase = `http://127.0.0.1:${authServer.address().port}`;
  process.env.CLIENT_URL = authBase;
  process.env.JWT_ISSUER = authBase;
  process.env.JWKS_URL = `${authBase}/api/auth/jwks`;

  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  keyId = "owner-dashboard-test-key";
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: keyId,
    alg: "EdDSA",
    use: "sig",
  };

  const { User } = await import("../dist/models/User.js");
  const { Booking } = await import("../dist/models/Booking.js");
  const { Equipment } = await import("../dist/models/Equipment.js");
  const { Payment } = await import("../dist/models/Payment.js");
  models = { User, Booking, Equipment, Payment };
  originals = {
    userFindById: User.findById,
    userFindOne: User.findOne,
    userFindOneAndUpdate: User.findOneAndUpdate,
    bookingAggregate: Booking.aggregate,
    bookingFind: Booking.find,
    bookingCountDocuments: Booking.countDocuments,
    equipmentAggregate: Equipment.aggregate,
  };

  for (const [id, role, name] of [
    [ownerId, "owner", "Dashboard Owner"],
    [otherOwnerId, "owner", "Other Owner"],
    [customerId, "customer", "Dashboard Customer"],
    [adminId, "admin", "Dashboard Admin"],
  ]) {
    userRows.set(key(id), {
      _id: id,
      name,
      email: `${role}-${key(id).slice(-4)}@example.test`,
      image: "https://images.example.test/profile.jpg",
      phone: "01712345678",
      role,
      isActive: true,
      emailVerified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      password: "secret-hash",
      sessions: ["private-session"],
    });
  }

  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return query(() => userRows.get(key(id)) ?? null);
    },
  });
  Object.defineProperty(User, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() =>
        [...userRows.values()].find(
          (user) =>
            sameId(user._id, filter._id) &&
            user.role === filter.role &&
            user.isActive === filter.isActive,
        ) ?? null,
      );
    },
  });
  Object.defineProperty(User, "findOneAndUpdate", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query(() => {
        const user = userRows.get(key(filter._id));
        if (!user || user.role !== filter.role || user.isActive !== filter.isActive) {
          return null;
        }
        Object.assign(user, update.$set ?? {});
        for (const field of Object.keys(update.$unset ?? {})) delete user[field];
        return user;
      });
    },
  });
  Object.defineProperty(Booking, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateBookingAggregate(pipeline) };
    },
  });
  Object.defineProperty(Booking, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        let rows = bookings.filter(
          (booking) =>
            sameId(booking.ownerId, filter.ownerId) &&
            (!filter.bookingStatus ||
              booking.bookingStatus === filter.bookingStatus),
        );
        rows = sortRows(
          rows,
          builder.sortOrder ?? { createdAt: -1, _id: -1 },
        ).slice(
          builder.offset,
          builder.pageSize === undefined
            ? undefined
            : builder.offset + builder.pageSize,
        );
        return rows.map((row) => getBookingPopulation(row, builder.populates));
      });
    },
  });
  Object.defineProperty(Booking, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(
        () =>
          bookings.filter(
            (booking) =>
              sameId(booking.ownerId, filter.ownerId) &&
              (!filter.bookingStatus ||
                booking.bookingStatus === filter.bookingStatus),
          ).length,
      );
    },
  });
  Object.defineProperty(Equipment, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateOwnerEquipment(pipeline) };
    },
  });

  const sign = (id, role) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: "EdDSA", kid: keyId })
      .setIssuer(authBase)
      .setAudience("varax-api")
      .setSubject(id.toString())
      .setExpirationTime("5m")
      .sign(privateKey);
  tokens = {
    owner: await sign(ownerId, "owner"),
    otherOwner: await sign(otherOwnerId, "owner"),
    customer: await sign(customerId, "customer"),
    admin: await sign(adminId, "admin"),
  };

  const app = (await import("../dist/express-app.js")).default;
  apiServer = createServer(app);
  await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  equipmentRows = [
    makeEquipment(equipmentIds.approved, "Approved Camera", "approved", {
      price: 100,
      createdAt: date(1, 3),
    }),
    makeEquipment(equipmentIds.pending, "Pending Tractor", "pending", {
      price: 300,
      createdAt: date(1, 2),
    }),
    makeEquipment(equipmentIds.rejected, "Rejected Lens", "rejected", {
      price: 200,
      createdAt: date(1, 1),
    }),
    makeEquipment(equipmentIds.deleted, "Deleted Historic Camera", "approved", {
      isDeleted: true,
    }),
    makeEquipment(equipmentIds.other, "Other Owner Camera", "approved", {
      ownerId: otherOwnerId,
    }),
  ];
  bookings = [
    makeBooking(equipmentIds.approved, "pending", "unpaid", {
      totalAmount: 150,
      createdAt: date(6, 1),
    }),
    makeBooking(equipmentIds.approved, "pending", "failed", {
      totalAmount: 50,
      createdAt: date(6, 2),
    }),
    makeBooking(equipmentIds.approved, "confirmed", "paid", {
      totalAmount: 200,
      createdAt: date(6, 3),
    }),
    makeBooking(equipmentIds.pending, "active", "paid", {
      totalAmount: 300,
      createdAt: date(6, 4),
    }),
    makeBooking(equipmentIds.pending, "completed", "paid", {
      totalAmount: 400,
      createdAt: date(6, 5),
    }),
    makeBooking(equipmentIds.rejected, "cancelled", "unpaid", {
      totalAmount: 500,
      createdAt: date(6, 6),
    }),
    makeBooking(equipmentIds.deleted, "rejected", "paid", {
      totalAmount: 600,
      createdAt: date(6, 7),
    }),
    makeBooking(equipmentIds.other, "active", "paid", {
      ownerId: otherOwnerId,
      customerId: customerId,
    }),
  ];
  payments = [
    makePayment(bookings[2], 200, {
      stripePaymentIntentId: "pi_confirmed",
      paidAt: date(1, 10),
    }),
    makePayment(bookings[2], 200, {
      stripePaymentIntentId: "pi_confirmed",
      paidAt: date(1, 10),
    }),
    makePayment(bookings[3], 300, {
      stripePaymentIntentId: "pi_active",
      paidAt: date(2, 10),
    }),
    makePayment(bookings[6], 400, {
      stripePaymentIntentId: "pi_deleted_equipment",
      paidAt: date(3, 10),
    }),
    makePayment(bookings[2], 500, {
      paymentStatus: "pending",
      stripePaymentIntentId: "pi_pending",
    }),
    makePayment(bookings[2], 600, {
      paymentStatus: "failed",
      stripePaymentIntentId: "pi_failed",
    }),
    makePayment(bookings[2], 700, {
      paymentStatus: "refunded",
      fulfillmentStatus: "refunded",
      stripePaymentIntentId: "pi_refunded",
    }),
    makePayment(bookings[2], 800, {
      fulfillmentStatus: "refunded",
      stripePaymentIntentId: "pi_fulfillment_refunded",
    }),
    makePayment(bookings[2], 900, {
      fulfillmentStatus: "refund_pending",
      stripePaymentIntentId: "pi_refund_pending",
    }),
    makePayment(bookings[2], 1000, {
      fulfillmentStatus: "refund_required",
      stripePaymentIntentId: "pi_refund_required",
    }),
    makePayment(bookings[7], 1200, {
      stripePaymentIntentId: "pi_other_owner",
    }),
  ];
});

after(async () => {
  if (originals) {
    Object.defineProperty(models.User, "findById", { configurable: true, writable: true, value: originals.userFindById });
    Object.defineProperty(models.User, "findOne", { configurable: true, writable: true, value: originals.userFindOne });
    Object.defineProperty(models.User, "findOneAndUpdate", { configurable: true, writable: true, value: originals.userFindOneAndUpdate });
    Object.defineProperty(models.Booking, "aggregate", { configurable: true, writable: true, value: originals.bookingAggregate });
    Object.defineProperty(models.Booking, "find", { configurable: true, writable: true, value: originals.bookingFind });
    Object.defineProperty(models.Booking, "countDocuments", { configurable: true, writable: true, value: originals.bookingCountDocuments });
    Object.defineProperty(models.Equipment, "aggregate", { configurable: true, writable: true, value: originals.equipmentAggregate });
  }
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

const dashboardPaths = [
  "/api/owner/dashboard/overview",
  "/api/owner/dashboard/equipment",
  "/api/owner/dashboard/rental-requests",
  "/api/owner/dashboard/earnings",
  "/api/owner/dashboard/profile",
];

test("all owner dashboard APIs require an authenticated owner", async () => {
  for (const path of dashboardPaths) {
    assert.equal((await apiCall("GET", path)).status, 401);
    assert.equal((await apiCall("GET", path, tokens.customer)).status, 403);
    assert.equal((await apiCall("GET", path, tokens.admin)).status, 403);
  }
  assert.equal(
    (await apiCall("PATCH", "/api/owner/dashboard/profile", undefined, { name: "Nope" })).status,
    401,
  );
  assert.equal(
    (await apiCall("PATCH", "/api/owner/dashboard/profile", tokens.customer, { name: "Nope" })).status,
    403,
  );
});

test("owner dashboard list queries have compound owner/sort indexes", () => {
  assert.ok(
    models.Booking.schema.indexes().some(
      ([keys]) =>
        keys.ownerId === 1 &&
        keys.createdAt === -1 &&
        keys._id === -1,
    ),
  );
  assert.ok(
    models.Equipment.schema.indexes().some(
      ([keys]) =>
        keys.ownerId === 1 &&
        keys.isDeleted === 1 &&
        keys.createdAt === -1,
    ),
  );
});

test("overview contains only this owner's counts and latest rental requests", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/dashboard/overview",
    tokens.owner,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(
    {
      totalEquipment: data.totalEquipment,
      approvedEquipment: data.approvedEquipment,
      pendingEquipment: data.pendingEquipment,
      rejectedEquipment: data.rejectedEquipment,
      totalRentalRequests: data.totalRentalRequests,
      pendingRequests: data.pendingRequests,
      confirmedBookings: data.confirmedBookings,
      activeRentals: data.activeRentals,
      completedRentals: data.completedRentals,
      cancelledBookings: data.cancelledBookings,
      pendingEarnings: data.pendingEarnings,
      totalEarnings: data.totalEarnings,
    },
    {
      totalEquipment: 3,
      approvedEquipment: 1,
      pendingEquipment: 1,
      rejectedEquipment: 1,
      totalRentalRequests: 7,
      pendingRequests: 2,
      confirmedBookings: 1,
      activeRentals: 1,
      completedRentals: 1,
      cancelledBookings: 1,
      pendingEarnings: 200,
      totalEarnings: 900,
    },
  );
  assert.equal(data.recentRentalRequests.length, 5);
  assert.equal(data.earningsType, "gross");
  assert.equal(data.recentRentalRequests[0].customer.name, "Dashboard Customer");
  assert.equal("deliveryAddress" in data.recentRentalRequests[0], false);
});

test("equipment endpoint scopes, filters, searches, sorts, and paginates in its aggregation", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/dashboard/equipment?status=approved&search=camera&sort=oldest&page=1&limit=1",
    tokens.owner,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].name, "Approved Camera");
  assert.equal(body.pagination.totalItems, 1);
  assert.equal(body.data[0].rentalStats.totalRentalRequests, 3);
  const sorted = await apiCall(
    "GET",
    "/api/owner/dashboard/equipment?sort=price_asc&page=1&limit=2",
    tokens.owner,
  );
  assert.deepEqual(
    (await sorted.json()).data.map((item) => item.name),
    ["Approved Camera", "Rejected Lens"],
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/owner/dashboard/equipment?status=active",
        tokens.owner,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/owner/dashboard/equipment?sort=price_asc&limit=51",
        tokens.owner,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/owner/dashboard/equipment?page=9007199254740991",
        tokens.owner,
      )
    ).status,
    400,
  );
});

test("rental requests use the existing owner booking query and return safe customer and equipment details", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/dashboard/rental-requests?status=pending&sort=oldest&page=1&limit=1",
    tokens.owner,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].amount, 150);
  assert.equal(body.data[0].bookingStatus, "pending");
  assert.equal(body.data[0].paymentStatus, "unpaid");
  assert.equal(body.data[0].customer.name, "Dashboard Customer");
  assert.equal("email" in body.data[0].customer, false);
  assert.equal("contactNumber" in body.data[0], false);
  assert.equal("deliveryAddress" in body.data[0], false);
  assert.equal("idempotencyKey" in body.data[0], false);
  assert.equal(body.pagination.totalItems, 2);
});

test("earnings include unique successful payments only and preserve deleted-equipment history", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/dashboard/earnings?page=1&limit=10",
    tokens.owner,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const { data, pagination } = body;
  assert.equal(data.totalEarnings, 900);
  assert.equal(data.totalPaidBookings, 3);
  assert.equal(data.earningsType, "gross");
  assert.equal(data.recentPayments.length, 3);
  assert.equal(pagination.totalItems, 3);
  assert.equal(pagination.currentPage, 1);
  assert.equal(
    data.recentPayments.some((payment) => payment.equipment?.name === "Deleted Historic Camera"),
    true,
  );
  assert.equal(JSON.stringify(data).includes("stripeSessionId"), false);
  assert.equal(JSON.stringify(data).includes("stripePaymentIntentId"), false);
});

test("earnings date filters are inclusive by UTC calendar day and validated", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/dashboard/earnings?startDate=2026-02-01&endDate=2026-02-28",
    tokens.owner,
  );
  const { data } = await response.json();
  assert.equal(data.totalEarnings, 300);
  assert.deepEqual(data.earningsByMonth, [{ month: "2026-02", amount: 300 }]);
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/owner/dashboard/earnings?startDate=2026-02-30",
        tokens.owner,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/owner/dashboard/earnings?startDate=2026-03-01&endDate=2026-02-01",
        tokens.owner,
      )
    ).status,
    400,
  );
});

test("profile retrieval and permitted updates exclude authentication fields", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/dashboard/profile",
    tokens.owner,
  );
  assert.equal(response.status, 200);
  const original = await response.json();
  assert.equal(original.data.email, "owner-".concat(key(ownerId).slice(-4), "@example.test"));
  assert.equal("password" in original.data, false);
  assert.equal("emailVerified" in original.data, false);
  assert.equal("sessions" in original.data, false);

  const update = await apiCall(
    "PATCH",
    "/api/owner/dashboard/profile",
    tokens.owner,
    {
      name: "Updated Owner",
      image: "https://images.example.test/updated.png",
      phone: "+8801712345678",
    },
  );
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.data.name, "Updated Owner");
  assert.equal(updated.data.phone, "+8801712345678");
  for (const protectedField of [
    "role",
    "isActive",
    "emailVerified",
    "email",
    "id",
    "_id",
    "password",
  ]) {
    assert.equal(
      (
        await apiCall(
          "PATCH",
          "/api/owner/dashboard/profile",
          tokens.owner,
          { [protectedField]: "tamper" },
        )
      ).status,
      400,
    );
  }
});

test("other owners cannot read this owner's equipment, requests, or earnings", async () => {
  const overviewResponse = await apiCall(
    "GET",
    "/api/owner/dashboard/overview",
    tokens.otherOwner,
  );
  const overview = (await overviewResponse.json()).data;
  assert.equal(overview.totalEquipment, 1);
  assert.equal(overview.totalRentalRequests, 1);
  assert.equal(overview.totalEarnings, 1200);

  const equipmentResponse = await apiCall(
    "GET",
    "/api/owner/dashboard/equipment",
    tokens.otherOwner,
  );
  assert.equal(equipmentResponse.status, 200);
  const equipmentBody = await equipmentResponse.json();
  assert.deepEqual(equipmentBody.data.map((item) => item.name), ["Other Owner Camera"]);

  const requestsResponse = await apiCall(
    "GET",
    "/api/owner/dashboard/rental-requests",
    tokens.otherOwner,
  );
  assert.deepEqual((await requestsResponse.json()).data.map((item) => item.equipment?.name), [
    "Other Owner Camera",
  ]);

  const earningsResponse = await apiCall(
    "GET",
    "/api/owner/dashboard/earnings",
    tokens.otherOwner,
  );
  assert.equal((await earningsResponse.json()).data.totalEarnings, 1200);
});

test("empty owner dashboard returns zeroed counters, empty lists, and valid pagination", async () => {
  equipmentRows = [];
  bookings = [];
  payments = [];
  const overview = await apiCall(
    "GET",
    "/api/owner/dashboard/overview",
    tokens.owner,
  );
  const overviewData = (await overview.json()).data;
  assert.equal(overviewData.totalEquipment, 0);
  assert.equal(overviewData.totalRentalRequests, 0);
  assert.equal(overviewData.totalEarnings, 0);
  assert.deepEqual(overviewData.recentRentalRequests, []);

  const equipmentResponse = await apiCall(
    "GET",
    "/api/owner/dashboard/equipment",
    tokens.owner,
  );
  const equipmentData = await equipmentResponse.json();
  assert.deepEqual(equipmentData.data, []);
  assert.equal(equipmentData.pagination.totalPages, 0);

  const earningsResponse = await apiCall(
    "GET",
    "/api/owner/dashboard/earnings",
    tokens.owner,
  );
  const earningsData = (await earningsResponse.json()).data;
  assert.equal(earningsData.totalEarnings, 0);
  assert.deepEqual(earningsData.recentPayments, []);
});
