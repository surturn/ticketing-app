# ticketing-api

Event ticketing and payments backend with M-Pesa settlement. A single instance
serves many events, so every site in the portfolio integrates against one service.

**Stack:** Node · Fastify · PostgreSQL · Drizzle ORM · Redis · BullMQ · M-Pesa
Daraja · Brevo

---

## Capabilities

- **Oversell-safe inventory** — reservations are single-statement conditional
  updates, with a database constraint as the final guarantee.
- **M-Pesa STK Push** — Paybill and Buy Goods (Till), sandbox and production.
- **Idempotent checkout** — retries on unreliable mobile connections are free.
- **Automatic reconciliation** — payments are confirmed directly against Daraja
  when a callback does not arrive.
- **Signed QR tickets** — offline-verifiable at the gate, with single-use check-in.
- **Append-only audit ledger** — every state transition, hash-chained and enforced
  by the database.
- **Transactional email** — receipts and ticket delivery via Brevo.

---

## Architecture

The design target is a flash sale: thousands of concurrent buyers competing for the
same tier within seconds. Three decisions follow from it.

**Inventory is counter-based, and each transition is a single statement.** A tier
tracks its total, reserved and sold quantities. Checkout moves availability into
reserved, settlement moves reserved into sold, and expiry returns it. Because every
transition both tests its invariant and applies its change in one statement, a
contended tier row is locked for one round trip rather than two. A database
constraint backs the whole arrangement, so overselling aborts the transaction
regardless of application behaviour.

**Nothing slow runs inside a transaction.** The payment gateway is called after the
inventory transaction commits, never within it. If that call fails, a compensating
release returns the seats immediately rather than leaving the buyer to wait out the
hold.

**The synchronous path does two things** — reserve inventory, authorise payment.
Everything else is queued.

| Queue | Responsibility |
|---|---|
| `order-expiry` | Releases a hold when it lapses, with a periodic safety net |
| `payment-reconcile` | Confirms payment state against the gateway |
| `ticket-issuance` | Generates admissions after settlement |
| `notification` | Receipts and ticket delivery |

Reconciliation is essential rather than optional: callbacks are lost, delayed, or
delivered to a service that was mid-redeploy. Without it, a buyer who paid
successfully would never receive a ticket. Settlement is idempotent and
concurrency-safe — the callback and the reconciler compete by design, and exactly
one can transition a payment out of its pending state.

### Audit ledger

Every order, payment, inventory and ticket transition is appended to a ledger with
an actor, before and after state, and the identifiers required for reconciliation,
including the M-Pesa receipt.

- **Append-only, enforced by PostgreSQL.** Database triggers reject mutation and
  apply to the table owner, which is the role the application connects as.
- **Hash-chained.** Each entry's SHA-256 digest covers its own contents together
  with its predecessor's, making any alteration detectable.
- **Transactionally consistent.** Entries are written in the same transaction as
  the change they describe, so the ledger cannot record an operation that rolled
  back.

Chains are scoped per order rather than globally. A single chain would serialise
every writer on one tip and, because the lock is transaction-scoped, serialise the
entire sale.

---

## Getting started

Requires Node 20.11+ and Docker.

```bash
docker compose up -d     # PostgreSQL + Redis
cp .env.example .env
npm install

npm run db:migrate
npm run db:seed          # optional: one published event with three tiers

npm run dev              # API    → http://localhost:4000
npm run dev:worker       # worker → separate terminal
```

Generate the required secrets, using distinct values per environment:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotating `TICKET_SIGNING_SECRET` invalidates every QR code already issued.

M-Pesa and Brevo credentials are optional in development. Payments fail only when
attempted, and email is logged rather than sent, so frontend work is unblocked.

Integration details are distributed separately.

---

## Configuration

See `.env.example` for the complete list. Values worth calling out:

