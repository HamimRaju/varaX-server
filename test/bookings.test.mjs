import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-booking-tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const customerId = new mongoose.Types.ObjectId();
const otherCustomerId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const otherOwnerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const equipmentId = new mongoose.Types.ObjectId();
const otherEquipmentId = new mongoose.Types.ObjectId();
const ownEquipmentId = new mongoose.Types.ObjectId();
const pendingEquipmentId = new mongoose.Types.ObjectId();
const rejectedEquipmentId = new mongoose.Types.ObjectId();
const deletedEquipmentId = new mongoose.Types.ObjectId();

const users = new Map();
const equipment = new Map();
let bookings = [];
let transactionsSupported = true;
let transactionQueue = Promise.resolve();
let apiServer;
let authServer;
let apiBase;
let authBase;
let privateKey;
let keyId;
let tokens;
let models;
let restoreMethods;
let service;

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
    return matchesValue(row[field], expected);
  });
}

function query(exec) {
  return {
    paths: [],
    offset: 0,
    pageSize: 0,
    populate(path) {
      this.paths.push(typeof path === "string" ? path : path.path);
      return this;
    },
    select() {
      return this;
    },
    session() {
      return this;
    },
    lean() {
      return this;
    },
    sort() {
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
    async exec() {
      return exec(this);
    },
  };
}

function populatedBooking(row, paths) {
  const result = { ...row };
  if (paths.includes("equipmentId") && result.equipmentId) {
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
  if (paths.includes("ownerId") && result.ownerId) {
    const owner = users.get(idKey(result.ownerId));
    result.ownerId = owner
      ? { _id: owner._id, name: owner.name, image: owner.image }
      : null;
  }
  if (paths.includes("customerId") && result.customerId) {
    const customer = users.get(idKey(result.customerId));
    result.customerId = customer
      ? { _id: customer._id, name: customer.name, image: customer.image }
      : null;
  }
  return result;
}

function startOfToday() {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateOffset(days) {
  const date = startOfToday();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeEquipment(id, owner, values = {}) {
  return {
    _id: id,
    name: `Equipment ${idKey(id).slice(-4)}`,
    description: "Rental equipment",
    category: "Electronics",
    location: "Dhaka",
    price: 100,
    rentalType: "daily",
    availableQuantity: 2,
    image: "https://images.example.test/equipment.jpg",
    ownerId: owner,
    reservationVersion: 0,
    status: "approved",
    isDeleted: false,
    ...values,
  };
}

function makeBooking(values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    customerId,
    ownerId,
    equipmentId,
    startDate: new Date(`${dateOffset(4)}T00:00:00.000Z`),
    endDate: new Date(`${dateOffset(6)}T00:00:00.000Z`),
    quantity: 1,
    contactNumber: "01123456789",
    deliveryAddress: "Dhaka, Bangladesh",
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

function validBody(overrides = {}) {
  return {
    equipmentId: equipmentId.toString(),
    startDate: dateOffset(4),
    endDate: dateOffset(6),
    quantity: 1,
    contactNumber: "01XXXXXXXXX",
    deliveryAddress: "Dhaka, Bangladesh",
    ...overrides,
  };
}

function addBooking(values = {}) {
  const booking = makeBooking(values);
  bookings.push(booking);
  return booking;
}

before(async () => {
  authServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  let publicJwk;
  authBase = await listen(authServer);
  process.env.CLIENT_URL = authBase;
  process.env.JWT_ISSUER = authBase;
  process.env.JWKS_URL = `${authBase}/api/auth/jwks`;

  const keyPair = await generateKeyPair("EdDSA");
  privateKey = keyPair.privateKey;
  keyId = "booking-test-key";
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: keyId,
    alg: "EdDSA",
    use: "sig",
  };

  const { User } = await import("../dist/models/User.js");
  const { Equipment } = await import("../dist/models/Equipment.js");
  const { Booking } = await import("../dist/models/Booking.js");
  models = { User, Equipment, Booking };

  for (const [id, role, name] of [
    [customerId, "customer", "Customer One"],
    [otherCustomerId, "customer", "Customer Two"],
    [ownerId, "owner", "Owner One"],
    [otherOwnerId, "owner", "Owner Two"],
    [adminId, "admin", "Administrator"],
  ]) {
    users.set(idKey(id), {
      _id: id,
      name,
      email: `${role}-${idKey(id).slice(-4)}@example.test`,
      image: "https://images.example.test/profile.jpg",
      role,
      isActive: true,
    });
  }

  const originals = {
    userFindById: User.findById,
    equipmentFindOne: Equipment.findOne,
    equipmentFindById: Equipment.findById,
    equipmentUpdateOne: Equipment.updateOne,
    bookingAggregate: Booking.aggregate,
    bookingCreate: Booking.create,
    bookingFindOne: Booking.findOne,
    bookingFind: Booking.find,
    bookingCountDocuments: Booking.countDocuments,
    bookingUpdateOne: Booking.updateOne,
    mongooseStartSession: mongoose.startSession,
  };

  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return query(() => users.get(idKey(id)) ?? null);
    },
  });

  Object.defineProperty(Equipment, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() => {
        const item = equipment.get(idKey(filter._id));
        return item && matchesFilter(item, filter) ? item : null;
      });
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
        const item = equipment.get(idKey(filter._id));
        if (!item) return { matchedCount: 0, modifiedCount: 0 };
        item.reservationVersion =
          (item.reservationVersion ?? 0) + (update.$inc?.reservationVersion ?? 0);
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
          const reserved = bookings
            .filter((booking) => matchesFilter(booking, filter))
            .reduce((sum, booking) => sum + booking.quantity, 0);
          return reserved ? [{ _id: null, reservedQuantity: reserved }] : [];
        },
      };
    },
  });

  Object.defineProperty(Booking, "create", {
    configurable: true,
    writable: true,
    async value(documents) {
      const created = documents.map((document) => {
        const row = {
          _id: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...document,
        };
        bookings.push(row);
        return row;
      });
      return created;
    },
  });

  Object.defineProperty(Booking, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        const booking = bookings.find((row) => matchesFilter(row, filter));
        return booking ? populatedBooking(booking, builder.paths) : null;
      });
    },
  });

  Object.defineProperty(Booking, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      return query((builder) => {
        const result = bookings
          .filter((row) => matchesFilter(row, filter))
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(builder.offset, builder.offset + builder.pageSize);
        return result.map((row) => populatedBooking(row, builder.paths));
      });
    },
  });

  Object.defineProperty(Booking, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      return query(() => bookings.filter((row) => matchesFilter(row, filter)).length);
    },
  });

  Object.defineProperty(Booking, "updateOne", {
    configurable: true,
    writable: true,
    value(filter, update) {
      return query(() => {
        const booking = bookings.find((row) => matchesFilter(row, filter));
        if (!booking) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(booking, update.$set ?? {});
        booking.updatedAt = new Date();
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
        const bookingSnapshot = bookings.map((booking) => [booking, { ...booking }]);
        const equipmentVersions = new Map(
          [...equipment].map(([key, item]) => [key, item.reservationVersion]),
        );
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
          for (const [booking, snapshot] of bookingSnapshot) {
            Object.assign(booking, snapshot);
          }
          bookings.splice(
            0,
            bookings.length,
            ...bookingSnapshot.map(([booking]) => booking),
          );
          for (const [key, version] of equipmentVersions) {
            const item = equipment.get(key);
            if (item) item.reservationVersion = version;
          }
          throw error;
        } finally {
          release();
        }
      },
      async endSession() {},
    }),
  });

  restoreMethods = () => {
    Object.defineProperty(User, "findById", {
      configurable: true,
      writable: true,
      value: originals.userFindById,
    });
    Object.defineProperty(Equipment, "findOne", {
      configurable: true,
      writable: true,
      value: originals.equipmentFindOne,
    });
    Object.defineProperty(Equipment, "findById", {
      configurable: true,
      writable: true,
      value: originals.equipmentFindById,
    });
    Object.defineProperty(Equipment, "updateOne", {
      configurable: true,
      writable: true,
      value: originals.equipmentUpdateOne,
    });
    Object.defineProperty(Booking, "aggregate", {
      configurable: true,
      writable: true,
      value: originals.bookingAggregate,
    });
    Object.defineProperty(Booking, "create", {
      configurable: true,
      writable: true,
      value: originals.bookingCreate,
    });
    Object.defineProperty(Booking, "findOne", {
      configurable: true,
      writable: true,
      value: originals.bookingFindOne,
    });
    Object.defineProperty(Booking, "find", {
      configurable: true,
      writable: true,
      value: originals.bookingFind,
    });
    Object.defineProperty(Booking, "countDocuments", {
      configurable: true,
      writable: true,
      value: originals.bookingCountDocuments,
    });
    Object.defineProperty(Booking, "updateOne", {
      configurable: true,
      writable: true,
      value: originals.bookingUpdateOne,
    });
    Object.defineProperty(mongoose, "startSession", {
      configurable: true,
      writable: true,
      value: originals.mongooseStartSession,
    });
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

  service = await import("../dist/services/booking.service.js");
  const app = (await import("../dist/app.js")).default;
  apiServer = createServer(app);
  apiBase = await listen(apiServer);
});

