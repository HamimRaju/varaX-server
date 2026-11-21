# VaraX Server

Express and TypeScript backend for the VaraX equipment rental platform.

## Requirements

- Node.js 20.19 or newer
- npm
- A reachable MongoDB instance

## Getting started

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to the MongoDB connection string and `CLIENT_URL` to the
   frontend origin (for example, `http://localhost:3000`).
4. Start the development server with `npm run dev`.

The server connects to MongoDB before it begins listening. It will exit with a
clear error if `MONGODB_URI` is missing or the database cannot be reached.

## Scripts

- `npm run dev` — run the server with `tsx` watch mode.
- `npm run typecheck` — type-check without emitting files.
- `npm run build` — compile TypeScript into `dist/`.
- `npm test` — build and run the Node.js equipment-search tests.
- `npm start` — run the compiled server.

## Health check

`GET http://localhost:5000/api/health`

## Environment variables

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (defaults to `5000`) |
| `NODE_ENV` | `development`, `test`, or `production` |
| `MONGODB_URI` | Required MongoDB connection string |
| `CLIENT_URL` | Frontend origin allowed by CORS; required in production |
| `JWT_ISSUER` | Must match the issuer configured in Better Auth |
| `JWT_AUDIENCE` | Must match the audience configured in Better Auth |
| `JWKS_URL` | Better Auth's public JWKS endpoint, normally `/api/auth/jwks` |

Keep real credentials in the ignored `.env` file and never commit them.
Express will verify Better Auth's asymmetric signing keys through JWKS; it does
not need Better Auth's secret or a separate shared JWT secret.

## Model and Better Auth integration

The Mongoose user model and Better Auth both use the `users` collection. Better
Auth uses MongoDB-generated ObjectIds (`advanced.database.generateId: false`) so
user IDs remain compatible with the domain models' ObjectId references.

Better Auth's `role` and `isActive` additional fields are server-owned and
default to `customer` and `true`. Authentication accounts and sessions remain
Better Auth's responsibility; the application User model does not store passwords.

## Temporary authorization smoke routes

In development and test environments only, these routes exercise the middleware:

- `GET /api/test/customer`
- `GET /api/test/owner`
- `GET /api/test/admin`

Retrieve an access token from Better Auth's `/api/auth/token` endpoint (or
`authClient.token()`) and send it as `Authorization: Bearer <token>`. These test
routes are not mounted in production.

## Public equipment listing

`GET /api/equipment` returns only approved, non-deleted equipment. Supported
query parameters:

| Parameter | Description |
| --- | --- |
| `search` | Case-insensitive literal search across name, description, brand, model, and location. Regex characters are escaped. |
| `category` | Equipment category; accepts canonical category names and frontend slugs (`construction`, `photography`, `vehicles`, `agriculture`, `electronics`, `event`). |
| `location` | Case-insensitive literal substring match. |
| `rentalType` | `daily`, `weekly`, or `monthly`. |
| `minPrice`, `maxPrice` | Inclusive, non-negative price bounds. |
| `availability` | `true` means `availableQuantity > 0`; `false` means zero. |
| `sort` | `price_asc`, `price_desc`, `newest` (default), or `oldest`. |
| `page` | One-based page number; defaults to `1`. |
| `limit` | Page size; defaults to `9`, maximum `50`. |

Example:

```http
GET /api/equipment?search=canon&category=photography&location=dhaka&rentalType=daily&minPrice=1000&maxPrice=5000&availability=true&sort=price_asc&page=1&limit=9
```

The response retains the existing `{ success, data }` convention and adds a
message and pagination metadata:

```json
{
  "success": true,
  "message": "Equipment fetched successfully.",
  "data": [],
  "pagination": {
    "currentPage": 1,
    "totalPages": 0,
    "totalItems": 0,
    "limit": 9,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

## Favorites

All Favorites endpoints require `Authorization: Bearer <token>` and the
authenticated `customer` role.

- `POST /api/favorites/:equipmentId` — add an approved, non-deleted listing.
- `GET /api/favorites?page=1&limit=9` — list the customer's visible favorite
  equipment, with populated card fields.
- `DELETE /api/favorites/:equipmentId` — remove only the customer's favorite.

Pagination defaults to page `1` and limit `9`; the maximum limit is `50`.
Equipment no longer approved or soft-deleted is excluded from the list.

Example:

```http
POST /api/favorites/64a1b2c3d4e5f67890123456
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "message": "Equipment added to favorites.",
  "data": {
    "equipmentId": "64a1b2c3d4e5f67890123456",
    "createdAt": "2026-11-21T12:00:00.000Z"
  }
}
```

`GET /api/favorites` returns `data` entries containing the favorite ID,
`createdAt`, and an `equipmentId` object with `_id`, `name`, `image`, `category`,
`location`, `price`, `rentalType`, `availableQuantity`, and `available`. The
response includes the same pagination metadata as the equipment listing.

Invalid IDs or pagination return `400`; missing/invalid authentication returns
`401`; non-customers return `403`; unavailable equipment or a missing favorite
returns `404`; duplicate favorites return `409`.

The Step 02 Favorite collection used `customerId`. Existing documents remain
supported; new favorites use `userId` and retain `customerId` for the existing
unique index during the transition.
