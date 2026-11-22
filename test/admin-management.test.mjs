import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-admin-management-tests";
process.env.STRIPE_SECRET_KEY = "sk_test_varax_admin_management_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_varax_admin_management_tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const ids = {
  admin: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  otherCustomer: new mongoose.Types.ObjectId(),
  inactive: new mongoose.Types.ObjectId(),
  invalidRole: new mongoose.Types.ObjectId(),
  approvedEquipment: new mongoose.Types.ObjectId(),
  pendingEquipment: new mongoose.Types.ObjectId(),
  rejectedEquipment: new mongoose.Types.ObjectId(),
  deletedEquipment: new mongoose.Types.ObjectId(),
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

function sameId(left, right) {
  return String(left) === String(right);
}

function at(month, day) {
  return new Date(Date.UTC(2026, month - 1, day));
}

function project(row, selection) {
  if (!row || !selection) return row;
  const fields = selection.split(/\s+/).filter(Boolean);
  return Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]]));
}

function query(execute) {
  return {
    projection: undefined,
    populations: [],
    sortSpec: undefined,
    offset: 0,
    pageSize: undefined,
    select(selection) {
      this.projection = selection;
      return this;
    },
    populate(path) {
      this.populations.push(typeof path === "string" ? path : path.path);
      return this;
    },
    sort(value) {
      this.sortSpec = value;
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

function sortRows(rows, spec = { createdAt: -1, _id: -1 }) {
  const [field, direction] = Object.entries(spec)[0];
  return [...rows].sort((left, right) => {
    const a = left[field] instanceof Date ? left[field].getTime() : left[field];
    const b = right[field] instanceof Date ? right[field].getTime() : right[field];
    return (a < b ? -1 : a > b ? 1 : 0) * direction;
  });
}

function makeUser(id, role, name, values = {}) {
  return {
    _id: id,
    role,
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.test`,
    image: `https://images.example.test/${name.replaceAll(" ", "-")}.jpg`,
    phone: "01712345678",
    isActive: true,
    emailVerified: true,
    createdAt: at(1, 1),
    password: "private-password-hash",
    sessions: [{ token: "private-session-token" }],
    ...values,
  };
}

function makeEquipment(id, ownerId, name, status, values = {}) {
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
    createdAt: at(1, 1),
    updatedAt: at(1, 1),
    ...values,
  };
}

function makeBooking(equipmentId, status, paymentStatus, values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    customerId: ids.customer,
    ownerId: ids.owner,
    equipmentId,
    startDate: at(5, 10),
    endDate: at(5, 12),
    quantity: 1,
    rentalType: "daily",
    unitPrice: 100,
    rentalDuration: 2,
    subtotal: 200,
    totalAmount: 200,
    bookingStatus: status,
    paymentStatus,
    createdAt: at(6, 1),
    updatedAt: at(6, 1),
    contactNumber: "private-contact",
    deliveryAddress: "private-address",
    additionalNotes: "private-notes",
    stripeSessionId: "cs_private",
    idempotencyKey: "private-key",
    ...values,
  };
}

function makePayment(booking, amount, values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    bookingId: booking._id,
    customerId: booking.customerId,
    ownerId: booking.ownerId,
    equipmentId: booking.equipmentId,
    amount,
    amountMinorUnits: amount * 100,
    receivedAmountMinorUnits: amount * 100,
    currency: "bdt",
    receivedCurrency: "bdt",
    paymentStatus: "paid",
    fulfillmentStatus: "fulfilled",
    stripeSessionId: "cs_private_session",
    stripePaymentIntentId: `pi_${Math.random().toString(16).slice(2)}`,
    paidAt: at(1, 12),
    createdAt: at(1, 12),
    stripeEventIds: ["evt_private"],
    checkoutUrl: "https://checkout.stripe.com/private",
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

function safeUser(user) {
  if (!user) return null;
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role,
  };
}

function safeEquipment(item) {
  if (!item) return null;
  return {
    _id: item._id,
    name: item.name,
    image: item.image,
    category: item.category,
    location: item.location,
  };
}

function safeBooking(booking) {
  const customer = userRows.get(String(booking.customerId));
  const owner = userRows.get(String(booking.ownerId));
  const equipment = equipmentRows.find((item) =>
    sameId(item._id, booking.equipmentId),
  );
  return {
    _id: booking._id,
    startDate: booking.startDate,
    endDate: booking.endDate,
    quantity: booking.quantity,
    rentalType: booking.rentalType,
    unitPrice: booking.unitPrice,
    rentalDuration: booking.rentalDuration,
    subtotal: booking.subtotal,
    totalAmount: booking.totalAmount,
    bookingStatus: booking.bookingStatus,
    paymentStatus: booking.paymentStatus,
    createdAt: booking.createdAt,
    customer: safeUser(customer),
    owner: safeUser(owner),
    equipment: safeEquipment(equipment),
  };
}

function successfulPayments() {
  const excludedFulfillment = new Set([
    "refunded",
    "refund_pending",
    "refund_required",
    "review_required",
  ]);
  const matched = payments
    .filter(
      (payment) =>
        payment.paymentStatus === "paid" &&
        !excludedFulfillment.has(payment.fulfillmentStatus) &&
        bookings.some((booking) => sameId(booking._id, payment.bookingId)),
    )
    .map((payment) => ({
      payment,
      booking: bookings.find((item) => sameId(item._id, payment.bookingId)),
      key: payment.stripePaymentIntentId ?? String(payment._id),
      amount:
        payment.receivedAmountMinorUnits !== undefined
          ? payment.receivedAmountMinorUnits / 100
          : payment.amountMinorUnits !== undefined
            ? payment.amountMinorUnits / 100
            : payment.amount,
    }));
  const distinct = new Map();
  for (const row of matched) {
    const existing = distinct.get(row.key);
    if (!existing || row.amount > existing.amount) distinct.set(row.key, row);
  }
  return [...distinct.values()];
}

function evaluateAdminEquipmentAggregate() {
  const items = equipmentRows.filter(
    (item) =>
      item.isDeleted !== true &&
      ["pending", "approved", "rejected"].includes(item.status),
  );
  return items.length
    ? [{
        totalEquipment: items.length,
        approvedEquipment: items.filter((item) => item.status === "approved").length,
        pendingEquipment: items.filter((item) => item.status === "pending").length,
        rejectedEquipment: items.filter((item) => item.status === "rejected").length,
      }]
    : [];
}

function evaluateUserAggregate(pipeline) {
  const match = pipeline[0].$match;
  if (match.role?.$in) {
    const users = [...userRows.values()].filter((user) =>
      match.role.$in.includes(user.role),
    );
    const recentUsers = sortRows(users)
      .slice(0, 5)
      .map((user) => ({
        _id: user._id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
      }));
    const stats = users.length
      ? [{
          totalUsers: users.length,
          totalCustomers: users.filter((user) => user.role === "customer").length,
          totalOwners: users.filter((user) => user.role === "owner").length,
          totalAdmins: users.filter((user) => user.role === "admin").length,
        }]
      : [];
    return [{ stats, recentUsers }];
  }
  const user = userRows.get(String(match._id));
  if (!user) return [];
  return [{
    _id: user._id,
    name: user.name,
    email: user.email,
    image: user.image,
    phone: user.phone,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    accountStats: {
      customerBookings: bookings.filter((booking) =>
        sameId(booking.customerId, user._id),
      ).length,
      ownerBookings: bookings.filter((booking) =>
        sameId(booking.ownerId, user._id),
      ).length,
      equipmentListings: equipmentRows.filter(
        (item) =>
          sameId(item.ownerId, user._id) &&
          item.isDeleted !== true,
      ).length,
    },
  }];
}

function evaluateAdminBookings(pipeline) {
  const queryMatch = pipeline[0].$match;
  let rows = bookings.filter((booking) => {
    if (
      queryMatch.bookingStatus &&
      (typeof queryMatch.bookingStatus === "string"
        ? booking.bookingStatus !== queryMatch.bookingStatus
        : !queryMatch.bookingStatus.$in.includes(booking.bookingStatus))
    ) {
      return false;
    }
    if (
      queryMatch.paymentStatus &&
      booking.paymentStatus !== queryMatch.paymentStatus
    ) {
      return false;
    }
    return true;
  });
  const searchStage = pipeline.find(
    (stage) =>
      stage.$match?.$or &&
      stage.$match.$or.some((condition) =>
        Object.keys(condition)[0]?.includes("."),
      ),
  );
  if (searchStage) {
    const searchCondition = searchStage.$match.$or[0];
    const [path, matcher] = Object.entries(searchCondition)[0];
    const regex = new RegExp(matcher.$regex, matcher.$options);
    rows = rows.filter((booking) => {
      const customer = userRows.get(String(booking.customerId));
      const owner = userRows.get(String(booking.ownerId));
      const equipment = equipmentRows.find((item) =>
        sameId(item._id, booking.equipmentId),
      );
      const values = {
        "customer.name": customer?.name,
        "customer.email": customer?.email,
        "owner.name": owner?.name,
        "owner.email": owner?.email,
        "equipment.name": equipment?.name,
      };
      return Object.values(values).some((value) => value && regex.test(value));
    });
  }
  const facet = pipeline.at(-1).$facet;
  const sort = facet.items.find((stage) => stage.$sort)?.$sort;
  const offset = facet.items.find((stage) => "$skip" in stage)?.$skip ?? 0;
  const limit = facet.items.find((stage) => "$limit" in stage)?.$limit ?? 10;
  const items = sortRows(rows, sort)
    .slice(offset, offset + limit)
    .map(safeBooking);
  return [{
    items,
    metadata: rows.length ? [{ totalItems: rows.length }] : [],
  }];
}

function evaluateBookingAggregate(pipeline) {
  if (pipeline[0].$match?._id) {
    const booking = bookings.find((item) =>
      sameId(item._id, pipeline[0].$match._id),
    );
    if (!booking) return [];
    const response = safeBooking(booking);
    const latestPayment = sortRows(
      payments.filter((payment) => sameId(payment.bookingId, booking._id)),
      { createdAt: -1, _id: -1 },
    )[0];
    response.updatedAt = booking.updatedAt;
    response.paymentSummary = latestPayment
      ? {
          amount: latestPayment.receivedAmountMinorUnits / 100,
          currency: latestPayment.receivedCurrency,
          paymentStatus: latestPayment.paymentStatus,
          fulfillmentStatus: latestPayment.fulfillmentStatus,
          paymentMethod: latestPayment.paymentMethod ?? null,
          paidAt: latestPayment.paidAt ?? null,
          createdAt: latestPayment.createdAt,
        }
      : null;
    return [response];
  }

  if (pipeline[1]?.$lookup?.from === "payments") {
    const grouped = successfulPayments();
    const revenue = grouped.reduce((sum, row) => sum + row.amount, 0);
    const paidBookings = new Set(grouped.map((row) => String(row.booking._id)));
    return [{
      revenue: revenue ? [{ totalRevenue: revenue }] : [],
      bookings: paidBookings.size
        ? [{ totalPaidBookings: paidBookings.size }]
        : [],
    }];
  }

  if (
    pipeline[1]?.$facet?.stats &&
    pipeline[0].$match?.bookingStatus?.$in
  ) {
    const matched = bookings.filter((booking) =>
      pipeline[0].$match.bookingStatus.$in.includes(booking.bookingStatus),
    );
    const count = (status) =>
      matched.filter((booking) => booking.bookingStatus === status).length;
    const recentBookings = sortRows(matched)
      .slice(0, 5)
      .map(safeBooking);
    return [{
      stats: matched.length
        ? [{
            totalBookings: matched.length,
            pendingBookings: count("pending"),
            confirmedBookings: count("confirmed"),
            activeRentals: count("active"),
            completedRentals: count("completed"),
            cancelledBookings: count("cancelled"),
          }]
        : [],
      recentBookings,
    }];
  }
  return evaluateAdminBookings(pipeline);
}

function evaluateAdminPayments(pipeline) {
  const status = pipeline[0].$match.paymentStatus;
  let rows = payments.filter(
    (payment) => !status || payment.paymentStatus === status,
  );
  const facet = pipeline[1].$facet;
  const sort = facet.items.find((stage) => stage.$sort)?.$sort;
  const offset = facet.items.find((stage) => "$skip" in stage)?.$skip ?? 0;
  const limit = facet.items.find((stage) => "$limit" in stage)?.$limit ?? 10;
  const items = sortRows(rows, sort)
    .slice(offset, offset + limit)
    .map((payment) => {
      const booking = bookings.find((item) =>
        sameId(item._id, payment.bookingId),
      );
      const customer = userRows.get(String(payment.customerId));
      const owner = userRows.get(String(payment.ownerId ?? booking?.ownerId));
      const equipment = equipmentRows.find((item) =>
        sameId(item._id, payment.equipmentId ?? booking?.equipmentId),
      );
      return {
        _id: payment._id,
        amount: payment.amount,
        amountMinorUnits: payment.amountMinorUnits,
        receivedAmountMinorUnits: payment.receivedAmountMinorUnits,
        currency: payment.currency,
        receivedCurrency: payment.receivedCurrency,
        paymentStatus: payment.paymentStatus,
        fulfillmentStatus: payment.fulfillmentStatus,
        paymentMethod: payment.paymentMethod,
        paidAt: payment.paidAt,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
        booking: booking
          ? {
              _id: booking._id,
              startDate: booking.startDate,
              endDate: booking.endDate,
              quantity: booking.quantity,
              rentalType: booking.rentalType,
              totalAmount: booking.totalAmount,
              bookingStatus: booking.bookingStatus,
              paymentStatus: booking.paymentStatus,
            }
          : null,
        customer: safeUser(customer),
        owner: safeUser(owner),
        equipment: safeEquipment(equipment),
      };
    });
  return [{
    items,
    metadata: rows.length ? [{ totalItems: rows.length }] : [],
  }];
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
  keyId = "admin-management-test-key";
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
    userFind: User.find,
    userFindOne: User.findOne,
    userFindOneAndUpdate: User.findOneAndUpdate,
    userCountDocuments: User.countDocuments,
    userAggregate: User.aggregate,
    equipmentFind: Equipment.find,
    equipmentCountDocuments: Equipment.countDocuments,
    equipmentAggregate: Equipment.aggregate,
    bookingAggregate: Booking.aggregate,
    paymentAggregate: Payment.aggregate,
  };

  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return query((builder) =>
        project(userRows.get(String(id)) ?? null, builder.projection),
      );
    },
  });
  Object.defineProperty(User, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        let rows = [...userRows.values()].filter((user) => {
          if (filter.role && user.role !== filter.role) return false;
          if (filter.$or) {
            const matched = filter.$or.some((condition) => {
              const [field, matcher] = Object.entries(condition)[0];
              return new RegExp(matcher.$regex, matcher.$options).test(user[field]);
            });
            if (!matched) return false;
          }
          return true;
        });
        rows = sortRows(
          rows,
          builder.sortSpec ?? { createdAt: -1, _id: -1 },
        ).slice(
          builder.offset,
          builder.pageSize === undefined
            ? undefined
            : builder.offset + builder.pageSize,
        );
        return rows.map((row) => project(row, builder.projection));
      });
    },
  });
  Object.defineProperty(User, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        const user = userRows.get(String(filter._id));
        if (
          !user ||
          (filter.role && user.role !== filter.role) ||
          (filter.isActive !== undefined && user.isActive !== filter.isActive)
        ) {
          return null;
        }
        return project(user, builder.projection);
      });
    },
  });
  Object.defineProperty(User, "findOneAndUpdate", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query((builder) => {
        const user = userRows.get(String(filter._id));
        if (
          !user ||
          (filter.role && user.role !== filter.role) ||
          (filter.isActive !== undefined && user.isActive !== filter.isActive)
        ) {
          return null;
        }
        Object.assign(user, update.$set ?? {});
        for (const field of Object.keys(update.$unset ?? {})) delete user[field];
        return project(user, builder.projection);
      });
    },
  });
  Object.defineProperty(User, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() =>
        [...userRows.values()].filter((user) => {
          if (filter.role && user.role !== filter.role) return false;
          if (filter.$or) {
            return filter.$or.some((condition) => {
              const [field, matcher] = Object.entries(condition)[0];
              return new RegExp(matcher.$regex, matcher.$options).test(user[field]);
            });
          }
          return true;
        }).length,
      );
    },
  });
  Object.defineProperty(User, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateUserAggregate(pipeline) };
    },
  });

  Object.defineProperty(Equipment, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        let rows = equipmentRows.filter((item) => {
          if (filter.isDeleted && item.isDeleted === true) return false;
          if (filter.status && item.status !== filter.status) return false;
          if (filter.category && item.category !== filter.category) return false;
          if (filter.$or) {
            const matches = filter.$or.some((condition) => {
              const [field, matcher] = Object.entries(condition)[0];
              return new RegExp(matcher.$regex, matcher.$options).test(item[field] ?? "");
            });
            if (!matches) return false;
          }
          return true;
        });
        rows = sortRows(
          rows,
          builder.sortSpec ?? { createdAt: -1, _id: -1 },
        ).slice(
          builder.offset,
          builder.pageSize === undefined
            ? undefined
            : builder.offset + builder.pageSize,
        );
        return rows.map((item) => {
          const result = { ...project(item, builder.projection) };
          if (builder.populations.includes("ownerId")) {
            result.ownerId = safeUser(userRows.get(String(item.ownerId)));
          }
          return result;
        });
      });
    },
  });
  Object.defineProperty(Equipment, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() =>
        equipmentRows.filter((item) => {
          if (filter.isDeleted && item.isDeleted === true) return false;
          if (filter.status && item.status !== filter.status) return false;
          if (filter.category && item.category !== filter.category) return false;
          if (filter.$or) {
            return filter.$or.some((condition) => {
              const [field, matcher] = Object.entries(condition)[0];
              return new RegExp(matcher.$regex, matcher.$options).test(item[field] ?? "");
            });
          }
          return true;
        }).length,
      );
    },
  });
  Object.defineProperty(Equipment, "aggregate", {
    configurable: true,
    writable: true,
    value() {
      return { exec: async () => evaluateAdminEquipmentAggregate() };
    },
  });

  Object.defineProperty(Booking, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateBookingAggregate(pipeline) };
    },
  });
  Object.defineProperty(Payment, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateAdminPayments(pipeline) };
    },
  });

  const sign = (id) =>
    new SignJWT({ role: "untrusted-client-claim" })
      .setProtectedHeader({ alg: "EdDSA", kid: keyId })
      .setIssuer(authBase)
      .setAudience("varax-api")
      .setSubject(id.toString())
      .setExpirationTime("5m")
      .sign(privateKey);
  tokens = {
    admin: await sign(ids.admin),
    owner: await sign(ids.owner),
    customer: await sign(ids.customer),
    inactive: await sign(ids.inactive),
  };
  const app = (await import("../dist/app.js")).default;
  apiServer = createServer(app);
  await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

