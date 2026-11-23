import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { Equipment } from "../dist/models/Equipment.js";
import {
  buildPublicEquipmentFilter,
  PUBLIC_EQUIPMENT_PROJECTION,
  searchPublicEquipment,
} from "../dist/services/equipment.service.js";
import {
  escapeRegex,
  parseEquipmentSearchQuery,
} from "../dist/utils/equipment-search-validation.js";
import {
  parseCreateEquipmentInput,
  parseUpdateEquipmentInput,
} from "../dist/utils/equipment-validation.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/varax-search-tests";
process.env.STRIPE_SECRET_KEY = "sk_test_varax_search_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_varax_search_tests";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "varax-api";
process.env.JWKS_URL = "http://localhost:3000/api/auth/jwks";

const now = new Date("2026-01-01T00:00:00.000Z");
const createListing = (id, values) => ({
  _id: new mongoose.Types.ObjectId(id.padStart(24, "0")),
  name: `Listing ${id}`,
  description: "Equipment for rent",
  category: "Electronics",
  location: "Dhaka",
  price: 100,
  rentalType: "daily",
  availableQuantity: 1,
  brand: "Generic",
  model: "Model",
  image: "https://images.example.test/equipment.jpg",
  ownerId: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
  status: "approved",
  isDeleted: false,
  createdAt: now,
  ...values,
});

const fixture = [
  createListing("1", {
    name: "Canon EOS R6",
    description: "Camera equipment",
    category: "Photography Equipment",
    location: "Banani, Dhaka",
    price: 200,
    brand: "Canon",
    model: "EOS R6",
    rentalType: "daily",
    availableQuantity: 3,
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
  }),
  createListing("2", {
    name: "Mahindra Tractor",
    description: "Agriculture tractor",
    category: "Agriculture Equipment",
    location: "Gazipur",
    price: 500,
    brand: "Mahindra",
    model: "275",
    rentalType: "weekly",
    availableQuantity: 0,
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
  }),
  createListing("3", {
    name: "Event Speaker",
    description: "Sound system for events",
    category: "Event Equipment",
    location: "Chattogram",
    price: 100,
    brand: "JBL",
    model: "X1",
    rentalType: "monthly",
    availableQuantity: 1,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  }),
  createListing("4", {
    name: "Equipment [Pro]",
    description: "Electronics listing",
    category: "Electronics",
    location: "Dhaka",
    price: 50,
    rentalType: "daily",
    availableQuantity: 0,
    createdAt: new Date("2026-01-05T00:00:00.000Z"),
  }),
  createListing("5", { status: "pending", price: 1 }),
  createListing("6", { isDeleted: true, price: 1 }),
];

let rows = [];
let queryTrace;
let originalFind;
let originalCountDocuments;
let server;
let baseUrl;

function matchesCondition(actual, expected) {
  if (expected && typeof expected === "object") {
    if ("$in" in expected) return expected.$in.includes(actual);
    if (typeof expected.$regex === "string") {
      return new RegExp(expected.$regex, expected.$options ?? "").test(
        String(actual ?? ""),
      );
    }
    if ("$gt" in expected && !(actual > expected.$gt)) return false;
    if ("$gte" in expected && !(actual >= expected.$gte)) return false;
    if ("$lt" in expected && !(actual < expected.$lt)) return false;
    if ("$lte" in expected && !(actual <= expected.$lte)) return false;
    return true;
  }
  return actual === expected;
}

function matchesFilter(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") {
      return expected.some((clause) =>
        Object.entries(clause).every(([key, value]) =>
          matchesCondition(row[key], value),
        ),
      );
    }
    return matchesCondition(row[field], expected);
  });
}

function applySort(items, sort) {
  const entries = Object.entries(sort ?? {});
  return [...items].sort((left, right) => {
    for (const [field, direction] of entries) {
      const leftValue =
        left[field] instanceof Date ? left[field].getTime() : left[field];
      const rightValue =
        right[field] instanceof Date ? right[field].getTime() : right[field];
      if (leftValue === rightValue) continue;
      return (leftValue < rightValue ? -1 : 1) * direction;
    }
    return 0;
  });
}

function projectRow(row, projection) {
  if (!projection) return { ...row };
  return Object.fromEntries(
    projection
      .split(/\s+/)
      .filter(Boolean)
      .map((field) => [field, row[field]]),
  );
}

