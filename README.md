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
- `npm test` — build and run the Node.js API/service tests.
- `npm start` — run the compiled server.

## Health check

`GET http://localhost:5000/api/health`

## Environment variables

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (defaults to `5000`) |
| `NODE_ENV` | `development`, `test`, or `production` |
| `MONGODB_URI` | Required MongoDB connection string |
| `STRIPE_SECRET_KEY` | Required Stripe secret key (`sk_test_…` or `sk_live_…`); server only |
| `STRIPE_WEBHOOK_SECRET` | Required webhook signing secret (`whsec_…`); server only |
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

## Bookings and availability

Customer booking endpoints require a bearer token and the `customer` role.
Owner request/status endpoints require the `owner` role. Booking details allow
the customer who placed the booking, the equipment owner, or an admin.

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST /api/bookings` | Customer | Create an unpaid booking request |
| `GET /api/bookings/my-bookings?page=1&limit=9` | Customer | List only the current customer's bookings |
| `GET /api/bookings/:id` | Customer, owner, or admin | Read an authorized booking |
| `PATCH /api/bookings/:id/cancel` | Customer | Cancel the current customer's eligible booking |
| `GET /api/bookings/owner/requests?status=pending&page=1&limit=9` | Owner | List only this owner's requests; `status` is optional |
| `PATCH /api/bookings/:id/status` | Owner | Confirm, reject, activate, or complete an eligible booking |
| `GET /api/equipment/:id/availability?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&quantity=1` | Public | Check date-specific availability |

All booking list endpoints default to page `1` and limit `9`; the maximum
limit is `50`. Owner request status filters accept `pending`, `confirmed`,
`active`, `completed`, `cancelled`, and `rejected`.

Example create request:

```http
POST /api/bookings
Authorization: Bearer <customer-token>
Idempotency-Key: booking-request-2026-12-01-01
Content-Type: application/json
```

```json
{
  "equipmentId": "64a1b2c3d4e5f67890123456",
  "startDate": "2026-12-01",
  "endDate": "2026-12-05",
  "quantity": 1,
  "contactNumber": "01XXXXXXXXX",
  "deliveryAddress": "Dhaka, Bangladesh",
  "notes": "Please contact before delivery"
}
```

The server derives customer and owner IDs, rental type, and price from trusted
records. Client-supplied pricing, status, payment, duration, and identity fields
are ignored. A new request is `pending` and `unpaid`; the response includes
`pricePerUnit`, `rentalDuration`, `subtotal`, and `totalAmount` snapshots. No
Stripe checkout, payment confirmation, or refund handling is implemented in
this step. Reusing the optional `Idempotency-Key` with the same request returns
the existing booking; reusing it with different data returns `409`.

Example response (`201 Created`):

```json
{
  "success": true,
  "message": "Booking request created. Payment is required before confirmation.",
  "data": {
    "_id": "64a1b2c3d4e5f67890123457",
    "equipmentId": "64a1b2c3d4e5f67890123456",
    "quantity": 1,
    "rentalType": "daily",
    "pricePerUnit": 250,
    "rentalDuration": 4,
    "subtotal": 1000,
    "totalAmount": 1000,
    "status": "pending",
    "paymentStatus": "unpaid"
  }
}
```

Example availability response:

```json
{
  "success": true,
  "data": {
    "availableQuantity": 5,
    "reservedQuantity": 2,
    "remainingQuantity": 3,
    "requestedQuantity": 1,
    "isAvailable": true
  }
}
```

Availability uses the half-open date range
`existing.startDate < requested.endDate AND existing.endDate > requested.startDate`.
Only `confirmed` and `active` bookings reserve inventory. Pending unpaid requests,
cancelled, rejected, and completed bookings do not. The stored
`availableQuantity` is never decremented; remaining quantity is the stored
quantity less overlapping reservations.

### Booking lifecycle

- Creation starts at `pending` / `unpaid`.
- An owner can confirm only a `paid` pending booking. The Stripe workflow that
  will set payment state is Step 09 and is intentionally not part of this API.
- An owner may reject only an unpaid pending booking and must provide a reason.
- A confirmed booking may become `active` during its rental dates; an active
  booking may become `completed` after its end date.
- A customer may cancel a pending booking or a confirmed booking before its
  start date. Cancellation does not change `paymentStatus`; refunds belong to
  the later payment workflow.

Invalid status transitions return `409`. Equipment ownership is checked from
the database, and customer/owner lists are scoped to the authenticated user.
Populated user data is limited to a name and optional image.

### Rental pricing and concurrency

Rental dates are UTC `YYYY-MM-DD` values and the end date is exclusive. Daily
rentals charge for each calendar day. Weekly rentals round any partial
seven-day period up to one full week. Monthly rentals round up by calendar-month
anniversaries, clamping an anniversary to the last day of shorter months.
`subtotal = pricePerUnit × rentalDuration × quantity`; `totalAmount` currently
equals subtotal because no tax/fee policy exists. These rules are server-side
and the unit price is snapshotted at booking time.

MongoDB transactions are required for booking creation and status/cancellation
operations. Each transaction writes an inventory version field on the shared
equipment document before checking or changing reserving bookings. This write
serializes transactions for one equipment record and prevents two concurrent
confirmations from both consuming the same remaining quantity. The field is
only a concurrency marker; it does not decrement `availableQuantity`.

MongoDB must run as a replica set or sharded cluster with transaction support.
Standalone MongoDB deployments receive `503` for transaction-dependent booking
operations; the server deliberately does not use a process-local lock or an
unsafe fallback. Configure a replica set before enabling booking writes.

## Stripe Checkout and payment status

Stripe is initialized with the server-only `STRIPE_SECRET_KEY`. Set
`STRIPE_WEBHOOK_SECRET` to the signing secret for the exact webhook endpoint.
Both are required by the backend configuration and must never use a
`NEXT_PUBLIC_` prefix or be sent to the browser. `.env` files remain ignored by
Git; `.env.example` contains placeholders only.

The backend uses BDT (`bdt`) and converts the booking's server-calculated
major-unit `totalAmount` to integer paisa (`amountMinorUnits`) for Stripe. The
Payment record retains the major-unit `amount` for compatibility and the
integer minor-unit value as the authoritative Stripe amount. Before production,
confirm that the connected Stripe account and enabled payment methods support
BDT; unsupported currency/account combinations fail checkout safely instead of
silently charging in another currency.

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST /api/payments/create-checkout-session` | Customer | Create or reuse a Checkout Session for their pending booking |
| `GET /api/payments/:bookingId/status` | Customer, equipment owner, or admin | Read safe, role-scoped payment status |
| `POST /api/payments/webhook` | Stripe only | Verify and process Stripe events using the raw request body |