beforeEach(() => {
  userRows.clear();
  for (const user of [
    makeUser(ids.admin, "admin", "Admin One"),
    makeUser(ids.owner, "owner", "Olivia Owner"),
    makeUser(ids.customer, "customer", "Alex Customer", {
      createdAt: at(2, 1),
    }),
    makeUser(ids.otherCustomer, "customer", "Bea Customer", {
      createdAt: at(3, 1),
    }),
    makeUser(ids.inactive, "customer", "Inactive Customer", {
      isActive: false,
      createdAt: at(4, 1),
    }),
    makeUser(ids.invalidRole, "not-a-role", "Invalid Role", {
      createdAt: at(5, 1),
    }),
  ]) {
    userRows.set(String(user._id), user);
  }

  equipmentRows = [
    makeEquipment(ids.approvedEquipment, ids.owner, "Approved Camera", "approved", {
      createdAt: at(1, 1),
      price: 100,
    }),
    makeEquipment(ids.pendingEquipment, ids.owner, "Pending Lens", "pending", {
      createdAt: at(2, 1),
      price: 200,
    }),
    makeEquipment(ids.rejectedEquipment, ids.customer, "Rejected Tractor", "rejected", {
      createdAt: at(3, 1),
      price: 300,
    }),
    makeEquipment(ids.deletedEquipment, ids.owner, "Deleted Listing", "approved", {
      isDeleted: true,
    }),
  ];

  bookings = [
    makeBooking(ids.approvedEquipment, "pending", "unpaid", {
      createdAt: at(1, 2),
      totalAmount: 100,
    }),
    makeBooking(ids.approvedEquipment, "confirmed", "paid", {
      createdAt: at(2, 2),
      totalAmount: 200,
    }),
    makeBooking(ids.pendingEquipment, "active", "paid", {
      createdAt: at(3, 2),
      customerId: ids.otherCustomer,
      totalAmount: 300,
    }),
    makeBooking(ids.pendingEquipment, "completed", "paid", {
      createdAt: at(4, 2),
      totalAmount: 400,
    }),
    makeBooking(ids.rejectedEquipment, "cancelled", "refunded", {
      createdAt: at(5, 2),
      totalAmount: 500,
    }),
    makeBooking(ids.rejectedEquipment, "rejected", "failed", {
      createdAt: at(6, 2),
      totalAmount: 600,
    }),
  ];

  payments = [
    makePayment(bookings[1], 200, {
      stripePaymentIntentId: "pi_one",
      paidAt: at(1, 12),
    }),
    makePayment(bookings[1], 200, {
      stripePaymentIntentId: "pi_one",
      paidAt: at(1, 12),
    }),
    makePayment(bookings[2], 400, {
      stripePaymentIntentId: "pi_two",
      paidAt: at(2, 12),
    }),
    makePayment(bookings[3], 500, {
      paymentStatus: "pending",
      stripePaymentIntentId: "pi_pending",
    }),
    makePayment(bookings[3], 600, {
      paymentStatus: "failed",
      stripePaymentIntentId: "pi_failed",
    }),
    makePayment(bookings[4], 700, {
      paymentStatus: "refunded",
      fulfillmentStatus: "refunded",
      stripePaymentIntentId: "pi_refunded",
    }),
    makePayment(bookings[4], 800, {
      fulfillmentStatus: "refund_pending",
      stripePaymentIntentId: "pi_refund_pending",
    }),
  ];
});