beforeEach(() => {
  transactionsSupported = true;
  transactionQueue = Promise.resolve();
  bookings = [];
  equipment.clear();
  equipment.set(idKey(equipmentId), makeEquipment(equipmentId, ownerId));
  equipment.set(idKey(otherEquipmentId), makeEquipment(otherEquipmentId, otherOwnerId, {
    price: 500,
    rentalType: "weekly",
    availableQuantity: 1,
  }));
  equipment.set(idKey(ownEquipmentId), makeEquipment(ownEquipmentId, customerId));
  equipment.set(idKey(pendingEquipmentId), makeEquipment(pendingEquipmentId, ownerId, {
    status: "pending",
  }));
  equipment.set(idKey(rejectedEquipmentId), makeEquipment(rejectedEquipmentId, ownerId, {
    status: "rejected",
  }));
  equipment.set(idKey(deletedEquipmentId), makeEquipment(deletedEquipmentId, ownerId, {
    isDeleted: true,
  }));
});

after(async () => {
  restoreMethods?.();
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

test("Booking reuses the existing bookings collection and exposes Step 08 fields", () => {
  assert.equal(models.Booking.collection.collectionName, "bookings");
  for (const path of [
    "customerId",
    "ownerId",
    "equipmentId",
    "startDate",
    "endDate",
    "quantity",
    "rentalType",
    "unitPrice",
    "pricePerUnit",
    "rentalDuration",
    "subtotal",
    "totalAmount",
    "bookingStatus",
    "status",
    "paymentStatus",
    "additionalNotes",
    "notes",
  ]) {
    assert.ok(models.Booking.schema.path(path) || models.Booking.schema.virtualpath(path));
  }
  assert.ok(models.Booking.schema.indexes().some(([keys]) => keys.equipmentId === 1));
});

test("booking creation requires an authenticated customer", async () => {
  assert.equal((await apiCall("POST", "/api/bookings", undefined, validBody())).status, 401);
  assert.equal((await apiCall("POST", "/api/bookings", tokens.owner, validBody())).status, 403);
  assert.equal((await apiCall("POST", "/api/bookings", tokens.admin, validBody())).status, 403);
});

test("customers cannot book their own equipment", async () => {
  const response = await apiCall(
    "POST",
    "/api/bookings",
    tokens.customer,
    validBody({ equipmentId: ownEquipmentId.toString() }),
  );
  assert.equal(response.status, 403);
});

test("pending, rejected, and soft-deleted equipment cannot be booked", async () => {
  for (const id of [pendingEquipmentId, rejectedEquipmentId, deletedEquipmentId]) {
    const response = await apiCall(
      "POST",
      "/api/bookings",
      tokens.customer,
      validBody({ equipmentId: id.toString() }),
    );
    assert.equal(response.status, 404);
  }
});

test("malformed IDs, dates, past starts, and invalid quantities are rejected", async () => {
  const invalidBodies = [
    validBody({ equipmentId: "not-an-object-id" }),
    validBody({ startDate: "2026-02-30" }),
    validBody({ endDate: "not-a-date" }),
    validBody({ startDate: dateOffset(-1) }),
    validBody({ startDate: dateOffset(5), endDate: dateOffset(5) }),
    validBody({ quantity: 0 }),
    validBody({ quantity: 1.5 }),
    validBody({ quantity: "2.2" }),
  ];
  for (const body of invalidBodies) {
    assert.equal(
      (await apiCall("POST", "/api/bookings", tokens.customer, body)).status,
      400,
    );
  }
  assert.equal(
    (await apiCall(
      "GET",
      "/api/equipment/not-an-id/availability?startDate=2026-12-01&endDate=2026-12-03",
    )).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        `/api/equipment/${equipmentId}/availability?startDate=2026-12-01&endDate=2026-12-03&quantity=0`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        `/api/equipment/${equipmentId}/availability?startDate=2026-02-30&endDate=2026-12-03`,
      )
    ).status,
    400,
  );
});