Example request:

```http
POST /api/payments/create-checkout-session
Authorization: Bearer <customer-token>
Content-Type: application/json
```

```json
{ "bookingId": "64a1b2c3d4e5f67890123456" }
```

The backend ignores client-provided amounts, currency, user IDs, and payment
state. Example response:

```json
{
  "success": true,
  "message": "Checkout Session created.",
  "data": {
    "paymentId": "64a1b2c3d4e5f67890123457",
    "sessionId": "cs_test_...",
    "url": "https://checkout.stripe.com/c/pay/...",
    "expiresAt": "2026-12-01T12:00:00.000Z"
  }
}
```

The caller redirects the browser to `data.url`. Repeated requests for the same
booking return the existing active session. The backend stores a pending
Payment attempt before calling Stripe and uses a server-generated Stripe
idempotency key. A unique partial index allows no more than one active
Checkout Session per booking.

### Webhooks and payment lifecycle

Configure the Stripe endpoint as
`https://<backend-host>/api/payments/webhook` and subscribe to:

- `checkout.session.completed`
- `checkout.session.expired`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `payment_intent.payment_failed`
- `charge.refunded`

The webhook route is mounted before Express JSON parsing and uses
`express.raw({ type: "application/json" })`. Stripe's signature is verified
against those exact bytes. The frontend success redirect is never treated as
payment evidence.

Checkout creation leaves the booking `pending` and unpaid. A signed webhook
must report `payment_status: "paid"` and match the stored amount, currency,
session/payment identifiers, and booking snapshot. Within a MongoDB
transaction, the backend serializes against the Step 08 equipment inventory
marker, rechecks availability, and then marks both the Payment paid and the
booking confirmed. It does not maintain a second reservation counter.

Expired sessions and failed PaymentIntents mark the corresponding Payment (and
eligible pending booking) failed; they never confirm a booking. Successful
events are idempotent: processed Stripe event IDs are stored on the Payment,
terminal payment states are not downgraded, and the transaction protects
related Payment/Booking writes. Webhook handling also fails closed with `503`
if MongoDB transactions are unavailable.

A PaymentIntent failure alone does not necessarily close its Checkout Session.
The payment attempt is marked failed but its active-session guard is retained
while the session remains open, so a repeated checkout request reuses that same
session instead of creating a second payable session. The guard is released
when the session expires or reaches a terminal state.

If Stripe reports a successful payment but the booking is cancelled, invalid,
mispriced, or no longer has enough inventory, the backend records the Payment
as paid with `fulfillmentStatus: "refund_required"` and does not confirm the
booking. It then attempts a full Stripe refund with a stable idempotency key.
On refund success, Payment and Booking are marked refunded. If the Stripe
refund request fails or remains pending, the record remains visibly
`refund_required` or `refund_pending`; operators must inspect the PaymentIntent,
refund it in the Stripe Dashboard if necessary, and ensure Stripe delivers
`charge.refunded`. That event reconciles the database. Do not delete the
historical Payment record or manually mark an unverified payment refunded.

For local webhook development:

```sh
stripe listen --forward-to localhost:5000/api/payments/webhook
```

Copy the CLI's `whsec_…` value into `STRIPE_WEBHOOK_SECRET`, then use Stripe
test-mode Checkout sessions or `stripe trigger checkout.session.completed`.
Automated tests use mocked Stripe calls and generated webhook signatures; they
do not make real charges.

### Frontend integration contract

After a real backend booking has been created, the client obtains a Better Auth
backend access token with `authClient.token()` and sends the request above.
Redirect to the returned `data.url`. Stripe returns to
`/payment-success?bookingId=<bookingId>&session_id=<CHECKOUT_SESSION_ID>` or
`/payment?bookingId=<bookingId>`. On either return, fetch
`GET /api/payments/<bookingId>/status` with the bearer token and show the
backend's `data.status`; never set payment or booking status in local state
based on the redirect.

The current `varaX-client` payment and equipment booking flow still uses
localStorage demo records, numeric equipment IDs, and `VX-…` booking IDs. Those
are not MongoDB ObjectIds and cannot be charged by these endpoints. The client
was intentionally left unchanged rather than adding a checkout call that could
only fail; wire its booking creation to the Step 08 API and persist the returned
Mongo booking ID before enabling this redirect flow.

Once that backend booking ID is available, the minimal client call is:

```ts
const { data: tokenData } = await authClient.token();
const response = await fetch(
  `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/payments/create-checkout-session`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bookingId }),
  },
);
const result = await response.json();
if (!response.ok) throw new Error(result.message);
window.location.assign(result.data.url);
```

After Stripe redirects back, use the authenticated
`GET /api/payments/${bookingId}/status` response for the displayed outcome.
