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