after(async () => {
  if (originals) {
    for (const [model, methods] of [
      [models.User, {
        findById: originals.userFindById,
        find: originals.userFind,
        findOne: originals.userFindOne,
        findOneAndUpdate: originals.userFindOneAndUpdate,
        countDocuments: originals.userCountDocuments,
        aggregate: originals.userAggregate,
      }],
      [models.Equipment, {
        find: originals.equipmentFind,
        countDocuments: originals.equipmentCountDocuments,
        aggregate: originals.equipmentAggregate,
      }],
      [models.Booking, { aggregate: originals.bookingAggregate }],
      [models.Payment, { aggregate: originals.paymentAggregate }],
    ]) {
      for (const [method, value] of Object.entries(methods)) {
        Object.defineProperty(model, method, {
          configurable: true,
          writable: true,
          value,
        });
      }
    }
  }
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

const adminPaths = [
  "/api/admin/dashboard/overview",
  "/api/admin/dashboard/profile",
  "/api/admin/users",
  "/api/admin/users/not-an-id",
  "/api/admin/equipment",
  "/api/admin/bookings",
  "/api/admin/payments",
];

test("admin APIs reject unauthenticated users, customers, and owners", async () => {
  for (const path of adminPaths) {
    assert.equal((await apiCall("GET", path)).status, 401, path);
    assert.equal((await apiCall("GET", path, tokens.customer)).status, 403, path);
    assert.equal((await apiCall("GET", path, tokens.owner)).status, 403, path);
  }
  assert.equal(
    (
      await apiCall(
        "PATCH",
        `/api/admin/users/${ids.customer}/role`,
        tokens.customer,
        { role: "admin" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await apiCall("GET", "/api/admin/users", tokens.inactive)).status,
    403,
  );
});

test("admin overview counts actual roles and valid non-deleted records", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/dashboard/overview",
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(
    {
      totalUsers: data.totalUsers,
      totalCustomers: data.totalCustomers,
      totalOwners: data.totalOwners,
      totalAdmins: data.totalAdmins,
      totalEquipment: data.totalEquipment,
      approvedEquipment: data.approvedEquipment,
      pendingEquipment: data.pendingEquipment,
      rejectedEquipment: data.rejectedEquipment,
      totalBookings: data.totalBookings,
      pendingBookings: data.pendingBookings,
      confirmedBookings: data.confirmedBookings,
      activeRentals: data.activeRentals,
      completedRentals: data.completedRentals,
      cancelledBookings: data.cancelledBookings,
      totalRevenue: data.totalRevenue,
      totalPaidBookings: data.totalPaidBookings,
    },
    {
      totalUsers: 5,
      totalCustomers: 3,
      totalOwners: 1,
      totalAdmins: 1,
      totalEquipment: 3,
      approvedEquipment: 1,
      pendingEquipment: 1,
      rejectedEquipment: 1,
      totalBookings: 6,
      pendingBookings: 1,
      confirmedBookings: 1,
      activeRentals: 1,
      completedRentals: 1,
      cancelledBookings: 1,
      totalRevenue: 600,
      totalPaidBookings: 2,
    },
  );
  assert.equal(data.recentUsers.length, 5);
  assert.equal(data.recentBookings.length, 5);
  assert.equal("password" in data.recentUsers[0], false);
  assert.equal("deliveryAddress" in data.recentBookings[0], false);
  assert.equal("stripeSessionId" in data.recentBookings[0], false);
});

test("admin list query indexes cover global recent users, bookings, and payments", () => {
  assert.ok(models.User.schema.indexes().some(([keys]) => keys.createdAt === -1 && keys._id === -1));
  assert.ok(models.Booking.schema.indexes().some(([keys]) => keys.createdAt === -1 && keys._id === -1));
  assert.ok(models.Payment.schema.indexes().some(([keys]) => keys.createdAt === -1 && keys._id === -1));
  assert.ok(models.Payment.schema.indexes().some(([keys]) => keys.paymentStatus === 1 && keys.createdAt === -1));
});

test("admin user search, role filtering, sorting, pagination, and detail statistics work", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/users?role=customer&search=CUSTOMER&sort=oldest&page=2&limit=1",
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].name, "Bea Customer");
  assert.equal(body.pagination.totalItems, 3);
  assert.equal("password" in body.data[0], false);
  assert.equal("sessions" in body.data[0], false);

  const details = await apiCall(
    "GET",
    `/api/admin/users/${ids.owner}`,
    tokens.admin,
  );
  const detailData = (await details.json()).data;
  assert.deepEqual(detailData.accountStats, {
    customerBookings: 0,
    ownerBookings: 6,
    equipmentListings: 2,
  });
  assert.equal("emailVerified" in detailData, false);
  assert.equal("password" in detailData, false);

  assert.equal(
    (
      await apiCall("GET", "/api/admin/users?role=superadmin", tokens.admin)
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "PATCH",
        `/api/admin/users/${ids.customer}/role`,
        tokens.admin,
        { role: "owner", isActive: false },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall("GET", "/api/admin/users?page=1&limit=51", tokens.admin)
    ).status,
    400,
  );
  assert.equal(
    (await apiCall("GET", "/api/admin/users/not-an-id", tokens.admin)).status,
    400,
  );
});