| Variable | Notes |
|---|---|
| `DATABASE_POOLER_MODE` | Set to `transaction` behind PgBouncer or Supavisor in transaction mode |
| `ORDER_HOLD_MINUTES` | How long seats are held while the buyer pays |
| `RUN_WORKERS_IN_API` | Runs workers in-process; suitable only for small deployments |
| `CORS_ORIGINS` | Comma-separated origins permitted to call the public API |
| `MPESA_CALLBACK_URL` | Validated at startup; must be HTTPS |

An empty value is treated as unset, so blanking a variable and omitting it are
equivalent.

### M-Pesa environments

| | Sandbox | Production (Till / Buy Goods) |
|---|---|---|
| `MPESA_ENVIRONMENT` | `sandbox` | `production` |
| `MPESA_SHORTCODE` | `174379` | Shortcode the passkey was issued against |
| `MPESA_TRANSACTION_TYPE` | `CustomerPayBillOnline` | `CustomerBuyGoodsOnline` |
| `MPESA_PARTY_B` | *(blank)* | Till number |

Safaricom's sandbox shortcode `174379` is a Paybill, so sandbox testing requires
`CustomerPayBillOnline` even when production uses Buy Goods. `MPESA_SHORTCODE`
signs the request; `MPESA_PARTY_B` is the shortcode funds credit to, and under Buy
Goods the two are commonly different.

Local development requires a public tunnel — for example `ngrok http 4000` — since
Safaricom must be able to reach the callback.

---

## Deployment

Two services run from this repository and share one image:

| Service | Command | Scaling |
|---|---|---|
| API | `node dist/index.js` | Autoscale on CPU |
| Worker | `node dist/worker.js` | Fixed; bounded by PostgreSQL and Daraja, not inbound HTTP |

A connection pooler is recommended. Managed PostgreSQL frequently ships without
one, and a flash sale will exhaust `max_connections` well before CPU.

Run `npm run db:migrate` as the pre-deploy command so a release never serves
traffic against an outdated schema.

The API and storefront are served from one origin, which keeps CORS out of the
buyer path and the payment callback on the same domain.

### Connection pooling

Behind PgBouncer or Supavisor in transaction mode, set:

```
DATABASE_POOLER_MODE=transaction
```

This disables prepared statements. Without it, `prepared statement "s1" already
exists` appears intermittently once connections begin to be reused — that is, under
load.

### Health checks

Liveness and readiness probes are exposed for the platform to poll; readiness
verifies PostgreSQL and Redis connectivity. Paths are listed in the integration
notes.

---

## Testing

```bash
npm test                       # unit tests
RUN_DB_TESTS=true npm test     # adds PostgreSQL and Redis integration suites
npm run check:lifecycle        # end-to-end checkout against the local stack
```

Integration suites require both containers and run against a dedicated database.
`src/test/setup.ts` points `DATABASE_URL` at `ticketing_test`, created once:

```bash
docker exec ticketing-postgres psql -U ticketing -d postgres \
  -c "CREATE DATABASE ticketing_test OWNER ticketing;"
DATABASE_URL=postgres://ticketing:ticketing@localhost:5432/ticketing_test \
  npm run db:migrate
```

Coverage of note:

- **`inventory.test.ts`** — 50 concurrent buyers against a 10-seat tier, asserting
  exactly 10 succeed. Run before any change to reservation logic.
- **`queues.test.ts`** — every producer enqueues against a live broker.
- **`ledger.test.ts`** — asserts the database rejects mutation of the ledger, that
  entries roll back with their transaction, and that concurrent appends chain
  correctly.

Ledger entries are never cleared, by design. Reset a development database by
dropping it:

```bash
docker exec ticketing-postgres psql -U ticketing -d postgres \
  -c "DROP DATABASE ticketing WITH (FORCE);"
```

---

## Roadmap

- Buyer accounts with authenticated order history
- Automated refunds via Daraja B2C
- SMS delivery alongside email
- Reserved seating

---

Proprietary. All rights reserved.