test("daily, weekly, and monthly duration and price rounding are deterministic", () => {
  const date = (value) => new Date(`${value}T00:00:00.000Z`);
  assert.equal(
    service.calculateRentalDuration(date("2026-04-01"), date("2026-04-05"), "daily"),
    4,
  );
  assert.equal(
    service.calculateRentalDuration(date("2026-04-01"), date("2026-04-09"), "weekly"),
    2,
  );
  assert.equal(
    service.calculateRentalDuration(date("2026-03-01"), date("2026-04-01"), "monthly"),
    1,
  );
  assert.equal(
    service.calculateRentalDuration(date("2026-03-01"), date("2026-04-02"), "monthly"),
    2,
  );
  assert.equal(
    service.calculateRentalDuration(date("2026-01-31"), date("2026-02-28"), "monthly"),
    1,
  );
  assert.deepEqual(
    service.calculateRentalPrice({
      startDate: date("2026-04-01"),
      endDate: date("2026-04-09"),
      quantity: 2,
      rentalType: "weekly",
      pricePerUnit: 250,
    }),
    { rentalDuration: 2, subtotal: 1000, totalAmount: 1000 },
  );
});

test("server pricing and identities override protected client fields", async () => {
  const response = await apiCall(
    "POST",
    "/api/bookings",
    tokens.customer,
    validBody({
      price: 0.01,
      pricePerUnit: 0.01,
      unitPrice: 0.01,
      subtotal: 0.01,
      totalAmount: 0.01,
      rentalDuration: 999,
      rentalType: "monthly",
      customerId: otherCustomerId.toString(),
      ownerId: otherOwnerId.toString(),
      status: "confirmed",
      bookingStatus: "confirmed",
      paymentStatus: "paid",
    }),
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.customerId.toString(), customerId.toString());
  assert.equal(body.data.ownerId.toString(), ownerId.toString());
  assert.equal(body.data.pricePerUnit, 100);
  assert.equal(body.data.rentalDuration, 2);
  assert.equal(body.data.subtotal, 200);
  assert.equal(body.data.totalAmount, 200);
  assert.equal(body.data.status, "pending");
  assert.equal(body.data.paymentStatus, "unpaid");
  assert.equal(body.data.rentalType, "daily");
  assert.equal(equipment.get(idKey(equipmentId)).availableQuantity, 2);
});

