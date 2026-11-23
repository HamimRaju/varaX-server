import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-analytics-tests";
process.env.STRIPE_SECRET_KEY = "sk_test_varax_analytics_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_varax_analytics_tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const ids = {
  admin: new mongoose.Types.ObjectId(),
  ownerA: new mongoose.Types.ObjectId(),
  ownerB: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  oldCustomer: new mongoose.Types.ObjectId(),
  camera: new mongoose.Types.ObjectId(),
  tractor: new mongoose.Types.ObjectId(),
  zeroRental: new mongoose.Types.ObjectId(),
  deleted: new mongoose.Types.ObjectId(),
  otherEquipment: new mongoose.Types.ObjectId(),
};

const DAY = 24 * 60 * 60 * 1000;
const users = new Map();
let equipment = [];
let bookings = [];
let payments = [];
let server;
let authServer;
let apiBase;
let authBase;
let privateKey;
let keyId;
let tokens;
let models;
let originals;

function id(value) {
  return String(value);
}

function sameId(left, right) {
  return id(left) === id(right);
}

function daysAgo(days) {
  return new Date(Date.now() - days * DAY);
}

function utcDay(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function query(execute) {
  return {
    selection: undefined,
    select(value) {
      this.selection = value;
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

function makeUser(userId, role, name, createdAt) {
  return {
    _id: userId,
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@analytics.test`,
    role,
    isActive: true,
    createdAt,
  };
}

function makeEquipment(equipmentId, ownerId, name, status, category, deleted = false) {
  return {
    _id: equipmentId,
    ownerId,
    name,
    status,
    category,
    location: "Dhaka",
    image: `https://images.example.test/${name.replaceAll(" ", "-")}.jpg`,
    isDeleted: deleted,
  };
}

function makeBooking(ownerId, customerId, equipmentId, status, amount, createdAt) {
  return {
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    customerId,
    equipmentId,
    bookingStatus: status,
    paymentStatus: status === "pending" ? "unpaid" : "paid",
    totalAmount: amount,
    createdAt,
  };
}

function makePayment(booking, amountMinorUnits, paidAt, values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    bookingId: booking._id,
    customerId: booking.customerId,
    ownerId: booking.ownerId,
    equipmentId: booking.equipmentId,
    amount: amountMinorUnits / 100,
    amountMinorUnits,
    receivedAmountMinorUnits: amountMinorUnits,
    currency: "bdt",
    receivedCurrency: "bdt",
    paymentStatus: "paid",
    fulfillmentStatus: "fulfilled",
    paidAt,
    createdAt: paidAt,
    ...values,
  };
}

function successfulRows(ownerId, range, requirePaidAt = false) {
  const excludedFulfillment = new Set([
    "refunded",
    "refund_pending",
    "refund_required",
    "review_required",
  ]);
  const grouped = new Map();
  for (const payment of payments) {
    if (
      payment.paymentStatus !== "paid" ||
      excludedFulfillment.has(payment.fulfillmentStatus)
    ) {
      continue;
    }
    const booking = bookings.find((item) => sameId(item._id, payment.bookingId));
    if (
      !booking ||
      (ownerId && !sameId(booking.ownerId, ownerId))
    ) {
      continue;
    }
    if (requirePaidAt && !(payment.paidAt instanceof Date)) continue;
    const paidAt = payment.paidAt ?? payment.createdAt;
    if (!(paidAt instanceof Date)) continue;
    if (range?.$gte && paidAt < range.$gte) continue;
    if (range?.$lt && paidAt >= range.$lt) continue;
    const amountMinorUnits =
      payment.receivedAmountMinorUnits ??
      payment.amountMinorUnits ??
      Math.round(payment.amount * 100);
    const paymentKey = payment.stripePaymentIntentId ?? id(payment._id);
    const row = {
      payment,
      booking,
      paidAt,
      amountMinorUnits,
      equipmentId: booking.equipmentId,
      key: paymentKey,
    };
    const prior = grouped.get(paymentKey);
    if (!prior || row.amountMinorUnits > prior.amountMinorUnits) {
      grouped.set(paymentKey, row);
    }
  }
  return [...grouped.values()];
}

function isoWeekLabel(date) {
  const dayNumber = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() + (3 - dayNumber) * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Offset = (jan4.getUTCDay() + 6) % 7;
  const firstMonday = new Date(jan4.getTime() - jan4Offset * DAY);
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - dayNumber);
  const week = Math.floor((monday.getTime() - firstMonday.getTime()) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function labelFor(date, period) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (period === "daily") return `${year}-${month}-${day}`;
  if (period === "weekly") return isoWeekLabel(date);
  if (period === "monthly") return `${year}-${month}`;
  return String(year);
}

function groupRevenueRows(rows, period) {
  const groups = new Map();
  for (const row of rows) {
    const label = labelFor(row.paidAt, period);
    const item = groups.get(label) ?? {
      label,
      revenueMinorUnits: 0,
      paymentCount: 0,
      bookings: new Set(),
    };
    item.revenueMinorUnits += row.amountMinorUnits;
    item.paymentCount += 1;
    item.bookings.add(id(row.booking._id));
    groups.set(label, item);
  }
  return [...groups.values()]
    .map((item) => ({
      label: item.label,
      revenueMinorUnits: item.revenueMinorUnits,
      paymentCount: item.paymentCount,
      bookingCount: item.bookings.size,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function extractDateRange(pipeline) {
  return pipeline.find((stage) => stage.$match?.earningDate)?.$match?.earningDate;
}

function extractOwnerId(pipeline) {
  return pipeline[0]?.$match?.ownerId;
}

function countBy(rows, field) {
  const result = new Map();
  for (const row of rows) {
    result.set(row[field], (result.get(row[field]) ?? 0) + 1);
  }
  return [...result.entries()].map(([_id, count]) => ({ _id, count }));
}

function validBookings(ownerId) {
  return bookings.filter(
    (booking) =>
      (!ownerId || sameId(booking.ownerId, ownerId)) &&
      ["pending", "confirmed", "active", "completed", "cancelled", "rejected"].includes(
        booking.bookingStatus,
      ),
  );
}

function bookingStats(rows) {
  const total = rows.reduce((sum, booking) => sum + Math.round(booking.totalAmount * 100), 0);
  return rows.length
    ? [{
        totalBookings: rows.length,
        pendingBookings: rows.filter((row) => row.bookingStatus === "pending").length,
        confirmedBookings: rows.filter((row) => row.bookingStatus === "confirmed").length,
        activeRentals: rows.filter((row) => row.bookingStatus === "active").length,
        completedRentals: rows.filter((row) => row.bookingStatus === "completed").length,
        cancelledBookings: rows.filter((row) => row.bookingStatus === "cancelled").length,
        rejectedBookings: rows.filter((row) => row.bookingStatus === "rejected").length,
        completedBookings: rows.filter((row) => row.bookingStatus === "completed").length,
        averageBookingValueMinorUnits: total / rows.length,
      }]
    : [];
}

function currentGrowthCounts(rows, periods, createdAtField) {
  const current = rows.filter(
    (row) =>
      row[createdAtField] >= periods.currentStart &&
      row[createdAtField] < periods.currentEnd,
  ).length;
  const previous = rows.filter(
    (row) =>
      row[createdAtField] >= periods.previousStart &&
      row[createdAtField] < periods.previousEnd,
  ).length;
  return { current, previous };
}

function monthRangeFromPipeline(facetPipeline) {
  return facetPipeline.find((stage) => stage.$match?.createdAt)?.$match?.createdAt;
}

function evaluateUserAggregate(pipeline) {
  const validRoles = ["customer", "owner", "admin"];
  const userRows = [...users.values()].filter((user) =>
    validRoles.includes(user.role),
  );
  if (pipeline.at(-1)?.$facet) {
    const facets = pipeline.at(-1).$facet;
    const totals = userRows.length
      ? [{
          totalUsers: userRows.length,
          customerCount: userRows.filter((user) => user.role === "customer").length,
          ownerCount: userRows.filter((user) => user.role === "owner").length,
        }]
      : [];
    const roles = countBy(userRows, "role");
    const monthRange = monthRangeFromPipeline(facets.monthly);
    const monthlyRows = userRows.filter(
      (user) =>
        user.createdAt >= monthRange.$gte &&
        user.createdAt < monthRange.$lt,
    );
    const monthly = [...new Map(monthlyRows.map((user) => {
      const month = labelFor(user.createdAt, "monthly");
      return [month, { month, userCount: monthlyRows.filter((item) => labelFor(item.createdAt, "monthly") === month).length }];
    })).values()];
    const growthRange = monthRangeFromPipeline(facets.growth);
    const currentStart = facets.growth.find((stage) => stage.$group)
      .$group.currentUsers.$sum.$cond[0].$gte[1];
    const rolling = {
      currentStart,
      currentEnd: growthRange.$lt,
      previousStart: growthRange.$gte,
      previousEnd: currentStart,
    };
    const growth = currentGrowthCounts(userRows, rolling, "createdAt");
    return [{
      totals,
      roles,
      monthly,
      growth: userRows.length
        ? [{ currentUsers: growth.current, previousUsers: growth.previous }]
        : [],
    }];
  }
  return userRows.length
    ? [{
        totalUsers: userRows.length,
        totalCustomers: userRows.filter((user) => user.role === "customer").length,
        totalOwners: userRows.filter((user) => user.role === "owner").length,
      }]
    : [];
}

function equipmentRentalRows(ownerId) {
  const active = equipment.filter(
    (item) =>
      item.isDeleted !== true &&
      ["pending", "approved", "rejected"].includes(item.status) &&
      (!ownerId || sameId(item.ownerId, ownerId)),
  );
  return active.map((item) => ({
    ...item,
    rentalCount: bookings.filter(
      (booking) =>
        sameId(booking.equipmentId, item._id) &&
        ["confirmed", "active", "completed"].includes(booking.bookingStatus),
    ).length,
  }));
}

function safeEquipmentRow(item) {
  return {
    _id: item._id,
    name: item.name,
    image: item.image,
    category: item.category,
    location: item.location,
    status: item.status,
    rentalCount: item.rentalCount,
  };
}

function evaluateEquipmentAggregate(pipeline) {
  const match = pipeline[0]?.$match ?? {};
  const ownerId = match.ownerId;
  const rows = equipmentRentalRows(ownerId);
  if (pipeline.some((stage) => stage.$count === "totalEquipment")) {
    return rows.length ? [{ totalEquipment: rows.length }] : [];
  }
  const facets = pipeline.at(-1).$facet;
  const categories = countBy(rows, "category").map((row) => ({
    ...row,
    equipmentCount: row.count,
  }));
  const statuses = countBy(rows, "status").map((row) => ({
    ...row,
    equipmentCount: row.count,
  }));
  const byRental = [...rows].sort(
    (a, b) => a.rentalCount - b.rentalCount || a.name.localeCompare(b.name),
  );
  const most = [...rows]
    .filter((row) => row.rentalCount > 0)
    .sort((a, b) => b.rentalCount - a.rentalCount || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map(safeEquipmentRow);
  const least = byRental.slice(0, 5).map(safeEquipmentRow);
  const result = { statuses, mostRented: most, leastRented: least };
  if (facets.categories) {
    const ownerTotals = new Map();
    for (const item of rows) {
      const entry = ownerTotals.get(id(item.ownerId)) ?? {
        ownerId: item.ownerId,
        activeEquipmentCount: 0,
        rentalCount: 0,
      };
      entry.activeEquipmentCount += 1;
      entry.rentalCount += item.rentalCount;
      ownerTotals.set(id(item.ownerId), entry);
    }
    return [{
      categories,
      statuses,
      mostRented: most,
      leastRented: least,
      topOwners: [...ownerTotals.values()]
        .filter((entry) => entry.rentalCount > 0)
        .sort((a, b) => b.rentalCount - a.rentalCount)
        .slice(0, 5)
        .map((entry) => ({
          owner: {
            _id: entry.ownerId,
            name: users.get(id(entry.ownerId))?.name,
            image: users.get(id(entry.ownerId))?.image,
          },
          activeEquipmentCount: entry.activeEquipmentCount,
          rentalCount: entry.rentalCount,
        })),
    }];
  }
  return [{
    ...result,
    bookingsByEquipment: [...rows]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(safeEquipmentRow),
  }];
}

function evaluateAdminOverviewBookingPipeline(pipeline) {
  const facet = pipeline[0].$facet;
  const valid = validBookings();
  const stats = bookingStats(valid);
  const payments = successfulRows();
  const totalRevenueMinorUnits = payments.reduce(
    (sum, row) => sum + row.amountMinorUnits,
    0,
  );
  return [{
    bookings: stats.map((row) => ({
      totalBookings: row.totalBookings,
      completedBookings: row.completedBookings,
      activeRentals: row.activeRentals,
      pendingBookings: row.pendingBookings,
      averageBookingValueMinorUnits: row.averageBookingValueMinorUnits,
    })),
    revenue: totalRevenueMinorUnits
      ? [{ totalRevenueMinorUnits }]
      : [],
  }];
}

function evaluateOwnerOverviewBookingStats(pipeline) {
  const ownerId = pipeline[0].$match.ownerId;
  return bookingStats(validBookings(ownerId));
}

function evaluateOwnerOverviewPaymentPipeline(pipeline) {
  const ownerId = extractOwnerId(pipeline);
  const rows = successfulRows(ownerId);
  const facets = pipeline.at(-1).$facet;
  const total = rows.reduce((sum, row) => sum + row.amountMinorUnits, 0);
  const monthRange = facets.monthly.find(
    (stage) => stage.$match?.actualPaidAt,
  ).$match.actualPaidAt;
  const monthlyRows = rows.filter(
    (row) =>
      row.payment.paidAt instanceof Date &&
      row.payment.paidAt >= monthRange.$gte &&
      row.payment.paidAt < monthRange.$lt,
  );
  const monthly = groupRevenueRows(monthlyRows, "monthly").map((row) => ({
    month: row.label,
    revenueMinorUnits: row.revenueMinorUnits,
    paymentCount: row.paymentCount,
  }));
  const performanceMap = new Map();
  for (const row of rows) {
    const item = equipment.find(
      (entry) =>
        sameId(entry._id, row.equipmentId) &&
        sameId(entry.ownerId, ownerId) &&
        entry.isDeleted !== true,
    );
    if (!item) continue;
    const existing = performanceMap.get(id(item._id)) ?? {
      equipment: {
        _id: item._id,
        name: item.name,
        image: item.image,
        category: item.category,
        location: item.location,
      },
      revenueMinorUnits: 0,
      paymentCount: 0,
    };
    existing.revenueMinorUnits += row.amountMinorUnits;
    existing.paymentCount += 1;
    performanceMap.set(id(item._id), existing);
  }
  return [{
    total: total ? [{ totalRevenueMinorUnits: total }] : [],
    monthly,
    equipmentPerformance: [...performanceMap.values()]
      .sort((a, b) => b.revenueMinorUnits - a.revenueMinorUnits)
      .slice(0, 5),
  }];
}

function evaluateBookingAggregate(pipeline) {
  if (pipeline[0]?.$facet?.bookings && pipeline[0]?.$facet?.revenue) {
    return evaluateAdminOverviewBookingPipeline(pipeline);
  }
  if (pipeline[0]?.$match?.ownerId && pipeline[1]?.$group) {
    return evaluateOwnerOverviewBookingStats(pipeline);
  }
  if (pipeline[1]?.$lookup?.from === "payments" && pipeline.at(-1)?.$facet) {
    return evaluateOwnerOverviewPaymentPipeline(pipeline);
  }

  const revenueRange = extractDateRange(pipeline);
  const hasRevenueBucket = pipeline.some((stage) => stage.$addFields?.label);
  const successful = successfulRows(
    extractOwnerId(pipeline),
    revenueRange,
    hasRevenueBucket,
  );
  if (hasRevenueBucket) {
    const periodExpression = pipeline.find((stage) => stage.$addFields?.label)
      .$addFields.label.$dateToString.format;
    const period = periodExpression === "%Y-%m-%d"
      ? "daily"
      : periodExpression === "%G-W%V"
        ? "weekly"
        : periodExpression === "%Y-%m"
          ? "monthly"
          : "yearly";
    return groupRevenueRows(successful, period);
  }
  if (pipeline.some((stage) => stage.$lookup?.from === "equipment")) {
    const filtered = successful.filter((row) => {
      const item = equipment.find((entry) =>
        sameId(entry._id, row.equipmentId),
      );
      return (
        item &&
        item.isDeleted !== true &&
        sameId(item.ownerId, extractOwnerId(pipeline))
      );
    });
    const grouped = new Map();
    for (const row of filtered) {
      const key = id(row.equipmentId);
      const prior = grouped.get(key) ?? {
        _id: row.equipmentId,
        revenueMinorUnits: 0,
        paymentCount: 0,
      };
      prior.revenueMinorUnits += row.amountMinorUnits;
      prior.paymentCount += 1;
      grouped.set(key, prior);
    }
    return [...grouped.values()];
  }

  if (pipeline[1]?.$facet?.statuses) {
    const valid = validBookings();
    const facets = pipeline[1].$facet;
    const statuses = countBy(valid, "bookingStatus");
    const monthlyRange = monthRangeFromPipeline(facets.monthly);
    const monthBookings = valid.filter(
      (booking) =>
        booking.createdAt >= monthlyRange.$gte &&
        booking.createdAt < monthlyRange.$lt,
    );
    const monthlyMap = new Map();
    for (const booking of monthBookings) {
      const month = labelFor(booking.createdAt, "monthly");
      monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + 1);
    }
    const growthRange = monthRangeFromPipeline(facets.growth);
    const currentStart = facets.growth.find((stage) => stage.$group)
      .$group.currentBookings.$sum.$cond[0].$gte[1];
    const growth = {
      currentStart,
      currentEnd: growthRange.$lt,
      previousStart: growthRange.$gte,
      previousEnd: currentStart,
    };
    const counts = currentGrowthCounts(valid, growth, "createdAt");
    return [{
      statuses,
      monthly: [...monthlyMap.entries()].map(([month, bookingCount]) => ({
        month,
        bookingCount,
      })),
      summary: bookingStats(valid).map((row) => ({
        totalBookings: row.totalBookings,
        averageBookingValueMinorUnits: row.averageBookingValueMinorUnits,
      })),
      growth: [{
        currentBookings: counts.current,
        previousBookings: counts.previous,
      }],
    }];
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
  const keyPair = await generateKeyPair("EdDSA");
  privateKey = keyPair.privateKey;
  keyId = "analytics-test-key";
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
  models = { User, Equipment, Booking, Payment };
  originals = {
    userFindById: User.findById,
    userAggregate: User.aggregate,
    equipmentAggregate: Equipment.aggregate,
    bookingAggregate: Booking.aggregate,
  };
  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(userId) {
      return query(() => users.get(id(userId)) ?? null);
    },
  });
  Object.defineProperty(User, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateUserAggregate(pipeline) };
    },
  });
  Object.defineProperty(Equipment, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateEquipmentAggregate(pipeline) };
    },
  });
  Object.defineProperty(Booking, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      return { exec: async () => evaluateBookingAggregate(pipeline) };
    },
  });

  const sign = (userId) =>
    new SignJWT({ role: "client-claim-ignored" })
      .setProtectedHeader({ alg: "EdDSA", kid: keyId })
      .setIssuer(authBase)
      .setAudience("varax-api")
      .setSubject(userId.toString())
      .setExpirationTime("5m")
      .sign(privateKey);
  tokens = {
    admin: await sign(ids.admin),
    ownerA: await sign(ids.ownerA),
    ownerB: await sign(ids.ownerB),
    customer: await sign(ids.customer),
  };
  const app = (await import("../dist/express-app.js")).default;
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  users.clear();
  for (const user of [
    makeUser(ids.admin, "admin", "Analytics Admin", daysAgo(200)),
    makeUser(ids.ownerA, "owner", "Owner Alpha", daysAgo(5)),
    makeUser(ids.ownerB, "owner", "Owner Beta", daysAgo(40)),
    makeUser(ids.customer, "customer", "Customer Current", daysAgo(2)),
    makeUser(ids.oldCustomer, "customer", "Customer Older", daysAgo(200)),
  ]) {
    users.set(id(user._id), user);
  }

  equipment = [
    makeEquipment(
      ids.camera,
      ids.ownerA,
      "Camera A",
      "approved",
      "Photography Equipment",
    ),
    makeEquipment(
      ids.tractor,
      ids.ownerA,
      "Tractor A",
      "pending",
      "Construction Equipment",
    ),
    makeEquipment(
      ids.zeroRental,
      ids.ownerA,
      "Zero Rental Gear",
      "rejected",
      "Electronics",
    ),
    makeEquipment(
      ids.deleted,
      ids.ownerA,
      "Deleted Camera",
      "approved",
      "Photography Equipment",
      true,
    ),
    makeEquipment(
      ids.otherEquipment,
      ids.ownerB,
      "Camera B",
      "approved",
      "Vehicles & Transportation",
    ),
  ];

  bookings = [
    makeBooking(ids.ownerA, ids.customer, ids.camera, "pending", 100, daysAgo(2)),
    makeBooking(ids.ownerA, ids.customer, ids.camera, "completed", 200, daysAgo(6)),
    makeBooking(ids.ownerA, ids.customer, ids.camera, "active", 300, daysAgo(35)),
    makeBooking(ids.ownerA, ids.customer, ids.tractor, "cancelled", 400, daysAgo(40)),
    makeBooking(ids.ownerA, ids.customer, ids.zeroRental, "rejected", 500, daysAgo(70)),
    makeBooking(ids.ownerA, ids.customer, ids.tractor, "confirmed", 250, daysAgo(3)),
    makeBooking(ids.ownerB, ids.customer, ids.otherEquipment, "completed", 700, daysAgo(2)),
    makeBooking(
      ids.ownerA,
      ids.customer,
      ids.camera,
      "completed",
      450,
      daysAgo(400),
    ),
  ];

  payments = [
    makePayment(bookings[1], 20001, daysAgo(5), {
      stripePaymentIntentId: "pi_duplicate_owner_a",
    }),
    makePayment(bookings[1], 20001, daysAgo(5), {
      stripePaymentIntentId: "pi_duplicate_owner_a",
    }),
    makePayment(bookings[2], 30002, daysAgo(34), {
      stripePaymentIntentId: "pi_active_owner_a",
    }),
    makePayment(bookings[5], 25003, daysAgo(3), {
      stripePaymentIntentId: "pi_confirmed_owner_a",
    }),
    makePayment(bookings[6], 70004, daysAgo(2), {
      stripePaymentIntentId: "pi_owner_b",
    }),
    makePayment(bookings[1], 500, daysAgo(5), {
      stripePaymentIntentId: undefined,
    }),
    makePayment(bookings[1], 7777, daysAgo(4), {
      paidAt: undefined,
      stripePaymentIntentId: "pi_missing_paid_at",
    }),
    makePayment(bookings[2], 99000, daysAgo(2), {
      paymentStatus: "pending",
      stripePaymentIntentId: "pi_pending",
    }),
    makePayment(bookings[2], 98000, daysAgo(2), {
      paymentStatus: "failed",
      stripePaymentIntentId: "pi_failed",
    }),
    makePayment(bookings[4], 97000, daysAgo(2), {
      paymentStatus: "refunded",
      fulfillmentStatus: "refunded",
      stripePaymentIntentId: "pi_refunded",
    }),
    makePayment(bookings[4], 96000, daysAgo(2), {
      fulfillmentStatus: "refund_pending",
      stripePaymentIntentId: "pi_refund_pending",
    }),
    makePayment(bookings[4], 95000, daysAgo(2), {
      fulfillmentStatus: "refund_required",
      stripePaymentIntentId: "pi_refund_required",
    }),
    makePayment(
      bookings[7],
      4501,
      daysAgo(400),
      { stripePaymentIntentId: "pi_historical" },
    ),
  ];
});