test("admin role and account status changes are validated and self-protected", async () => {
  const roleChange = await apiCall(
    "PATCH",
    `/api/admin/users/${ids.customer}/role`,
    tokens.admin,
    { role: "owner" },
  );
  assert.equal(roleChange.status, 200);
  assert.equal(userRows.get(String(ids.customer)).role, "owner");
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/owner/dashboard/profile",
        tokens.customer,
      )
    ).status,
    200,
  );

  assert.equal(
    (
      await apiCall(
        "PATCH",
        `/api/admin/users/${ids.customer}/role`,
        tokens.admin,
        { role: "superuser" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "PATCH",
        `/api/admin/users/${ids.admin}/role`,
        tokens.admin,
        { role: "customer" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await apiCall(
        "PATCH",
        `/api/admin/users/${ids.admin}/status`,
        tokens.admin,
        { isActive: false },
      )
    ).status,
    409,
  );

  const deactivated = await apiCall(
    "PATCH",
    `/api/admin/users/${ids.customer}/status`,
    tokens.admin,
    { isActive: false },
  );
  assert.equal(deactivated.status, 200);
  assert.equal(userRows.get(String(ids.customer)).isActive, false);
  assert.equal(
    (await apiCall("GET", "/api/owner/dashboard/profile", tokens.customer))
      .status,
    403,
  );

  assert.equal(
    (
      await apiCall(
        "PATCH",
        `/api/admin/users/${ids.inactive}/status`,
        tokens.admin,
        { isActive: "true" },
      )
    ).status,
    400,
  );
  assert.equal(bookings.length, 6);
  assert.equal(payments.length, 7);
});

test("admin equipment list reuses the existing moderation endpoint with filters", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/equipment?status=pending&search=lens&sort=price_desc&page=1&limit=2",
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].name, "Pending Lens");
  assert.equal(body.data[0].ownerId.name, "Olivia Owner");
  assert.equal(body.pagination.totalItems, 1);
  assert.equal("password" in body.data[0].ownerId, false);
  const sorted = await apiCall(
    "GET",
    "/api/admin/equipment?sort=price_asc&page=1&limit=3",
    tokens.admin,
  );
  assert.deepEqual(
    (await sorted.json()).data.map((item) => item.name),
    ["Approved Camera", "Pending Lens", "Rejected Tractor"],
  );
  assert.equal(
    (
      await apiCall("GET", "/api/admin/equipment?status=unknown", tokens.admin)
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall("GET", "/api/admin/equipment?category=wrong", tokens.admin)
    ).status,
    400,
  );
});