test("creation is idempotent when a key is reused and rejects a changed payload", async () => {
  const key = "booking-unique-key-01";
  const first = await apiCall("POST", "/api/bookings", tokens.customer, validBody(), {
    "Idempotency-Key": key,
  });
  assert.equal(first.status, 201);
  const repeated = await apiCall("POST", "/api/bookings", tokens.customer, validBody(), {
    "Idempotency-Key": key,
  });
  assert.equal(repeated.status, 200);
  assert.equal(bookings.length, 1);
  const conflict = await apiCall(
    "POST",
    "/api/bookings",
    tokens.customer,
    validBody({ quantity: 2 }),
    { "Idempotency-Key": key },
  );
  assert.equal(conflict.status, 409);
});

test("overlapping confirmed and active bookings reduce availability only for intersecting dates", async () => {
  const requestedStart = new Date(`${dateOffset(4)}T00:00:00.000Z`);
  const requestedEnd = new Date(`${dateOffset(6)}T00:00:00.000Z`);
  addBooking({
    bookingStatus: "confirmed",
    quantity: 1,
    startDate: requestedStart,
    endDate: requestedEnd,
  });
  addBooking({
    bookingStatus: "active",
    quantity: 1,
    startDate: new Date(`${dateOffset(5)}T00:00:00.000Z`),
    endDate: new Date(`${dateOffset(7)}T00:00:00.000Z`),
  });
  addBooking({
    bookingStatus: "confirmed",
    quantity: 1,
    startDate: new Date(`${dateOffset(1)}T00:00:00.000Z`),
    endDate: requestedStart,
  });
  const response = await apiCall(
    "GET",
    `/api/equipment/${equipmentId}/availability?startDate=${dateOffset(4)}&endDate=${dateOffset(6)}&quantity=1`,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data, {
    availableQuantity: 2,
    reservedQuantity: 2,
    remainingQuantity: 0,
    requestedQuantity: 1,
    isAvailable: false,
  });
});

