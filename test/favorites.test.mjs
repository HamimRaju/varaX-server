import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-favorite-tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const customerId = new mongoose.Types.ObjectId();
const otherCustomerId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const approvedEquipmentId = new mongoose.Types.ObjectId();
const approvedEquipmentId2 = new mongoose.Types.ObjectId();
const pendingEquipmentId = new mongoose.Types.ObjectId();
const rejectedEquipmentId = new mongoose.Types.ObjectId();
const deletedEquipmentId = new mongoose.Types.ObjectId();

const users = new Map();
const equipment = new Map();
let favorites = [];
let forceDuplicateKeyError = false;
let lastFavoriteAggregatePipeline;
let apiServer;
let authServer;
let apiBase;
let authBase;
let privateKey;
let publicJwk;
let keyId;
let customerToken;
let otherCustomerToken;
let ownerToken;
let FavoriteModel;
let restoreMethods;

function sameId(left, right) {
  return String(left) === String(right);
}

function favoriteBelongsTo(favorite, userId) {
  return (
    sameId(favorite.userId, userId) || sameId(favorite.customerId, userId)
  );
}

function equipmentSummary(item) {
  return {
    _id: item._id,
    name: item.name,
    image: item.image,
    category: item.category,
    location: item.location,
    price: item.price,
    rentalType: item.rentalType,
    availableQuantity: item.availableQuantity,
    available: item.availableQuantity > 0,
  };
}

function parseMatchUserId(match) {
  return match.$or?.[0]?.userId ?? match.$or?.[1]?.customerId;
}