before(async () => {
  originalFind = Equipment.find;
  originalCountDocuments = Equipment.countDocuments;

  Object.defineProperty(Equipment, "find", {
    configurable: true,
    writable: true,
    value(filter) {
      queryTrace = { filter, projection: undefined, sort: undefined, skip: 0, limit: 0 };
      const query = {
        select(projection) {
          queryTrace.projection = projection;
          return this;
        },
        sort(sort) {
          queryTrace.sort = sort;
          return this;
        },
        skip(skip) {
          queryTrace.skip = skip;
          return this;
        },
        limit(limit) {
          queryTrace.limit = limit;
          return this;
        },
        lean() {
          return this;
        },
        async exec() {
          return applySort(
            rows.filter((row) => matchesFilter(row, filter)),
            queryTrace.sort,
          )
            .slice(queryTrace.skip, queryTrace.skip + queryTrace.limit)
            .map((row) => projectRow(row, queryTrace.projection));
        },
      };
      return query;
    },
  });

  Object.defineProperty(Equipment, "countDocuments", {
    configurable: true,
    writable: true,
    value(filter) {
      queryTrace.countFilter = filter;
      return {
        async exec() {
          return rows.filter((row) => matchesFilter(row, filter)).length;
        },
      };
    },
  });

  const app = (await import("../dist/app.js")).default;
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  rows = fixture.map((row) => ({ ...row }));
  queryTrace = undefined;
});

