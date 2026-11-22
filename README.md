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

## Customer dashboard APIs

Every customer dashboard endpoint requires `Authorization: Bearer <token>`,
`verifyToken`, and the `customer` role (`verifyRenter`). Owner and admin tokens
receive `403`; the customer ID is always taken from the verified database-backed
identity.

| Method and path | Purpose |
| --- | --- |
| `GET /api/customer/dashboard/overview` | Customer booking, favorite, spending, and recent-booking summary |
| `GET /api/customer/dashboard/bookings` | Filtered and paginated booking history |
| `GET /api/customer/dashboard/favorites` | Paged favorites using the existing favorite aggregation |
| `GET /api/customer/dashboard/profile` | Safe customer profile |
| `PATCH /api/customer/dashboard/profile` | Update name, profile image, and/or phone |
| `GET /api/customer/dashboard/activity` | Paged recent booking-created and payment-completed events |

### Overview and calculations

`GET /api/customer/dashboard/overview` returns `totalBookings`,
`pendingBookings`, `confirmedBookings`, `activeRentals`, `completedRentals`,
`cancelledBookings`, `totalFavorites`, `totalSpent`, and the latest five
`recentBookings` with basic equipment details.

- `totalBookings` includes every booking status, including rejected bookings.
- The status counters count exact statuses; active rentals are not included in
  `confirmedBookings`.
- `totalFavorites` follows the existing Favorites API and includes only
  approved, non-deleted equipment.
- `totalSpent` sums each unique paid Payment once, using the PaymentIntent ID
  (or Payment record ID if absent), and verifies its booking belongs to this
  customer. Pending, failed, and refunded payments are excluded. Amounts are
  reported in the Payment model's major currency units.
- `recentBookings` are sorted by booking `createdAt`, newest first.

Example overview response:

```json
{
  "success": true,
  "message": "Customer dashboard data fetched successfully.",
  "data": {
    "totalBookings": 4,
    "pendingBookings": 1,
    "confirmedBookings": 1,
    "activeRentals": 1,
    "completedRentals": 1,
    "cancelledBookings": 0,
    "totalFavorites": 2,
    "totalSpent": 12500,
    "recentBookings": []
  }
}
```

### Booking history and favorites

`GET /api/customer/dashboard/bookings` supports:

| Parameter | Values | Default |
| --- | --- | --- |
| `page` | Positive integer | `1` |
| `limit` | Integer from 1 to 50 | `10` |
| `status` | Booking status enum | No filter |
| `paymentStatus` | `unpaid`, `paid`, `failed`, or `refunded` | No filter |
| `sort` | `newest` or `oldest` | `newest` |

History results include equipment details and a safe `paymentSummary` (amount,
currency, status, paid date, payment method, and fulfillment state where
available). They do not include Stripe objects or credentials. Filters,
sorting, pagination, and counts are applied in MongoDB.

Example history response:

```json
{
  "success": true,
  "message": "Customer bookings fetched successfully.",
  "data": [
    {
      "_id": "64a1b2c3d4e5f67890123457",
      "equipmentId": {
        "_id": "64a1b2c3d4e5f67890123456",
        "name": "Canon EOS R6",
        "image": "https://images.example.test/camera.jpg"
      },
      "status": "confirmed",
      "paymentStatus": "paid",
      "paymentSummary": {
        "amount": 1000,
        "currency": "bdt",
        "status": "paid",
        "paidAt": "2026-11-22T10:00:00.000Z",
        "paymentMethod": "card"
      }
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 1,
    "totalItems": 1,
    "limit": 10,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

`GET /api/customer/dashboard/favorites?page=1&limit=9` uses the existing
Favorites aggregation and returns only approved, non-deleted equipment with
card details and pagination metadata. The default page size is `9`, maximum
`50`.

### Profile and activity

The profile response contains only `id`, `name`, `email`, `image`, `phone`,
`role`, and `createdAt`. Email is read-only because email changes must go
through Better Auth's verification flow. Profile updates accept only `name`,
`image`, and `phone`; role, IDs, email, account status, and email-verification
fields are rejected. Empty `image` or `phone` values clear those optional
fields.

Example update:

```http
PATCH /api/customer/dashboard/profile
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "name": "Alex Rahman", "phone": "+8801712345678" }
```

The activity feed is reconstructed from persisted timestamps without a new
activity collection. It currently includes only `booking_created` (`Booking.createdAt`)
and `payment_completed` (`Payment.paidAt`) events tied to bookings owned by the
customer. Confirmation, cancellation,
and rental-completion activity is omitted because the system does not store
separate reliable timestamps for those status transitions; `updatedAt` is not
used as a substitute. Activity supports `page` (default `1`) and `limit`
(default `10`, maximum `50`) and is sorted newest first. The `$unionWith`
aggregation requires MongoDB 4.4 or later.

## Owner dashboard APIs

All owner dashboard endpoints require `Authorization: Bearer <token>`,
`verifyToken`, and the `owner` role (`verifyOwner`). Customer and admin tokens
receive `403`. The owner ID is always taken from the verified database-backed
identity; IDs supplied in query strings or request bodies are not used to scope
the dashboard.

| Method and path | Purpose |
| --- | --- |
| `GET /api/owner/dashboard/overview` | Owner equipment, request, rental, and earnings summary |
| `GET /api/owner/dashboard/equipment` | Filtered, sorted, paginated equipment with booking counts |
| `GET /api/owner/dashboard/rental-requests` | Filtered, sorted, paginated requests for the owner's equipment |
| `GET /api/owner/dashboard/earnings` | Paid gross earnings and paginated recent payments |
| `GET /api/owner/dashboard/profile` | Safe owner profile |
| `PATCH /api/owner/dashboard/profile` | Update name, profile image, and/or phone |

The equipment endpoint accepts `page` (default `1`), `limit` (default `10`,
maximum `50`), `status` (`pending`, `approved`, or `rejected`), `search`
(equipment name, maximum 120 characters), and `sort` (`newest`, `oldest`,
`price_asc`, or `price_desc`, default `newest`). The rental-request endpoint
accepts the same pagination, `status` (`pending`, `confirmed`, `active`,
`completed`, `cancelled`, or `rejected`), and `sort` (`newest` or `oldest`,
default `newest`). Both endpoints apply their filters and pagination in MongoDB
and return the standard `pagination` object.

The earnings endpoint accepts `page` and `limit` (defaults `1` and `10`,
maximum `50`) and optional UTC calendar `startDate` and `endDate` filters in
`YYYY-MM-DD` format. The end date is inclusive.

### Overview, equipment, and rental requests

The overview returns `totalEquipment`, `approvedEquipment`, `pendingEquipment`,
`rejectedEquipment`, `totalRentalRequests`, `pendingRequests`,
`confirmedBookings`, `activeRentals`, `completedRentals`, `cancelledBookings`,
`totalEarnings`, `pendingEarnings`, and the latest five
`recentRentalRequests`. Active equipment counts exclude soft-deleted documents;
booking counters include historical bookings associated with the owner even if
their equipment has since been soft-deleted. Equipment rental statistics count
requests by the equipment's ID and include historical bookings.

`pendingEarnings` is a gross requested amount, not a payment: it sums
`Booking.totalAmount` for bookings whose booking status is `pending` and whose
booking payment status is `unpaid` or `failed`. Those requests may still be paid
or retried. It does not include failed/cancelled/rejected booking states or
already-paid bookings.

Rental request responses contain booking dates, quantity, rental type, amount,
booking/payment statuses, limited equipment card fields, and the customer's ID,
name, and profile image when available. Customer email, phone, address,
booking contact data, notes, tokens, and authentication fields are not returned.
This endpoint reuses the existing owner booking-list query and uses database
pagination.

Example overview response:

```json
{
  "success": true,
  "message": "Owner dashboard data fetched successfully.",
  "data": {
    "totalEquipment": 4,
    "approvedEquipment": 2,
    "pendingEquipment": 1,
    "rejectedEquipment": 1,
    "totalRentalRequests": 9,
    "pendingRequests": 2,
    "confirmedBookings": 3,
    "activeRentals": 1,
    "completedRentals": 2,
    "cancelledBookings": 1,
    "totalEarnings": 18500,
    "pendingEarnings": 2400,
    "earningsType": "gross",
    "currency": "bdt",
    "recentRentalRequests": []
  }
}
```

Example paginated equipment response:

```json
{
  "success": true,
  "message": "Owner equipment fetched successfully.",
  "data": [
    {
      "_id": "64a1b2c3d4e5f67890123456",
      "name": "Canon EOS R6",
      "status": "approved",
      "price": 1200,
      "rentalStats": {
        "totalRentalRequests": 5,
        "pendingRequests": 1,
        "confirmedBookings": 2,
        "activeRentals": 1,
        "completedRentals": 1
      }
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 1,
    "totalItems": 1,
    "limit": 10,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

### Earnings calculation and limitations

Earnings are calculated from persisted Payment records with
`paymentStatus: "paid"` linked to this owner's booking. Duplicate rows sharing a
Stripe PaymentIntent are counted once; records without an intent ID are keyed by
their Payment record ID. The amount uses Stripe's recorded
`receivedAmountMinorUnits` when present, otherwise the stored minor-unit amount,
then the legacy major-unit `amount`. Failed, pending, refunded, refund-pending,
refund-required, and review-required records are excluded. Month grouping and
date filtering use `paidAt`, falling back to the Payment `createdAt` timestamp
for older records.

`totalEarnings` is explicitly **gross earnings** (`bdt`): the platform does not
currently calculate commissions, owner payout amounts, or transfer status.
`totalPaidBookings` counts distinct bookings with eligible successful payments.
`recentPayments` contains only safe payment summaries; Stripe sessions,
PaymentIntent IDs, secret keys, and raw Stripe objects are never returned.

Example earnings response:

```json
{
  "success": true,
  "message": "Owner earnings fetched successfully.",
  "data": {
    "totalEarnings": 18500,
    "totalPaidBookings": 12,
    "earningsType": "gross",
    "currency": "bdt",
    "earningsByMonth": [{ "month": "2026-11", "amount": 18500 }],
    "recentPayments": [
      {
        "paymentId": "64a1b2c3d4e5f67890123457",
        "bookingId": "64a1b2c3d4e5f67890123458",
        "amount": 2500,
        "currency": "bdt",
        "paymentStatus": "paid",
        "paidAt": "2026-11-21T12:00:00.000Z",
        "equipment": {
          "_id": "64a1b2c3d4e5f67890123456",
          "name": "Canon EOS R6",
          "image": "https://images.example.test/camera.jpg"
        },
        "customer": {
          "_id": "64a1b2c3d4e5f67890123459",
          "name": "Alex Rahman",
          "image": "https://images.example.test/profile.jpg"
        }
      }
    ]
  },
  "pagination": {
    "currentPage": 1,
    "totalPages": 2,
    "totalItems": 12,
    "limit": 10,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

### Owner profile and historical records

The profile response contains only `id`, `name`, `email`, `image`, `phone`,
`role`, and `createdAt`. Email is read-only and must be changed through the
Better Auth verification flow. Updates accept only `name`, `image`, and `phone`;
role, account status, email verification, email, IDs, and authentication fields
are rejected. Empty `image` or `phone` values clear those optional fields.

Equipment deletion is soft deletion. It removes a listing from active owner
equipment counts and lists but does not delete its bookings or payments.
Historical requests and eligible earnings therefore remain visible in the
owner's dashboard.

## Admin dashboard and management APIs

Every admin route requires `Authorization: Bearer <token>`, `verifyToken`, and
the `admin` role (`verifyAdmin`). Customer and owner tokens receive `403`.
Authorization is enforced on the server using the user's current database role
and `isActive` status.

| Method and path | Purpose |
| --- | --- |
| `GET /api/admin/dashboard/overview` | Platform user, equipment, booking, and revenue totals |
| `GET /api/admin/dashboard/profile` | Safe current admin profile |
| `PATCH /api/admin/dashboard/profile` | Update name, image, and/or phone |
| `GET /api/admin/users` | Searchable, role-filtered, paginated users |
| `GET /api/admin/users/:id` | Safe user profile and account statistics |
| `PATCH /api/admin/users/:id/role` | Assign `customer`, `owner`, or `admin` role |
| `PATCH /api/admin/users/:id/status` | Activate or deactivate an account |
| `GET /api/admin/equipment` | Searchable and paginated equipment moderation list |
| `PATCH /api/admin/equipment/:id/status` | Existing equipment approval/rejection action |
| `PATCH /api/admin/equipment/:id` | Existing admin equipment update |
| `DELETE /api/admin/equipment/:id` | Existing admin soft-delete action |
| `GET /api/admin/bookings` | Searchable, filtered, paginated bookings |
| `GET /api/admin/bookings/:id` | Safe booking details and latest payment summary |
| `GET /api/admin/payments` | Paginated payment records with safe related summaries |

All list endpoints default to `page=1`, `limit=10`; `limit` must be from `1` to
`50`. They return `data` and the standard root-level `pagination` metadata.
Unsupported query parameters and invalid enum values return `400`.

### List filters

| Endpoint | Optional filters and sort |
| --- | --- |
| Users | `role=customer|owner|admin`, `search` (name or email), `sort=newest|oldest` |
| Equipment | `status=pending|approved|rejected`, `search` (name, brand, model, or location), `category`, `sort=newest|oldest|price_asc|price_desc` |
| Bookings | `status=pending|confirmed|active|completed|cancelled|rejected`, `paymentStatus=unpaid|paid|failed|refunded`, `search` (customer/owner name or email, or equipment name), `sort=newest|oldest` |
| Payments | `status=pending|paid|failed|refunded`, `sort=newest|oldest` |

Search text is limited to 120 characters, treated as a literal case-insensitive
search (regex metacharacters are escaped), and applied in MongoDB. The booking
search covers customer and owner names/emails and equipment name; it does not
search private contact/address fields. Soft-deleted equipment is excluded from
the moderation list but remains linked to historical bookings and payments.

Example user list:

```http
GET /api/admin/users?role=owner&search=rahman&page=1&limit=10&sort=newest
Authorization: Bearer <admin-token>
```

```json
{
  "success": true,
  "message": "Users fetched successfully.",
  "data": [
    {
      "_id": "64a1b2c3d4e5f67890123456",
      "name": "Alex Rahman",
      "email": "alex@example.test",
      "image": "https://images.example.test/profile.jpg",
      "role": "owner",
      "isActive": true,
      "createdAt": "2026-11-21T12:00:00.000Z"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 1,
    "totalItems": 1,
    "limit": 10,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

### User roles and account status

Role changes accept only a JSON object with a valid `role`; status changes accept
only a boolean `isActive`. Other fields are rejected. An administrator cannot
demote or deactivate their own account. Accounts are never deleted by these
endpoints, preserving their booking/payment history.

`verifyToken` loads the user and current role/status from the database on each
protected API request. A role change therefore takes effect on the next request
using any still-valid token; changing roles does not delete Better Auth sessions
or revoke the JWT itself. Deactivating an account immediately prevents it from
accessing protected backend APIs (the middleware returns `403`), even while a
previously issued token remains unexpired. Re-activation restores access subject
to a valid token.

Example role change:

```http
PATCH /api/admin/users/64a1b2c3d4e5f67890123456/role
Authorization: Bearer <admin-token>
Content-Type: application/json
```

```json
{ "role": "owner" }
```

```json
{
  "success": true,
  "message": "User role changed to owner.",
  "data": {
    "_id": "64a1b2c3d4e5f67890123456",
    "name": "Alex Rahman",
    "email": "alex@example.test",
    "image": "https://images.example.test/profile.jpg",
    "phone": "+8801712345678",
    "role": "owner",
    "isActive": true,
    "createdAt": "2026-11-21T12:00:00.000Z"
  }
}
```

Account status changes use the same admin-only authorization and accept only:

```http
PATCH /api/admin/users/64a1b2c3d4e5f67890123456/status
Authorization: Bearer <admin-token>
Content-Type: application/json
```

```json
{ "isActive": false }
```

### Overview and revenue

The overview counts users only for the persisted `customer`, `owner`, and
`admin` roles. Inactive accounts remain included in these user totals; the User
model has no soft-delete field. Equipment counts exclude soft-deleted and
unsupported-status documents. Booking totals include recognized booking
statuses. The response includes the latest five users and bookings with safe
profile/equipment summaries; password, session, token, private booking, and
Stripe fields are excluded.

Revenue is the sum of unique successful PaymentIntent amounts linked through
Booking records. It uses `receivedAmountMinorUnits` when available, then the
stored minor-unit amount, then the legacy major-unit amount. Payments without a
PaymentIntent are keyed by Payment record ID. Pending, failed, refunded,
refund-pending, refund-required, and review-required payments are excluded.
`totalPaidBookings` counts distinct bookings with eligible successful payments.
Revenue is gross `bdt`; commission, owner payouts, and transfer states are not
calculated.

Example dashboard overview:

```json
{
  "success": true,
  "message": "Admin dashboard data fetched successfully.",
  "data": {
    "totalUsers": 120,
    "totalCustomers": 90,
    "totalOwners": 25,
    "totalAdmins": 5,
    "totalEquipment": 48,
    "approvedEquipment": 35,
    "pendingEquipment": 8,
    "rejectedEquipment": 5,
    "totalBookings": 310,
    "pendingBookings": 12,
    "confirmedBookings": 40,
    "activeRentals": 7,
    "completedRentals": 220,
    "cancelledBookings": 25,
    "totalRevenue": 825000,
    "totalPaidBookings": 260,
    "currency": "bdt",
    "recentUsers": [],
    "recentBookings": []
  }
}
```

### Booking, payment, and profile restrictions

Admin booking reads include customer, owner, equipment, rental details, and
booking/payment statuses. The detail endpoint includes a safe summary of the
latest persisted payment (amount, currency, payment/fulfillment status, method,
and timestamps). No admin booking status-write endpoint is added, and admins
cannot mark bookings or payments as paid.

Payment listing includes safe customer, owner, equipment, and booking summaries.
It never returns Stripe session/PaymentIntent IDs, checkout URLs, event IDs,
secrets, or raw Stripe objects. There is no admin refund endpoint: changing a
database status would not issue a Stripe refund. Refund state continues to be
controlled only by the existing verified Stripe webhook/recovery workflow.

Admin profile reads expose only `_id`, name, email, image, phone, role, active
status, and creation date. Updates reuse the existing profile validator and
permit only `name`, `image`, and `phone`; role, status, email, IDs, email
verification, passwords, and Better Auth fields are rejected.

## Admin and owner analytics APIs

Admin analytics endpoints require `Authorization: Bearer <token>`,
`verifyToken`, and the `admin` role. Owner analytics endpoints require the same
token middleware and the `owner` role. Customer access is denied, owners cannot
read admin analytics, and each owner pipeline is scoped by the owner ID from
the verified database-backed request identity.

| Method and path | Purpose |
| --- | --- |
| `GET /api/admin/analytics/overview` | Platform revenue, booking, user, and equipment summary |
| `GET /api/admin/analytics/revenue` | Platform revenue series |
| `GET /api/admin/analytics/bookings` | Booking status, monthly, and growth metrics |
| `GET /api/admin/analytics/equipment` | Category/status counts and rental rankings |
| `GET /api/admin/analytics/users` | Role counts, signup months, and growth |
| `GET /api/owner/analytics/overview` | Owner revenue, booking, equipment, and performance summary |
| `GET /api/owner/analytics/revenue` | Owner-scoped revenue series |
| `GET /api/owner/analytics/equipment` | Owner-scoped rental and revenue performance |

### Revenue periods, dates, and currency

The admin and owner revenue endpoints accept:

| Parameter | Values | Default |
| --- | --- | --- |
| `period` | `daily`, `weekly`, `monthly`, `yearly` | `monthly` |
| `startDate` | UTC calendar date, `YYYY-MM-DD` | Optional |
| `endDate` | UTC calendar date, `YYYY-MM-DD` | Optional |

Custom ranges must provide both dates, must be ordered, cannot end in the future,
and include both calendar-day endpoints. Timestamps are filtered as
`paidAt >= startDate UTC midnight` and `paidAt < midnight after endDate`. If
neither date is provided, the default window is the latest 30 calendar days,
12 ISO weeks, 12 calendar months, or 5 calendar years, depending on `period`.
Maximum custom spans are 366 days for daily, 5 years for weekly, 10 years for
monthly, and 20 years for yearly requests. Dates and buckets use UTC; weeks use
ISO week-year labels such as `2026-W03`.

Revenue includes only `Payment.paymentStatus: "paid"` records associated with a
booking. It excludes failed, pending, refunded, refund-pending, refund-required,
and review-required payments. A Stripe PaymentIntent is counted once; a payment
without an intent ID is keyed by its Payment record ID. The amount uses
`receivedAmountMinorUnits`, then `amountMinorUnits`, then the legacy `amount`
rounded to minor units. Grouping and summation use integer minor units; API
amounts are presented in **BDT**. Time-bucketed analytics require the actual
`Payment.paidAt` timestamp; records without it are omitted from revenue series
rather than attributed to checkout creation time. All-time revenue totals still
include eligible paid records without a `paidAt`. These metrics are gross
collected revenue, not commission-adjusted revenue or owner payout.

Example:

```http
GET /api/admin/analytics/revenue?period=monthly&startDate=2026-01-01&endDate=2026-11-22
Authorization: Bearer <admin-token>
```

```json
{
  "success": true,
  "message": "Admin revenue analytics fetched successfully.",
  "data": {
    "period": "monthly",
    "currency": "BDT",
    "startDate": "2026-01-01",
    "endDate": "2026-11-22",
    "results": [
      {
        "label": "2026-11",
        "revenue": 25000,
        "paymentCount": 8,
        "bookingCount": 7
      }
    ]
  }
}
```

The response contains every bucket in the requested/default range. Buckets
without payments return zero revenue and zero counts. `paymentCount` counts
unique successful payment transactions after PaymentIntent deduplication;
`bookingCount` counts distinct bookings represented in that period.

### Metric definitions

- Admin `totalUsers`, `totalCustomers`, and `totalOwners` count persisted users
  with recognized roles. Inactive accounts are included; the User model has no
  deleted state. Admin `totalEquipment` excludes soft-deleted and
  unrecognized-status listings. Booking totals and status counts include only
  recognized booking statuses. Admin overview revenue and paid booking totals
  use the successful-payment rules above.
- `averageBookingValue` is the mean of positive, valid `Booking.totalAmount`
  values in major BDT units across recognized bookings. It includes pending,
  cancelled, and rejected bookings; it is not an average paid amount.
- Admin `bookingsByMonth` and `newUsersByMonth` cover the last 12 UTC calendar
  months, including zero-count months. Booking/user growth compares the rolling
  30 days ending at request time with the immediately preceding 30 days. If the
  previous count is zero, `percentChange` is `null` when the current count is
  positive (no finite baseline), and `0` when both counts are zero.
- Equipment rental counts count one booking document per equipment item when
  its booking status is `confirmed`, `active`, or `completed`, regardless of
  booking quantity. Pending, cancelled, and rejected bookings are not rentals.
  Most-rented rankings omit zero-rental listings; least-rented rankings include
  zero-rental active listings. Admin top owners include only safe owner ID,
  name, and image summaries.
- Owner totals include only bookings whose persisted `ownerId` matches the
  authenticated owner. Owner revenue includes eligible historical payments
  even when their equipment has since been soft-deleted. Active equipment
  counts, equipment rankings, bookings-by-equipment, and revenue-by-equipment
  exclude soft-deleted listings. Owner `monthlyRevenue` covers the last 12 UTC
  months; `equipmentPerformance` is the top five current listings by successful
  gross revenue. `bookingsByEquipment` and `revenueByEquipment` include current
  listings with zero values.
- User analytics return aggregate counts only—no user names, emails, or other
  profile data. User role/month counts use recognized roles, include inactive
  accounts, and use `User.createdAt` in UTC.

Admin overview response shape:

```json
{
  "success": true,
  "message": "Admin analytics overview fetched successfully.",
  "data": {
    "totalRevenue": 825000,
    "totalBookings": 310,
    "totalUsers": 120,
    "totalEquipment": 48,
    "totalCustomers": 90,
    "totalOwners": 25,
    "averageBookingValue": 2650,
    "completedBookings": 220,
    "activeRentals": 7,
    "pendingBookings": 12,
    "currency": "BDT"
  }
}
```

Owner overview response shape:

```json
{
  "success": true,
  "message": "Owner analytics overview fetched successfully.",
  "data": {
    "totalRevenue": 18500,
    "totalBookings": 12,
    "totalEquipment": 4,
    "activeRentals": 1,
    "completedRentals": 8,
    "averageBookingValue": 2400,
    "currency": "BDT",
    "monthlyRevenue": [
      { "month": "2025-12", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-01", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-02", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-03", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-04", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-05", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-06", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-07", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-08", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-09", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-10", "revenue": 0, "paymentCount": 0 },
      { "month": "2026-11", "revenue": 4500, "paymentCount": 2 }
    ],
    "equipmentPerformance": [
      {
        "equipment": {
          "_id": "64a1b2c3d4e5f67890123456",
          "name": "Camera A",
          "image": "https://images.example.test/camera-a.jpg",
          "category": "Photography Equipment",
          "location": "Dhaka"
        },
        "revenue": 4500,
        "paymentCount": 2
      }
    ]
  }
}
```

The analytics are calculated from live MongoDB aggregation pipelines over the
existing User, Equipment, Booking, and Payment collections. No analytics
collection or private-owner cache is used. Existing indexes support owner,
equipment, booking, payment, and timestamp joins/filters.
