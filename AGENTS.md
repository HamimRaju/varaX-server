# Repository notes

- This is a single npm package: an Express 5 + TypeScript API. Use Node.js `>=20.19`; install with `npm ci`.
- Source is under `src/`; keep relative TypeScript imports with `.js` extensions for NodeNext ESM.
- `src/express-app.ts` mounts the route modules; routes/controllers/services/models contain the API layers. `src/server.ts` is the local Node entrypoint; `src/index.ts` is the serverless adapter.
- The Stripe webhook route must stay mounted before `express.json()` so signature verification receives the raw body.
- Protected access uses the current database user's role and active status, not JWT role claims.

## Commands and tests

- `npm run dev` starts the local server; `npm run typecheck` checks without emitting; `npm run build` emits to `dist/`; `npm start` runs the build.
- `npm test` builds first, then runs the Node test suite. To run one suite: `npm run build && node --test test/bookings.test.mjs` (substitute a file in `test/`).
- Tests mock persistence and Stripe calls; they do not verify real MongoDB aggregations or transaction support. There is no lint script in `package.json`.

## Local and database constraints

- For local startup, copy `.env.example` to `.env` and configure its required values; the server needs reachable MongoDB and connects before listening. Never read or commit `.env` credentials.
- Use the `varax` database named in the example URI so the API shares the client's auth and marketplace data.
- Booking, payment fulfillment, and related status writes require MongoDB transactions; use a replica set or sharded cluster. Unsupported standalone MongoDB fails closed with `503`.
- See `README.md` for endpoint contracts, lifecycle rules, environment details, and deployment behavior.