test("admin bookings can be searched, filtered, paginated, and read with safe payment summary", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/bookings?status=confirmed&paymentStatus=paid&search=Alex&page=1&limit=1&sort=oldest",
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].bookingStatus, "confirmed");
  assert.equal(body.data[0].customer.name, "Alex Customer");
  assert.equal(body.data[0].equipment.name, "Approved Camera");
  assert.equal("deliveryAddress" in body.data[0], false);
  assert.equal("stripeSessionId" in body.data[0], false);
  assert.equal(body.pagination.totalItems, 1);
  const oldest = await apiCall(
    "GET",
    "/api/admin/bookings?sort=oldest&page=1&limit=2",
    tokens.admin,
  );
  const oldestBody = await oldest.json();
  assert.equal(oldestBody.data[0].bookingStatus, "pending");
  assert.equal(oldestBody.data[1].bookingStatus, "confirmed");

  const detail = await apiCall(
    "GET",
    `/api/admin/bookings/${bookings[1]._id}`,
    tokens.admin,
  );
  const detailData = (await detail.json()).data;
  assert.equal(detailData.paymentSummary.paymentStatus, "paid");
  assert.equal("stripeSessionId" in detailData, false);
  assert.equal("paymentIntentId" in detailData.paymentSummary, false);
  assert.equal(
    (await apiCall("GET", "/api/admin/bookings/bad-id", tokens.admin)).status,
    400,
  );
  assert.equal(
    (
      await apiCall("GET", "/api/admin/bookings?status=bad", tokens.admin)
    ).status,
    400,
  );
});