after(async () => {
  if (originals) {
    for (const [model, method, value] of [
      [models.User, "findById", originals.userFindById],
      [models.User, "aggregate", originals.userAggregate],
      [models.Equipment, "aggregate", originals.equipmentAggregate],
      [models.Booking, "aggregate", originals.bookingAggregate],
    ]) {
      Object.defineProperty(model, method, {
        configurable: true,
        writable: true,
        value,
      });
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

function apiCall(method, path, token) {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const adminPaths = [
  "/api/admin/analytics/overview",
  "/api/admin/analytics/revenue",
  "/api/admin/analytics/bookings",
  "/api/admin/analytics/equipment",
  "/api/admin/analytics/users",
];
const ownerPaths = [
  "/api/owner/analytics/overview",
  "/api/owner/analytics/revenue",
  "/api/owner/analytics/equipment",
];

test("analytics endpoints enforce admin and owner authentication and role separation", async () => {
  for (const path of [...adminPaths, ...ownerPaths]) {
    assert.equal((await apiCall("GET", path)).status, 401, path);
    assert.equal((await apiCall("GET", path, tokens.customer)).status, 403, path);
  }
  for (const path of adminPaths) {
    assert.equal((await apiCall("GET", path, tokens.ownerA)).status, 403, path);
  }
  for (const path of ownerPaths) {
    assert.equal((await apiCall("GET", path, tokens.admin)).status, 403, path);
  }
});

test("paid-payment lookup has an owner/booked timestamp supporting index", () => {
  assert.ok(
    models.Payment.schema.indexes().some(
      ([keys]) =>
        keys.bookingId === 1 &&
        keys.paymentStatus === 1 &&
        keys.paidAt === 1,
    ),
  );
});

test("admin overview uses platform-wide recognized data and exact minor-unit revenue", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/analytics/overview",
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(
    {
      totalRevenue: data.totalRevenue,
      totalBookings: data.totalBookings,
      totalUsers: data.totalUsers,
      totalEquipment: data.totalEquipment,
      totalCustomers: data.totalCustomers,
      totalOwners: data.totalOwners,
      averageBookingValue: data.averageBookingValue,
      completedBookings: data.completedBookings,
      activeRentals: data.activeRentals,
      pendingBookings: data.pendingBookings,
      currency: data.currency,
    },
    {
      totalRevenue: 1577.88,
      totalBookings: 8,
      totalUsers: 5,
      totalEquipment: 4,
      totalCustomers: 2,
      totalOwners: 2,
      averageBookingValue: 362.5,
      completedBookings: 3,
      activeRentals: 1,
      pendingBookings: 1,
      currency: "BDT",
    },
  );
});

test("owner overview is scoped to its own bookings, equipment, and paid payments", async () => {
  const response = await apiCall(
    "GET",
    "/api/owner/analytics/overview",
    tokens.ownerA,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.totalRevenue, 877.84);
  assert.equal(data.totalBookings, 7);
  assert.equal(data.totalEquipment, 3);
  assert.equal(data.activeRentals, 1);
  assert.equal(data.completedRentals, 2);
  assert.equal(data.averageBookingValue, 314.29);
  assert.equal(data.currency, "BDT");
  assert.equal(data.monthlyRevenue.length, 12);
  assert.equal(
    Number(data.monthlyRevenue.reduce((sum, item) => sum + item.revenue, 0).toFixed(2)),
    755.06,
  );
  assert.equal(
    data.equipmentPerformance.every(
      (row) => row.equipment._id && row.equipment.name !== "Camera B",
    ),
    true,
  );
});

test("daily, weekly, monthly, and yearly revenue group actual paid timestamps", async () => {
  for (const period of ["daily", "weekly", "monthly", "yearly"]) {
    const response = await apiCall(
      "GET",
      `/api/admin/analytics/revenue?period=${period}`,
      tokens.admin,
    );
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.period, period);
    assert.equal(data.currency, "BDT");
    assert.ok(data.results.length > 0);
    assert.equal(
      Number(
        data.results
          .reduce((sum, item) => sum + item.revenue, 0)
          .toFixed(2),
      ),
      period === "daily"
        ? 1155.08
        : period === "weekly" || period === "monthly"
          ? 1455.1
          : 1500.11,
    );
    assert.ok(data.results.every((item) => item.paymentCount >= 0));
    assert.ok(data.results.every((item) => item.bookingCount >= 0));
  }

  const ownerResponse = await apiCall(
    "GET",
    "/api/owner/analytics/revenue?period=daily",
    tokens.ownerA,
  );
  const ownerData = (await ownerResponse.json()).data;
  assert.equal(
    Number(
      ownerData.results
        .reduce((sum, item) => sum + item.revenue, 0)
        .toFixed(2),
    ),
    455.04,
  );
});

test("custom revenue date ranges are inclusive UTC dates and reject invalid or oversized ranges", async () => {
  const today = utcDay();
  const start = new Date(today.getTime() - 10 * DAY);
  const startText = start.toISOString().slice(0, 10);
  const endText = today.toISOString().slice(0, 10);
  const response = await apiCall(
    "GET",
    `/api/admin/analytics/revenue?period=daily&startDate=${startText}&endDate=${endText}`,
    tokens.admin,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.startDate, startText);
  assert.equal(data.endDate, endText);
  assert.equal(data.results.length, 11);
  assert.equal(
    Number(
      data.results.reduce((sum, row) => sum + row.revenue, 0).toFixed(2),
    ),
    1155.08,
  );

  for (const queryString of [
    "period=decade",
    "period=daily&startDate=2026-02-30&endDate=2026-03-01",
    "period=monthly&startDate=2026-01-01",
    "period=daily&startDate=2026-03-01&endDate=2026-02-01",
    "period=daily&startDate=2020-01-01&endDate=2026-01-01",
  ]) {
    assert.equal(
      (
        await apiCall(
          "GET",
          `/api/admin/analytics/revenue?${queryString}`,
          tokens.admin,
        )
      ).status,
      400,
      queryString,
    );
  }
});

test("booking status counts and rolling growth handle ordinary and zero-baseline periods", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/analytics/bookings",
    tokens.admin,
  );
  const { data } = await response.json();
  const counts = Object.fromEntries(
    data.bookingsByStatus.map((row) => [row.status, row.bookingCount]),
  );
  assert.deepEqual(counts, {
    pending: 1,
    confirmed: 1,
    active: 1,
    completed: 3,
    cancelled: 1,
    rejected: 1,
  });
  assert.equal(data.totalBookings, 8);
  assert.equal(data.averageBookingValue, 362.5);
  assert.equal(data.bookingGrowth.currentPeriod.bookings, 4);
  assert.equal(data.bookingGrowth.previousPeriod.bookings, 2);
  assert.equal(data.bookingGrowth.percentChange, 100);
  assert.equal(data.bookingsByMonth.length, 12);

  for (const booking of bookings) booking.createdAt = daysAgo(100);
  bookings[0].createdAt = daysAgo(1);
  const zeroBaseline = (
    await (
      await apiCall(
        "GET",
        "/api/admin/analytics/bookings",
        tokens.admin,
      )
    ).json()
  ).data.bookingGrowth;
  assert.equal(zeroBaseline.currentPeriod.bookings, 1);
  assert.equal(zeroBaseline.previousPeriod.bookings, 0);
  assert.equal(zeroBaseline.percentChange, null);
});

test("equipment analytics exclude deleted listings and include zero-rental inventory", async () => {
  const adminResponse = await apiCall(
    "GET",
    "/api/admin/analytics/equipment",
    tokens.admin,
  );
  const { data } = await adminResponse.json();
  const statusCounts = Object.fromEntries(
    data.equipmentByStatus.map((row) => [row.status, row.equipmentCount]),
  );
  assert.deepEqual(statusCounts, { pending: 1, approved: 2, rejected: 1 });
  assert.equal(
    data.leastRentedEquipment.some(
      (item) => item.name === "Zero Rental Gear" && item.rentalCount === 0,
    ),
    true,
  );
  assert.equal(
    data.mostRentedEquipment.some((item) => item.name === "Deleted Camera"),
    false,
  );
  assert.equal(data.topEquipmentOwners[0].owner.name, "Owner Alpha");
  assert.equal(data.topEquipmentOwners[0].activeEquipmentCount, 3);
  assert.equal("email" in data.topEquipmentOwners[0].owner, false);

  const ownerResponse = await apiCall(
    "GET",
    "/api/owner/analytics/equipment",
    tokens.ownerA,
  );
  const owner = (await ownerResponse.json()).data;
  assert.equal(owner.bookingsByEquipment.length, 3);
  assert.equal(
    owner.bookingsByEquipment.some(
      (item) => item.name === "Zero Rental Gear" && item.rentalCount === 0,
    ),
    true,
  );
  assert.equal(owner.bookingsByEquipment.some((item) => item.name === "Camera B"), false);
  const zeroRevenue = owner.revenueByEquipment.find(
    (item) => item.name === "Zero Rental Gear",
  );
  assert.equal(zeroRevenue.revenue, 0);
});

test("user analytics count valid roles, UTC creation months, and zero-baseline growth safely", async () => {
  const response = await apiCall(
    "GET",
    "/api/admin/analytics/users",
    tokens.admin,
  );
  const { data } = await response.json();
  assert.equal(data.totalUsers, 5);
  assert.equal(data.customerCount, 2);
  assert.equal(data.ownerCount, 2);
  assert.equal(data.usersByRole.find((row) => row.role === "admin").userCount, 1);
  assert.equal(data.newUsersByMonth.length, 12);
  assert.equal(
    data.newUsersByMonth.reduce((sum, row) => sum + row.userCount, 0),
    5,
  );

  users.get(id(ids.ownerB)).createdAt = daysAgo(100);
  users.get(id(ids.customer)).createdAt = daysAgo(1);
  users.get(id(ids.oldCustomer)).createdAt = daysAgo(100);
  const growth = (
    await (
      await apiCall("GET", "/api/admin/analytics/users", tokens.admin)
    ).json()
  ).data.userGrowth;
  assert.equal(growth.currentPeriod.users, 2);
  assert.equal(growth.previousPeriod.users, 0);
  assert.equal(growth.percentChange, null);
});

test("empty analytics return zero metrics and zero-filled buckets", async () => {
  equipment = [];
  bookings = [];
  payments = [];
  const admin = (
    await (
      await apiCall("GET", "/api/admin/analytics/overview", tokens.admin)
    ).json()
  ).data;
  assert.equal(admin.totalRevenue, 0);
  assert.equal(admin.totalBookings, 0);
  assert.equal(admin.totalEquipment, 0);
  assert.equal(admin.averageBookingValue, 0);

  const owner = (
    await (
      await apiCall("GET", "/api/owner/analytics/overview", tokens.ownerA)
    ).json()
  ).data;
  assert.equal(owner.totalRevenue, 0);
  assert.equal(owner.totalBookings, 0);
  assert.equal(owner.totalEquipment, 0);
  assert.deepEqual(owner.equipmentPerformance, []);
  assert.equal(owner.monthlyRevenue.length, 12);
  assert.ok(owner.monthlyRevenue.every((item) => item.revenue === 0));

  const equipmentData = (
    await (
      await apiCall("GET", "/api/owner/analytics/equipment", tokens.ownerA)
    ).json()
  ).data;
  assert.deepEqual(equipmentData.bookingsByEquipment, []);
  assert.deepEqual(equipmentData.revenueByEquipment, []);
});
