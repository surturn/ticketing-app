# ticketing-api

A standalone ticketing and payments backend. One instance serves many events, so
every site in the template portfolio calls the same service instead of each one
carrying its own n8n workflow.

**Stack:** Node + Fastify · Postgres + Drizzle · Redis (cache) + BullMQ (workers)
· M-Pesa Daraja.

---

## Why it is shaped this way

The design target is a flash sale: thousands of people hitting checkout for the
same tier in the same few seconds. Three decisions follow from that.

**Inventory lives in one row per tier, and reservations are a single statement.**

```
available = quantity_total - quantity_reserved - quantity_sold
```

A checkout moves `available → reserved`; settlement moves `reserved → sold`; an
expiry moves `reserved → available`. Each transition is one conditional `UPDATE`
that both checks and mutates:

```sql
UPDATE ticket_tiers
   SET quantity_reserved = quantity_reserved + $qty
 WHERE id = $tier
   AND quantity_total - quantity_reserved - quantity_sold >= $qty
RETURNING *;
```

Under contention every tier row is a serialization point, so holding the lock
across a `SELECT` and then an `UPDATE` would double the critical section. A
`CHECK` constraint backstops the whole thing — even a regression in application
code cannot oversell, the transaction just aborts.

**Nothing slow happens inside a transaction.** The Daraja STK Push runs *after*
the commit. If it fails, a compensating release returns the seats immediately.

**The request path does two things only** — hold inventory, authorise payment.
Ticket generation, receipts, hold expiry and payment reconciliation are all
queued.

---

## Local setup

```bash
docker compose up -d          # Postgres + Redis
cp .env.example .env          # then fill in the secrets below
npm install

npm run db:generate           # generate SQL migrations from src/db/schema.ts
npm run db:migrate            # apply them
npm run db:seed               # optional: one published event with 3 tiers

npm run dev                   # API   → http://localhost:4000
npm run dev:worker            # worker (separate terminal)
```

Generate the three required secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

…for `TICKET_SIGNING_SECRET`, `SCANNER_JWT_SECRET` and `ADMIN_API_KEY`.
Rotating `TICKET_SIGNING_SECRET` invalidates every QR code already issued.

M-Pesa credentials are optional — the service boots without them and only fails
when a payment is actually attempted, so frontend work is unblocked.

---

## API

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/events` | Published events |
| `GET` | `/api/events/:slug` | One event with its tiers and availability |
| `GET` | `/api/events/:slug/availability` | Live counters (cached 5s) |
| `POST` | `/api/checkout` | Hold seats + start payment |
| `GET` | `/api/orders/:reference` | Full order, including tickets once paid |
| `GET` | `/api/orders/:reference/status` | Lightweight poll while paying |
| `POST` | `/api/orders/:reference/cancel` | Buyer backed out |
| `POST` | `/api/webhooks/mpesa` | Safaricom callback |

### Authenticated

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/checkin` | Scanner JWT, or admin key |
| `*` | `/api/admin/*` | `x-api-key` |

Admin covers events and tiers, order and payment listings, per-event stats,
minting scanner tokens, and voiding a ticket.

### Checkout

```http
POST /api/checkout
Content-Type: application/json
Idempotency-Key: 6f1c…            # stable per basket — retries are free

{
  "eventSlug": "sample-summit-2026",
  "items": [{ "tierId": "…uuid…", "quantity": 2 }],
  "buyer": { "name": "Asha", "email": "asha@example.com", "phone": "0712345678" }
}
```

```json
{
  "orderId": "…", "reference": "TKT-8F3KQ2XA",
  "status": "awaiting_payment",
  "totalCents": 500000, "currency": "KES",
  "expiresAt": "2026-07-28T12:34:56.000Z",
  "payment": { "gateway": "mpesa", "gatewayRef": "ws_CO_…",
               "customerMessage": "Enter your M-Pesa PIN" },
  "idempotentReplay": false
}
```

Then poll `/api/orders/TKT-8F3KQ2XA/status` until `status` is `paid`, `failed`,
`cancelled` or `expired`.