test("admin payments are paginated and never serialize Stripe credentials or objects", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/payments?status=paid&sort=newest&page=1&limit=1",
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].paymentStatus, "paid");
  assert.ok(body.data[0].booking);
  assert.ok(body.data[0].customer);
  assert.ok(body.data[0].owner);
  assert.ok(body.data[0].equipment);
  assert.equal(body.pagination.totalItems, 4);
  const serialized = JSON.stringify(body.data);
  for (const privateField of [
    "stripeSessionId",
    "stripePaymentIntentId",
    "stripeEventIds",
    "checkoutUrl",
    "secretKey",
  ]) {
    assert.equal(serialized.includes(privateField), false);
  }
  assert.equal(
    (await apiCall("GET", "/api/admin/payments?status=unknown", tokens.admin))
      .status,
    400,
  );
  assert.equal(
    (await apiCall("PATCH", `/api/admin/payments/${payments[0]._id}`, tokens.admin, {
      paymentStatus: "paid",
    })).status,
    404,
  );
});

test("admin profile is safe and updates only permitted profile fields", async () => {
  const profile = await apiCall(
    "GET",
    "/api/admin/dashboard/profile",
    tokens.admin,
  );
  const profileData = (await profile.json()).data;
  assert.equal(profileData.role, "admin");
  assert.equal("password" in profileData, false);
  assert.equal("emailVerified" in profileData, false);

  const update = await apiCall(
    "PATCH",
    "/api/admin/dashboard/profile",
    tokens.admin,
    { name: "Admin Updated", phone: "+8801712345678" },
  );
  assert.equal(update.status, 200);
  const updated = (await update.json()).data;
  assert.equal(updated.name, "Admin Updated");
  assert.equal(updated.role, "admin");
  for (const key of ["role", "isActive", "email", "emailVerified", "password", "_id"]) {
    assert.equal(
      (
        await apiCall(
          "PATCH",
          "/api/admin/dashboard/profile",
          tokens.admin,
          { [key]: "change" },
        )
      ).status,
      400,
    );
  }
});

test("no platform activity returns valid dashboard and pagination responses", async () => {
  userRows.clear();
  const admin = makeUser(ids.admin, "admin", "Admin One");
  userRows.set(String(ids.admin), admin);
  equipmentRows = [];
  bookings = [];
  payments = [];
  const overview = await apiCall(
    "GET",
    "/api/admin/dashboard/overview",
    tokens.admin,
  );
  const data = (await overview.json()).data;
  assert.equal(data.totalUsers, 1);
  assert.equal(data.totalAdmins, 1);
  assert.equal(data.totalEquipment, 0);
  assert.equal(data.totalBookings, 0);
  assert.equal(data.totalRevenue, 0);
  assert.equal(data.recentUsers.length, 1);
  assert.deepEqual(data.recentBookings, []);

  const users = await apiCall("GET", "/api/admin/users", tokens.admin);
  const userList = await users.json();
  assert.equal(userList.data.length, 1);
  assert.equal(userList.data[0].role, "admin");
  assert.equal(userList.pagination.totalItems, 1);

  const paymentsResponse = await apiCall(
    "GET",
    "/api/admin/payments",
    tokens.admin,
  );
  assert.deepEqual((await paymentsResponse.json()).data, []);
});