after(async () => {
  Object.defineProperty(Equipment, "find", {
    configurable: true,
    writable: true,
    value: originalFind,
  });
  Object.defineProperty(Equipment, "countDocuments", {
    configurable: true,
    writable: true,
    value: originalCountDocuments,
  });
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("defaults to approved, non-deleted listings newest first", async () => {
  const result = await searchPublicEquipment(parseEquipmentSearchQuery({}));
  assert.equal(result.equipment.length, 4);
  assert.equal(result.equipment[0].name, "Equipment [Pro]");
  assert.deepEqual(result.pagination, {
    currentPage: 1,
    totalPages: 1,
    totalItems: 4,
    limit: 9,
    hasNextPage: false,
    hasPrevPage: false,
  });
  assert.equal(queryTrace.filter.status, "approved");
  assert.equal(queryTrace.filter.isDeleted, false);
  assert.equal(queryTrace.countFilter, queryTrace.filter);
  assert.equal(queryTrace.projection, PUBLIC_EQUIPMENT_PROJECTION);
  assert.equal(result.equipment[0].ownerId, undefined);
});

test("public listing filters and sort orders have supporting indexes", () => {
  const indexes = Equipment.schema.indexes();
  assert.ok(
    indexes.some(
      ([keys]) =>
        keys.status === 1 &&
        keys.isDeleted === 1 &&
        keys.createdAt === -1,
    ),
  );
  assert.ok(
    indexes.some(
      ([keys]) => keys.status === 1 && keys.isDeleted === 1 && keys.price === 1,
    ),
  );
});

test("case-insensitive search covers name, description, brand, model, and location", async () => {
  for (const [search, expectedName] of [
    ["cAnOn", "Canon EOS R6"],
    ["AGRICULTURE", "Mahindra Tractor"],
    ["mahindra", "Mahindra Tractor"],
    ["eOs r6", "Canon EOS R6"],
    ["cHaTt", "Event Speaker"],
  ]) {
    const result = await searchPublicEquipment(
      parseEquipmentSearchQuery({ search }),
    );
    assert.ok(result.equipment.some((item) => item.name === expectedName));
  }
});

test("regex metacharacters are escaped and treated literally", async () => {
  assert.equal(escapeRegex("[a].*"), "\\[a\\]\\.\\*");
  const result = await searchPublicEquipment(
    parseEquipmentSearchQuery({ search: "[" }),
  );
  assert.deepEqual(result.equipment.map((item) => item.name), ["Equipment [Pro]"]);
});

test("category slugs and canonical categories filter correctly", async () => {
  const slugResult = await searchPublicEquipment(
    parseEquipmentSearchQuery({ category: "photography" }),
  );
  assert.deepEqual(slugResult.equipment.map((item) => item.name), ["Canon EOS R6"]);

  const canonicalResult = await searchPublicEquipment(
    parseEquipmentSearchQuery({ category: "Event Equipment" }),
  );
  assert.deepEqual(canonicalResult.equipment.map((item) => item.name), ["Event Speaker"]);

  const multiCategoryResult = await searchPublicEquipment(
    parseEquipmentSearchQuery({ category: "photography,event" }),
  );
  assert.deepEqual(
    multiCategoryResult.equipment.map((item) => item.name).sort(),
    ["Canon EOS R6", "Event Speaker"].sort(),
  );
});

test("location filtering is a case-insensitive substring match", async () => {
  const result = await searchPublicEquipment(
    parseEquipmentSearchQuery({ location: "dHaKa" }),
  );
  assert.deepEqual(
    result.equipment.map((item) => item.name).sort(),
    ["Canon EOS R6", "Equipment [Pro]"].sort(),
  );
});

test("rentalType filtering works", async () => {
  const result = await searchPublicEquipment(
    parseEquipmentSearchQuery({ rentalType: "WEEKLY" }),
  );
  assert.deepEqual(result.equipment.map((item) => item.name), ["Mahindra Tractor"]);
  const multiTypeResult = await searchPublicEquipment(
    parseEquipmentSearchQuery({ rentalType: "weekly,monthly" }),
  );
  assert.ok(multiTypeResult.equipment.length > 0);
});

test("minimum and maximum price filters work separately and together", async () => {
  const minOnly = await searchPublicEquipment(
    parseEquipmentSearchQuery({ minPrice: "200" }),
  );
  assert.deepEqual(minOnly.equipment.map((item) => item.name).sort(), [
    "Canon EOS R6",
    "Mahindra Tractor",
  ]);

  const maxOnly = await searchPublicEquipment(
    parseEquipmentSearchQuery({ maxPrice: "100" }),
  );
  assert.deepEqual(maxOnly.equipment.map((item) => item.name).sort(), [
    "Equipment [Pro]",
    "Event Speaker",
  ]);

  const range = await searchPublicEquipment(
    parseEquipmentSearchQuery({ minPrice: "100", maxPrice: "200" }),
  );
  assert.deepEqual(range.equipment.map((item) => item.name).sort(), [
    "Canon EOS R6",
    "Event Speaker",
  ]);
});

test("availability=true means positive quantity and false means zero", async () => {
  const available = await searchPublicEquipment(
    parseEquipmentSearchQuery({ availability: "true" }),
  );
  assert.ok(available.equipment.every((item) => item.availableQuantity > 0));

  const unavailable = await searchPublicEquipment(
    parseEquipmentSearchQuery({ availability: "false" }),
  );
  assert.deepEqual(unavailable.equipment.map((item) => item.name), ["Equipment [Pro]", "Mahindra Tractor"]);
});

test("all supported sorting orders are applied in Mongo query order", async () => {
  const expected = {
    price_asc: ["Equipment [Pro]", "Event Speaker", "Canon EOS R6", "Mahindra Tractor"],
    price_desc: ["Mahindra Tractor", "Canon EOS R6", "Event Speaker", "Equipment [Pro]"],
    newest: ["Equipment [Pro]", "Canon EOS R6", "Mahindra Tractor", "Event Speaker"],
    oldest: ["Event Speaker", "Mahindra Tractor", "Canon EOS R6", "Equipment [Pro]"],
  };

  for (const [sort, names] of Object.entries(expected)) {
    const result = await searchPublicEquipment(
      parseEquipmentSearchQuery({ sort }),
    );
    assert.deepEqual(result.equipment.map((item) => item.name), names);
    assert.ok(queryTrace.sort, "sort should be applied in the database query");
  }
});

test("pagination applies skip/limit and returns accurate metadata", async () => {
  const result = await searchPublicEquipment(
    parseEquipmentSearchQuery({ page: "2", limit: "2" }),
  );
  assert.deepEqual(result.equipment.map((item) => item.name), [
    "Mahindra Tractor",
    "Event Speaker",
  ]);
  assert.equal(queryTrace.skip, 2);
  assert.equal(queryTrace.limit, 2);
  assert.deepEqual(result.pagination, {
    currentPage: 2,
    totalPages: 2,
    totalItems: 4,
    limit: 2,
    hasNextPage: false,
    hasPrevPage: true,
  });
});

test("empty results return an empty array and zero-page metadata", async () => {
  const result = await searchPublicEquipment(
    parseEquipmentSearchQuery({ search: "no matching listing" }),
  );
  assert.deepEqual(result.equipment, []);
  assert.deepEqual(result.pagination, {
    currentPage: 1,
    totalPages: 0,
    totalItems: 0,
    limit: 9,
    hasNextPage: false,
    hasPrevPage: false,
  });
});

test("invalid and protected query parameters are rejected", () => {
  for (const query of [
    { page: "0" },
    { page: "-1" },
    { limit: "51" },
    { limit: "1.5" },
    { minPrice: "-1" },
    { maxPrice: "Infinity" },
    { minPrice: "20", maxPrice: "10" },
    { category: "not-a-category" },
    { rentalType: "yearly" },
    { availability: "yes" },
    { sort: "random" },
    { search: { $ne: "" } },
    { status: "approved" },
    { isDeleted: "false" },
    { search: ["one", "two"] },
    { search: { $ne: "" } },
    { minPrice: { $gt: "0" } },
    { page: "9007199254740991", limit: "50" },
  ]) {
    assert.throws(() => parseEquipmentSearchQuery(query), { statusCode: 400 });
  }
});

test("equipment numeric inputs reject booleans but preserve numeric form values", () => {
  const valid = {
    name: "Camera",
    description: "Rental camera",
    category: "Electronics",
    location: "Dhaka",
    price: 10,
    rentalType: "daily",
    availableQuantity: 1,
    image: "https://images.example.test/camera.jpg",
  };
  assert.throws(
    () => parseCreateEquipmentInput({ ...valid, price: true }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseCreateEquipmentInput({ ...valid, availableQuantity: true }),
    { statusCode: 400 },
  );
  assert.equal(
    parseCreateEquipmentInput({
      ...valid,
      price: "10.25",
      availableQuantity: "2",
    }).price,
    10.25,
  );
});

test("equipment write validation rejects booleans but accepts form numeric strings", () => {
  const input = {
    name: "Camera",
    description: "Portable camera equipment",
    category: "Electronics",
    location: "Dhaka",
    price: 10,
    rentalType: "daily",
    availableQuantity: 1,
    image: "https://images.example.test/camera.jpg",
  };
  assert.throws(
    () => parseCreateEquipmentInput({ ...input, price: true }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseCreateEquipmentInput({ ...input, availableQuantity: true }),
    { statusCode: 400 },
  );
  const parsed = parseCreateEquipmentInput({
    ...input,
    price: "10.25",
    availableQuantity: "2",
  });
  assert.equal(parsed.price, 10.25);
  assert.equal(parsed.availableQuantity, 2);
});

test("equipment updates allow zero available units but reject invalid quantities", () => {
  assert.equal(
    parseUpdateEquipmentInput({ availableQuantity: "0" }).availableQuantity,
    0,
  );
  assert.throws(
    () => parseUpdateEquipmentInput({ availableQuantity: true }),
    { statusCode: 400 },
  );
});

test("combined filters use one Mongo filter for results and count", async () => {
  const result = await searchPublicEquipment(
    parseEquipmentSearchQuery({
      search: "canon",
      category: "photography",
      location: "DHAKA",
      rentalType: "daily",
      minPrice: "100",
      maxPrice: "300",
      availability: "true",
      sort: "price_asc",
      page: "1",
      limit: "9",
    }),
  );
  assert.deepEqual(result.equipment.map((item) => item.name), ["Canon EOS R6"]);
  assert.equal(queryTrace.countFilter, queryTrace.filter);
  assert.deepEqual(
    buildPublicEquipmentFilter(parseEquipmentSearchQuery({ availability: "true" })),
    { status: "approved", isDeleted: false, availableQuantity: { $gt: 0 } },
  );
});

test("GET /api/equipment applies combined search/filters/sort/pagination", async () => {
  const response = await fetch(
    `${baseUrl}/api/equipment?search=canon&category=photography&location=dhaka&rentalType=daily&minPrice=100&maxPrice=300&availability=true&sort=price_asc&page=1&limit=2`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.message, "Equipment fetched successfully.");
  assert.deepEqual(body.data.map((item) => item.name), ["Canon EOS R6"]);
  assert.equal(body.pagination.totalItems, 1);
  assert.equal(body.pagination.limit, 2);
});

test("GET /api/equipment rejects invalid query parameters with a safe 400", async () => {
  const response = await fetch(`${baseUrl}/api/equipment?limit=1000`);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.match(body.message, /limit/i);
});