### Errors

Every error has the same shape:

```json
{ "error": { "code": "insufficient_inventory",
             "message": "Only 3 ticket(s) left for \"VIP\"",
             "details": { "available": 3, "requested": 5 },
             "retryable": false } }
```

**Branch on `code`, and respect `retryable`.** During a sale a 409 is normal,
not exceptional — `inventory_contended` means try again in a moment, while
`insufficient_inventory` with `retryable: false` means genuinely sold out.

---

## Background jobs

| Queue | Job | What it does |
|---|---|---|
| `order-expiry` | `expire-order` | Delayed to the exact moment a hold lapses |
| `order-expiry` | `sweep-expired-orders` | Every 60s; catches jobs lost to a Redis restart |
| `payment-reconcile` | `reconcile-payment` | Polls Daraja when a callback never arrives |
| `ticket-issuance` | `issue-tickets` | Generates admissions after settlement |
| `notification` | `notify` | Receipts and ticket delivery |

Reconciliation is not optional. Safaricom callbacks get lost, get delivered to a
URL that was down during a deploy, or arrive twenty minutes late. Without the
reconciler those orders sit in `awaiting_payment` until the hold lapses and a
buyer who genuinely paid never receives a ticket.

---

## Deploying to Railway

Three services off this one repo:

1. **API** — `node dist/index.js`, autoscaled on CPU.
2. **Worker** — same image, `node dist/worker.js`. **Do not autoscale this with
   the API**; its throughput is bounded by Postgres and Daraja, not by inbound
   HTTP.
3. **PgBouncer** — Railway's Postgres ships without a pooler, and a flash sale
   will exceed `max_connections` long before it exhausts CPU.

Run `npm run db:migrate` as the pre-deploy command so a release never serves
traffic against an old schema.

Set `MPESA_CALLBACK_URL` to `https://<api-host>/api/webhooks/mpesa` and set
`MPESA_CALLBACK_TOKEN` — it is appended as `?token=…` and checked on every
callback.

### The pooler setting that will bite you

If you put PgBouncer or Supavisor in **transaction** mode in front of Postgres,
set:

```
DATABASE_POOLER_MODE=transaction
```

This disables prepared statements. Without it you get intermittent
`prepared statement "s1" already exists` errors that only appear once
connections start being reused — i.e. under load, during the sale.

Health checks: `/health` for liveness (touches nothing), `/health/ready` for
readiness (checks Postgres and Redis).

---

## Testing

```bash
npm test                              # unit tests only
RUN_DB_TESTS=true npm test            # + concurrency tests against Postgres
```

The integration tests in `src/services/inventory.test.ts` are the ones worth
running before any change to reservation logic: they fire 50 concurrent buyers
at a 10-seat tier and assert that exactly 10 succeed. **They truncate tables —
point `DATABASE_URL` at a throwaway database.**

---

## Status

Written but **not yet compiled or run** — no dependency install has happened in
this environment. Before trusting any of it:

1. `npm install`, then `npm run typecheck`.
2. `npm run db:generate` — the `drizzle/` migration folder does not exist yet;
   review the generated SQL, particularly the partial unique indexes on
   `orders.idempotency_key` and `payments.receipt`.
3. `RUN_DB_TESTS=true npm test`.
4. Exercise a sandbox STK push end to end; the callback needs a public URL, so
   use an ngrok tunnel locally.

### Not implemented

- **Notification delivery.** `notification.worker.ts` resolves the order and
  logs what it *would* send. No email or SMS provider was chosen, so plugging
  one in (Resend, nodemailer, Africa's Talking) is a single function swap in
  `deliver()`.
- **Refunds.** Orders that settle after their hold lapsed on a sold-out tier are
  flagged `metadata.refundRequired` and surfaced in `/api/admin/events/:id/stats`,
  but reversing the payment is manual. Daraja B2C/Reversal needs an initiator
  credential and a security certificate that are not wired up.
- **Seat selection.** Inventory is counted, not mapped. Allocated seating would
  need a `seats` table and a different locking strategy.
