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
| `JWT_SECRET` | Reserved for a later authentication step |

Keep real credentials in the ignored `.env` file and never commit them.

## Model and Better Auth integration notes

The Mongoose user model explicitly uses the `users` collection. When Better Auth
is added, configure its user `modelName` as `users` so it shares that collection
instead of creating a separate default `user` collection. Use MongoDB-generated
ObjectIds (`advanced.database.generateId: false`) so Better Auth user IDs remain
compatible with the domain models' ObjectId references.

Define Better Auth's `role` and `isActive` additional fields with
`input: false`; this prevents public signup input from setting privileged values.
Give them defaults of `customer` and `true`, respectively. Authentication account
and session collections remain Better Auth's responsibility; this project does
not define credential or password fields on `User`.