before(async () => {
  authServer = createServer((request, response) => {
    if (request.url?.split("?")[0] !== "/api/auth/jwks") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  authBase = await listen(authServer);
  process.env.BETTER_AUTH_URL = authBase;
  process.env.NEXT_PUBLIC_APP_URL = authBase;
  process.env.CLIENT_URL = authBase;
  process.env.BACKEND_URL = authBase;
  process.env.JWT_ISSUER = authBase;
  process.env.JWKS_URL = `${authBase}/api/auth/jwks`;
  const keyPair = await generateKeyPair("EdDSA");
  privateKey = keyPair.privateKey;
  keyId = "favorites-test-key";
  publicJwk = {
    ...await exportJWK(keyPair.publicKey),
    kid: keyId,
    alg: "EdDSA",
    use: "sig",
  };

  const { User } = await import("../dist/models/User.js");
  const { Equipment } = await import("../dist/models/Equipment.js");
  const { Favorite } = await import("../dist/models/Favorite.js");
  FavoriteModel = Favorite;

  users.set(customerId.toString(), {
    _id: customerId,
    name: "Favorite Customer",
    email: "favorite-customer@example.test",
    role: "customer",
    isActive: true,
  });
  users.set(otherCustomerId.toString(), {
    _id: otherCustomerId,
    name: "Other Customer",
    email: "other-customer@example.test",
    role: "customer",
    isActive: true,
  });
  users.set(ownerId.toString(), {
    _id: ownerId,
    name: "Equipment Owner",
    email: "equipment-owner@example.test",
    role: "owner",
    isActive: true,
  });

  equipment.set(approvedEquipmentId.toString(), {
    _id: approvedEquipmentId,
    name: "Approved Camera",
    image: "https://images.example.test/camera.jpg",
    category: "Photography Equipment",
    location: "Dhaka",
    price: 200,
    rentalType: "daily",
    availableQuantity: 2,
    status: "approved",
    isDeleted: false,
  });
  equipment.set(approvedEquipmentId2.toString(), {
    _id: approvedEquipmentId2,
    name: "Approved Tractor",
    image: "https://images.example.test/tractor.jpg",
    category: "Agriculture Equipment",
    location: "Gazipur",
    price: 500,
    rentalType: "weekly",
    availableQuantity: 0,
    status: "approved",
    isDeleted: false,
  });
  equipment.set(pendingEquipmentId.toString(), {
    _id: pendingEquipmentId,
    name: "Pending Item",
    status: "pending",
    isDeleted: false,
  });
  equipment.set(rejectedEquipmentId.toString(), {
    _id: rejectedEquipmentId,
    name: "Rejected Item",
    status: "rejected",
    isDeleted: false,
  });
  equipment.set(deletedEquipmentId.toString(), {
    _id: deletedEquipmentId,
    name: "Deleted Item",
    status: "approved",
    isDeleted: true,
  });

  const originalUserFindById = User.findById;
  const originalEquipmentFindOne = Equipment.findOne;
  const originalFavoriteFindOne = Favorite.findOne;
  const originalFavoriteCreate = Favorite.create;
  const originalFavoriteAggregate = Favorite.aggregate;
  const originalFavoriteFindOneAndDelete = Favorite.findOneAndDelete;

  Object.defineProperty(User, "findById", {
    configurable: true,
    writable: true,
    value(id) {
      return {
        select() { return this; },
        lean() { return this; },
        async exec() { return users.get(String(id)) ?? null; },
      };
    },
  });

  Object.defineProperty(Equipment, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return {
        select() { return this; },
        lean() { return this; },
        async exec() {
          const item = equipment.get(String(filter._id));
          if (
            !item ||
            item.status !== filter.status ||
            item.isDeleted !== filter.isDeleted
          ) {
            return null;
          }
          return { _id: item._id };
        },
      };
    },
  });

  Object.defineProperty(Favorite, "findOne", {
    configurable: true,
    writable: true,
    value(filter) {
      return {
        select() { return this; },
        lean() { return this; },
        async exec() {
          const found = favorites.find(
            (favorite) =>
              sameId(favorite.equipmentId, filter.equipmentId) &&
              filter.$or.some((condition) => {
                const queryUserId = condition.userId ?? condition.customerId;
                return favoriteBelongsTo(favorite, queryUserId);
              }),
          );
          return found ? { _id: found._id } : null;
        },
      };
    },
  });

  Object.defineProperty(Favorite, "create", {
    configurable: true,
    writable: true,
    async value(data) {
      if (forceDuplicateKeyError) {
        const error = new Error("Duplicate index key.");
        error.code = 11000;
        throw error;
      }
      const existing = favorites.find(
        (favorite) =>
          sameId(favorite.equipmentId, data.equipmentId) &&
          favoriteBelongsTo(favorite, data.userId),
      );
      if (existing) {
        const error = new Error("Duplicate index key.");
        error.code = 11000;
        throw error;
      }
      const favorite = {
        _id: new mongoose.Types.ObjectId(),
        ...data,
        createdAt: new Date(),
      };
      favorites.push(favorite);
      return favorite;
    },
  });

  Object.defineProperty(Favorite, "aggregate", {
    configurable: true,
    writable: true,
    value(pipeline) {
      lastFavoriteAggregatePipeline = pipeline;
      return {
        async exec() {
          const match = pipeline[0].$match;
          const queryUserId = parseMatchUserId(match);
          const offset = pipeline.at(-1).$facet.items.find((stage) => "$skip" in stage).$skip;
          const limit = pipeline.at(-1).$facet.items.find((stage) => "$limit" in stage).$limit;
          const visible = favorites
            .filter((favorite) => favoriteBelongsTo(favorite, queryUserId))
            .map((favorite) => ({
              favorite,
              equipment: equipment.get(String(favorite.equipmentId)),
            }))
            .filter(
              ({ equipment: item }) =>
                item?.status === "approved" && item.isDeleted === false,
            )
            .sort(
              (left, right) =>
                right.favorite.createdAt.getTime() -
                left.favorite.createdAt.getTime(),
            );
          return [{
            items: visible.slice(offset, offset + limit).map(({ favorite, equipment: item }) => ({
              _id: favorite._id,
              createdAt: favorite.createdAt,
              equipmentId: equipmentSummary(item),
            })),
            metadata: visible.length ? [{ totalItems: visible.length }] : [],
          }];
        },
      };
    },
  });

  Object.defineProperty(Favorite, "findOneAndDelete", {
    configurable: true,
    writable: true,
    value(filter) {
      return {
        select() { return this; },
        lean() { return this; },
        async exec() {
          const index = favorites.findIndex(
            (favorite) =>
              sameId(favorite.equipmentId, filter.equipmentId) &&
              filter.$or.some((condition) =>
                favoriteBelongsTo(
                  favorite,
                  condition.userId ?? condition.customerId,
                ),
              ),
          );
          if (index === -1) return null;
          const [removed] = favorites.splice(index, 1);
          return {
            _id: removed._id,
            equipmentId: removed.equipmentId,
            createdAt: removed.createdAt,
          };
        },
      };
    },
  });

  restoreMethods = () => {
    for (const [model, methods] of [
      [User, { findById: originalUserFindById }],
      [Equipment, { findOne: originalEquipmentFindOne }],
      [
        Favorite,
        {
          findOne: originalFavoriteFindOne,
          create: originalFavoriteCreate,
          aggregate: originalFavoriteAggregate,
          findOneAndDelete: originalFavoriteFindOneAndDelete,
        },
      ],
    ]) {
      for (const [key, value] of Object.entries(methods)) {
        Object.defineProperty(model, key, {
          configurable: true,
          writable: true,
          value,
        });
      }
    }
  };

  const app = (await import("../dist/app.js")).default;
  apiServer = createServer(app);
  apiBase = await listen(apiServer);
  const sign = async (userId, role) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: "EdDSA", kid: keyId })
      .setIssuer(authBase)
      .setAudience("varax-api")
      .setSubject(userId.toString())
      .setExpirationTime("5m")
      .sign(privateKey);
  customerToken = await sign(customerId, "customer");
  otherCustomerToken = await sign(otherCustomerId, "customer");
  ownerToken = await sign(ownerId, "owner");
});