test("pending, cancelled, rejected, and completed bookings do not reserve inventory", async () => {
  for (const bookingStatus of ["pending", "cancelled", "rejected", "completed"]) {
    addBooking({ bookingStatus, quantity: 1 });
  }
  const response = await apiCall(
    "GET",
    `/api/equipment/${equipmentId}/availability?startDate=${dateOffset(4)}&endDate=${dateOffset(6)}`,
  );
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.reservedQuantity, 0);
  assert.equal(data.remainingQuantity, 2);
});

test("insufficient availability rejects a new booking", async () => {
  addBooking({
    bookingStatus: "confirmed",
    quantity: 2,
  });
  const response = await apiCall(
    "POST",
    "/api/bookings",
    tokens.customer,
    validBody(),
  );
  assert.equal(response.status, 409);
  assert.equal(bookings.length, 1);
  assert.equal(equipment.get(idKey(equipmentId)).reservationVersion, 0);
});

test("cancelling a confirmed booking releases its reservation without changing payment status", async () => {
  equipment.get(idKey(equipmentId)).availableQuantity = 1;
  const existing = addBooking({
    bookingStatus: "confirmed",
    paymentStatus: "paid",
  });
  const before = await apiCall(
    "GET",
    `/api/equipment/${equipmentId}/availability?startDate=${dateOffset(4)}&endDate=${dateOffset(6)}`,
  );
  assert.equal((await before.json()).data.remainingQuantity, 0);

  const cancel = await apiCall(
    "PATCH",
    `/api/bookings/${existing._id}/cancel`,
    tokens.customer,
    { reason: "Plans changed" },
  );
  assert.equal(cancel.status, 200);
  assert.equal(bookings[0].bookingStatus, "cancelled");
  assert.equal(bookings[0].paymentStatus, "paid");
  const afterCancel = await apiCall(
    "GET",
    `/api/equipment/${equipmentId}/availability?startDate=${dateOffset(4)}&endDate=${dateOffset(6)}`,
  );
  assert.equal((await afterCancel.json()).data.remainingQuantity, 1);
});