beforeEach(() => {
  favorites = [];
  forceDuplicateKeyError = false;
  lastFavoriteAggregatePipeline = undefined;
});

after(async () => {
  restoreMethods?.();
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
});

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

function createFavorite(userId, equipmentId, createdAt, legacy = false) {
  return {
    _id: new mongoose.Types.ObjectId(),
    ...(legacy
      ? { customerId: userId }
      : { userId, customerId: userId }),
    equipmentId,
    createdAt,
  };
}

test("Favorite uses one collection with unique canonical and legacy indexes", () => {
  assert.equal(FavoriteModel.collection.collectionName, "favorites");
  const indexes = FavoriteModel.schema.indexes();
  assert.ok(
    indexes.some(
      ([keys, options]) =>
        keys.userId === 1 &&
        keys.equipmentId === 1 &&
        options.unique === true &&
        options.partialFilterExpression?.userId?.$type === "objectId",
    ),
  );
  assert.ok(
    indexes.some(
      ([keys, options]) =>
        keys.customerId === 1 &&
        keys.equipmentId === 1 &&
        options.unique === true,
    ),
  );
});

test("all favorites endpoints require an authenticated customer", async () => {
  for (const [method, path] of [
    ["POST", `/api/favorites/${approvedEquipmentId}`],
    ["GET", "/api/favorites"],
    ["DELETE", `/api/favorites/${approvedEquipmentId}`],
  ]) {
    assert.equal((await apiCall(method, path)).status, 401);
  }

  for (const [method, path] of [
    ["POST", `/api/favorites/${approvedEquipmentId}`],
    ["GET", "/api/favorites"],
    ["DELETE", `/api/favorites/${approvedEquipmentId}`],
  ]) {
    assert.equal((await apiCall(method, path, ownerToken)).status, 403);
  }
});

test("customer can add approved equipment using token identity, not body userId", async () => {
  const response = await apiCall(
    "POST",
    `/api/favorites/${approvedEquipmentId}`,
    customerToken,
    { userId: otherCustomerId.toString() },
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.equipmentId, approvedEquipmentId.toString());
  assert.equal("userId" in body.data, false);
  assert.equal(favorites[0].userId.toString(), customerId.toString());
  assert.equal(favorites[0].customerId.toString(), customerId.toString());
});

test("duplicate favorites return 409 and duplicate-key races are handled", async () => {
  favorites.push(
    createFavorite(customerId, approvedEquipmentId, new Date()),
  );
  assert.equal(
    (
      await apiCall(
        "POST",
        `/api/favorites/${approvedEquipmentId}`,
        customerToken,
      )
    ).status,
    409,
  );

  forceDuplicateKeyError = true;
  assert.equal(
    (
      await apiCall(
        "POST",
        `/api/favorites/${approvedEquipmentId2}`,
        customerToken,
      )
    ).status,
    409,
  );
});

test("pending, rejected, and soft-deleted equipment cannot be favorited", async () => {
  for (const equipmentId of [
    pendingEquipmentId,
    rejectedEquipmentId,
    deletedEquipmentId,
  ]) {
    assert.equal(
      (
        await apiCall(
          "POST",
          `/api/favorites/${equipmentId}`,
          customerToken,
        )
      ).status,
      404,
    );
  }
});

test("favorites are customer-scoped and only populate approved equipment", async () => {
  favorites = [
    createFavorite(customerId, approvedEquipmentId, new Date("2026-05-02")),
    createFavorite(customerId, approvedEquipmentId2, new Date("2026-05-01"), true),
    createFavorite(otherCustomerId, approvedEquipmentId, new Date("2026-05-03")),
    createFavorite(customerId, pendingEquipmentId, new Date("2026-05-04")),
    createFavorite(customerId, rejectedEquipmentId, new Date("2026-05-05")),
    createFavorite(customerId, deletedEquipmentId, new Date("2026-05-06")),
  ];

  const response = await apiCall("GET", "/api/favorites", customerToken);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.length, 2);
  assert.deepEqual(
    body.data.map((favorite) => favorite.equipmentId.name),
    ["Approved Camera", "Approved Tractor"],
  );
  assert.equal(body.data[0].equipmentId.available, true);
  assert.equal(body.data[1].equipmentId.available, false);
  assert.equal("userId" in body.data[0], false);

  const match = lastFavoriteAggregatePipeline[0].$match;
  assert.equal(match.$or[0].userId.toString(), customerId.toString());
  assert.equal(match.$or[1].customerId.toString(), customerId.toString());
  assert.deepEqual(
    lastFavoriteAggregatePipeline.find((stage) => stage.$match?.["equipment.status"])
      .$match,
    { "equipment.status": "approved", "equipment.isDeleted": false },
  );
});

test("favorites pagination applies defaults, limits, and accurate totals", async () => {
  favorites = [];
  for (let index = 0; index < 12; index += 1) {
    const equipmentId = new mongoose.Types.ObjectId();
    equipment.set(equipmentId.toString(), {
      _id: equipmentId,
      name: `Page item ${index}`,
      image: "https://images.example.test/item.jpg",
      category: "Electronics",
      location: "Dhaka",
      price: 100 + index,
      rentalType: "daily",
      availableQuantity: 1,
      status: "approved",
      isDeleted: false,
    });
    favorites.push(
      createFavorite(
        customerId,
        equipmentId,
        new Date(Date.UTC(2026, 5, index + 1)),
      ),
    );
  }

  const defaultResponse = await apiCall("GET", "/api/favorites", customerToken);
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultBody.data.length, 9);
  assert.deepEqual(defaultBody.pagination, {
    currentPage: 1,
    totalPages: 2,
    totalItems: 12,
    limit: 9,
    hasNextPage: true,
    hasPrevPage: false,
  });

  const pageResponse = await apiCall(
    "GET",
    "/api/favorites?page=2&limit=2",
    customerToken,
  );
  const pageBody = await pageResponse.json();
  assert.equal(pageBody.data.length, 2);
  assert.equal(pageBody.pagination.currentPage, 2);
  assert.equal(pageBody.pagination.totalPages, 6);
  assert.equal(pageBody.pagination.totalItems, 12);
  assert.equal(pageBody.pagination.limit, 2);
  assert.equal(pageBody.pagination.hasNextPage, true);
  assert.equal(pageBody.pagination.hasPrevPage, true);
});

test("empty favorites and invalid pagination return consistent responses", async () => {
  favorites = [];
  const emptyResponse = await apiCall("GET", "/api/favorites", customerToken);
  assert.equal(emptyResponse.status, 200);
  const emptyBody = await emptyResponse.json();
  assert.deepEqual(emptyBody.data, []);
  assert.deepEqual(emptyBody.pagination, {
    currentPage: 1,
    totalPages: 0,
    totalItems: 0,
    limit: 9,
    hasNextPage: false,
    hasPrevPage: false,
  });

  assert.equal(
    (await apiCall("GET", "/api/favorites?page=0", customerToken)).status,
    400,
  );
  assert.equal(
    (await apiCall("GET", "/api/favorites?limit=51", customerToken)).status,
    400,
  );
  assert.equal(
    (await apiCall("GET", "/api/favorites?sort=newest", customerToken)).status,
    400,
  );
});

test("customers remove only their own favorites and IDs are validated", async () => {
  favorites = [
    createFavorite(customerId, approvedEquipmentId, new Date()),
    createFavorite(otherCustomerId, approvedEquipmentId2, new Date()),
  ];

  assert.equal(
    (
      await apiCall(
        "DELETE",
        `/api/favorites/${approvedEquipmentId}`,
        customerToken,
      )
    ).status,
    200,
  );
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0].customerId.toString(), otherCustomerId.toString());

  assert.equal(
    (
      await apiCall(
        "DELETE",
        `/api/favorites/${approvedEquipmentId2}`,
        customerToken,
      )
    ).status,
    404,
  );
  assert.equal(favorites.length, 1);

  assert.equal(
    (await apiCall("POST", "/api/favorites/not-an-id", customerToken)).status,
    400,
  );
  assert.equal(
    (await apiCall("DELETE", "/api/favorites/not-an-id", customerToken)).status,
    400,
  );
});