test("concurrent paid confirmations cannot overbook the last unit", async () => {
  equipment.get(idKey(equipmentId)).availableQuantity = 1;
  const first = addBooking({ paymentStatus: "paid", bookingStatus: "pending" });
  const second = addBooking({ paymentStatus: "paid", bookingStatus: "pending" });
  const responses = await Promise.all([
    apiCall(
      "PATCH",
      `/api/bookings/${first._id}/status`,
      tokens.owner,
      { status: "confirmed" },
    ),
    apiCall(
      "PATCH",
      `/api/bookings/${second._id}/status`,
      tokens.owner,
      { status: "confirmed" },
    ),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(
    bookings.filter((booking) => booking.bookingStatus === "confirmed").length,
    1,
  );
});

test("transactions fail closed when MongoDB does not support them", async () => {
  transactionsSupported = false;
  const response = await apiCall(
    "POST",
    "/api/bookings",
    tokens.customer,
    validBody(),
  );
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /replica set|sharded cluster/i);
  assert.equal(bookings.length, 0);
});

test("customers see only their own bookings and owner request lists are owner-scoped", async () => {
  const own = addBooking({ customerId, ownerId });
  addBooking({
    customerId: otherCustomerId,
    ownerId,
    equipmentId: otherEquipmentId,
  });
  addBooking({
    customerId: customerId,
    ownerId: otherOwnerId,
    equipmentId: otherEquipmentId,
  });

  const mine = await apiCall("GET", "/api/bookings/my-bookings", tokens.customer);
  assert.equal(mine.status, 200);
  const mineBody = await mine.json();
  assert.equal(mineBody.data.length, 2);
  assert.ok(mineBody.data.every((booking) => booking.customerId.toString() === customerId.toString()));
  assert.equal("email" in mineBody.data[0].ownerId, false);

  const ownerRequests = await apiCall(
    "GET",
    "/api/bookings/owner/requests",
    tokens.owner,
  );
  assert.equal(ownerRequests.status, 200);
  const ownerBody = await ownerRequests.json();
  assert.equal(ownerBody.data.length, 2);
  assert.ok(ownerBody.data.every((booking) => booking.ownerId.toString() === ownerId.toString()));

  assert.equal(
    (await apiCall("GET", `/api/bookings/${own._id}`, tokens.otherCustomer)).status,
    404,
  );
  assert.equal(
    (await apiCall("GET", `/api/bookings/${own._id}`, tokens.otherOwner)).status,
    404,
  );
  assert.equal(
    (await apiCall("GET", `/api/bookings/${own._id}`, tokens.admin)).status,
    200,
  );
});

test("owners cannot confirm unpaid bookings and rejected transitions require a reason", async () => {
  const unpaid = addBooking({ paymentStatus: "unpaid", bookingStatus: "pending" });
  const confirm = await apiCall(
    "PATCH",
    `/api/bookings/${unpaid._id}/status`,
    tokens.owner,
    { status: "confirmed" },
  );
  assert.equal(confirm.status, 409);
  assert.equal(unpaid.bookingStatus, "pending");

  const missingReason = await apiCall(
    "PATCH",
    `/api/bookings/${unpaid._id}/status`,
    tokens.owner,
    { status: "rejected" },
  );
  assert.equal(missingReason.status, 400);
  const reject = await apiCall(
    "PATCH",
    `/api/bookings/${unpaid._id}/status`,
    tokens.owner,
    { status: "rejected", reason: "Not available" },
  );
  assert.equal(reject.status, 200);
  assert.equal(unpaid.bookingStatus, "rejected");
  assert.equal(unpaid.rejectionReason, "Not available");
});

test("owners cannot skip booking lifecycle transitions", async () => {
  const pending = addBooking({ paymentStatus: "paid", bookingStatus: "pending" });
  const activeEarly = await apiCall(
    "PATCH",
    `/api/bookings/${pending._id}/status`,
    tokens.owner,
    { status: "active" },
  );
  assert.equal(activeEarly.status, 409);

  const confirmed = addBooking({
    bookingStatus: "confirmed",
    paymentStatus: "paid",
  });
  const completeEarly = await apiCall(
    "PATCH",
    `/api/bookings/${confirmed._id}/status`,
    tokens.owner,
    { status: "completed" },
  );
  assert.equal(completeEarly.status, 409);
  assert.equal(confirmed.bookingStatus, "confirmed");
});

test("pagination, status filters, and role checks work", async () => {
  for (let index = 0; index < 12; index += 1) {
    addBooking({
      bookingStatus: index % 2 ? "pending" : "rejected",
      createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    });
  }
  const firstPage = await apiCall(
    "GET",
    "/api/bookings/my-bookings",
    tokens.customer,
  );
  const firstPageBody = await firstPage.json();
  assert.equal(firstPageBody.data.length, 9);
  assert.deepEqual(firstPageBody.pagination, {
    currentPage: 1,
    totalPages: 2,
    totalItems: 12,
    limit: 9,
    hasNextPage: true,
    hasPrevPage: false,
  });

  const filtered = await apiCall(
    "GET",
    "/api/bookings/owner/requests?status=rejected&page=2&limit=2",
    tokens.owner,
  );
  const filteredBody = await filtered.json();
  assert.equal(filtered.status, 200);
  assert.equal(filteredBody.data.length, 2);
  assert.equal(filteredBody.pagination.totalItems, 6);
  assert.ok(filteredBody.data.every((booking) => booking.status === "rejected"));

  assert.equal(
    (await apiCall("GET", "/api/bookings/my-bookings", tokens.owner)).status,
    403,
  );
  assert.equal(
    (
      await apiCall(
        "GET",
        "/api/bookings/my-bookings?limit=51",
        tokens.customer,
      )
    ).status,
    400,
  );
});

test("completed and cancelled bookings cannot be cancelled again", async () => {
  const cancelled = addBooking({ bookingStatus: "cancelled" });
  const completed = addBooking({ bookingStatus: "completed" });
  assert.equal(
    (await apiCall(
      "PATCH",
      `/api/bookings/${cancelled._id}/cancel`,
      tokens.customer,
    )).status,
    409,
  );
  assert.equal(
    (await apiCall(
      "PATCH",
      `/api/bookings/${completed._id}/cancel`,
      tokens.customer,
    )).status,
    409,
  );
});
