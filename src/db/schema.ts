import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Conventions
//
// * Money is stored in minor units (cents) as integers. Never floats.
// * Timestamps are `timestamptz`; the app works exclusively in UTC and formats
//   into the event's timezone at the edge.
// * Inventory lives on ticket_tiers as three counters (total / reserved / sold)
//   guarded by a CHECK constraint. That constraint is the last line of defence:
//   even if application logic regresses, Postgres refuses to oversell.
// ---------------------------------------------------------------------------

export const eventStatus = pgEnum('event_status', [
  'draft',
  'published',
  'closed',
  'cancelled',
]);

export const tierStatus = pgEnum('tier_status', [
  'active',
  /** Temporarily off sale; the storefront should say "not on sale right now". */
  'paused',
  /** Not shown to buyers at all. */
  'hidden',
  /**
   * Deliberately closed by the organiser — presented to buyers as sold out.
   *
   * This is what an uncapped tier needs: the organiser watches the numbers, books
   * the venue, and closes the sale at whatever figure they can actually host.
   * Distinct from `paused` because the buyer-facing message differs — "sold out"
   * is final, "paused" invites coming back later.
   */
  'closed',
]);

export const orderStatus = pgEnum('order_status', [
  'pending', // created, inventory held, payment not yet initiated
  'awaiting_payment', // STK push sent, waiting on the buyer / callback
  'paid', // settled, tickets issued
  'failed', // payment declined or gateway error
  'expired', // hold lapsed before payment completed
  'cancelled', // buyer cancelled the STK prompt
  'refunded',
]);

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

export const ticketStatus = pgEnum('ticket_status', [
  'issued',
  'checked_in',
  'void',
]);

export const webhookStatus = pgEnum('webhook_status', [
  'received',
  'processed',
  'ignored',
  'failed',
]);

// ---------------------------------------------------------------------------
// users — buyers who chose to create an account.
//
// Firebase owns credentials; this table owns everything about a buyer that is
// *ours*. No password hash, no reset token, no session — those never touch this
// database, which is the main security benefit of delegating authentication.
//
// The primary key is the Firebase uid rather than a generated uuid, so there is
// exactly one identifier for a person and no mapping table to fall out of sync.
//
// Rows here are a mirror, populated on sign-in, not a source of truth. If this
// table were emptied, buyers could still sign in and it would refill.
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    /** Firebase uid. */
    id: text('id').primaryKey(),

    /** Lowercased. Unique, so two accounts cannot claim the same inbox. */
    email: text('email').notNull(),
    /**
     * Mirrors Firebase's `email_verified` at last sign-in.
     *
     * Gates linking guest orders: an unverified address must not be able to
     * claim tickets bought by whoever actually owns that inbox.
     */
    emailVerified: boolean('email_verified').notNull().default(false),

    displayName: text('display_name'),
    /** Optional, and separate from the phone given at checkout. */
    phone: text('phone'),

    /** Whether to send this buyer announcements about new events. */
    announcementsOptIn: boolean('announcements_opt_in').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

// ---------------------------------------------------------------------------
// subscribers — "tell me when an event pops up", without an account.
//
// Deliberately separate from `users`. Requiring registration to hear about a new
// event loses most of the people who would have wanted to hear, and an email
// address is all that is needed to send one.
//
// Double opt-in: a row is created unconfirmed and only mailed once the buyer
// clicks through. That protects both the deliverability of the sending domain
// and anyone whose address is typed in by someone else.
// ---------------------------------------------------------------------------

export const subscribers = pgTable(
  'subscribers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),

    /** Where the subscription came from: `signup-form`, `checkout`, `import`. */
    source: text('source').notNull().default('signup-form'),

    /**
     * Opaque secret in confirm and unsubscribe links.
     *
     * Unguessable on purpose: a sequential id would let anyone unsubscribe
     * somebody else, or confirm an address they do not own.
     */
    token: text('token').notNull(),

    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('subscribers_email_key').on(table.email),
    uniqueIndex('subscribers_token_key').on(table.token),
    // The send query: confirmed and not unsubscribed.
    index('subscribers_confirmed_idx').on(table.confirmedAt, table.unsubscribedAt),
  ],
);

// ---------------------------------------------------------------------------
// events — one row per ticketed event. This service is multi-tenant by event,
// so a single instance backs every site in the template portfolio.
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    venue: text('venue'),
    timezone: text('timezone').notNull().default('Africa/Nairobi'),
    currency: text('currency').notNull().default('KES'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    status: eventStatus('status').notNull().default('draft'),

    /**
     * When the event was retired from active listings.
     *
     * A timestamp rather than another `status` value, because archiving is
     * orthogonal to where an event sits in its sales lifecycle: a `published`
     * event and a `cancelled` one can both be archived, and unarchiving must
     * restore whatever the sales status already was.
     *
     * Archived is not deleted. The event, its orders and its tickets all remain
     * readable — a buyer holding a link still sees their ticket — it simply moves
     * out of the current listing and into past events.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    /**
     * When the "new event" announcement was sent.
     *
     * A column rather than a flag in code because it makes the send once-only
     * across restarts and redeploys. An event can move in and out of `published`
     * repeatedly — a typo fixed, a date corrected — and each of those must not
     * mail the whole list again.
     */
    announcedAt: timestamp('announced_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('events_slug_key').on(table.slug),
    index('events_status_starts_at_idx').on(table.status, table.startsAt),
  ],
);

// ---------------------------------------------------------------------------
// ticket_tiers — the inventory rows. Every checkout contends on these, so they
// are deliberately narrow and the reservation is a single UPDATE statement.
// ---------------------------------------------------------------------------

export const ticketTiers = pgTable(
  'ticket_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),

    /** Price per ticket in minor units (e.g. KES cents). */
    priceCents: integer('price_cents').notNull(),

    /**
     * Seats this tier may sell, or NULL for uncapped.
     *
     * Uncapped is a real business case rather than a convenience: organisers
     * routinely book the venue on the strength of how much sold, so the sale
     * runs before a capacity exists. A capped and an uncapped tier can sit side
     * by side on the same event, so this is per-tier, not an event-level mode.
     *
     * Every guard on this column is written `quantity_total IS NULL OR …`.
     * Relying on three-valued logic instead would be a trap: in a `CHECK` a NULL
     * result passes, but in a `WHERE` it filters the row out — so the same
     * omission that leaves the oversell constraint looking fine would stop an
     * uncapped tier from ever reserving.
     */
    quantityTotal: integer('quantity_total'),
    /** Held by in-flight orders that have not yet paid. */
    quantityReserved: integer('quantity_reserved').notNull().default(0),
    /** Settled — tickets issued. */
    quantitySold: integer('quantity_sold').notNull().default(0),

    minPerOrder: integer('min_per_order').notNull().default(1),
    maxPerOrder: integer('max_per_order').notNull().default(10),

    salesStartAt: timestamp('sales_start_at', { withTimezone: true }),
    salesEndAt: timestamp('sales_end_at', { withTimezone: true }),

    status: tierStatus('status').notNull().default('active'),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ticket_tiers_event_id_idx').on(table.eventId),
    uniqueIndex('ticket_tiers_event_id_name_key').on(table.eventId, table.name),

    // The oversell guard. Any code path that would push reserved + sold past
    // total aborts the transaction instead of quietly selling a seat twice.
    //
    // The NULL branch is written out rather than left implicit. A bare
    // comparison would also pass for uncapped tiers, since a CHECK accepts a
    // NULL result — but silently, for the wrong reason. Stating it means the
    // constraint says what it means.
    check(
      'ticket_tiers_no_oversell',
      sql`${table.quantityTotal} IS NULL OR ${table.quantityReserved} + ${table.quantitySold} <= ${table.quantityTotal}`,
    ),
    check('ticket_tiers_reserved_non_negative', sql`${table.quantityReserved} >= 0`),
    check('ticket_tiers_sold_non_negative', sql`${table.quantitySold} >= 0`),
    check('ticket_tiers_price_non_negative', sql`${table.priceCents} >= 0`),
    check(
      'ticket_tiers_order_bounds',
      sql`${table.minPerOrder} >= 1 AND ${table.maxPerOrder} >= ${table.minPerOrder}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// orders — a buyer's basket. Holds inventory until `reserved_until` passes.
// ---------------------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),

    /** Short human-facing reference, e.g. TKT-8F3KQ2XA. Quoted in support. */
    reference: text('reference').notNull(),

    /**
     * The account this order belongs to, or NULL for a guest purchase.
     *
     * Nullable is the whole point: accounts are optional, so most orders will
     * never have one, and checkout must not require sign-in.
     *
     * `ON DELETE set null` rather than cascade — deleting an account must never
     * take a paid order with it. The order's own buyer name, email and phone are
     * copied onto the row at checkout, so it stays complete and readable with no
     * account attached at all.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    buyerName: text('buyer_name').notNull(),
    // Mandatory: a ticket the buyer cannot be sent is not a ticket they own.
    // Validated at the route boundary, and normalised to lowercase before it
    // reaches here so one person cannot hold two identities on case alone.
    buyerEmail: text('buyer_email').notNull(),
    buyerPhone: text('buyer_phone').notNull(),

    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('KES'),

    status: orderStatus('status').notNull().default('pending'),

    /** While in the future and status is pending/awaiting_payment, inventory
     *  stays held. The expiry worker releases it once this lapses. */
    reservedUntil: timestamp('reserved_until', { withTimezone: true }).notNull(),

    /** Client-supplied Idempotency-Key. A retried checkout returns the
     *  original order instead of double-reserving. */
    idempotencyKey: text('idempotency_key'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Set when inventory has been returned, so release is never applied twice. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('orders_reference_key').on(table.reference),
    uniqueIndex('orders_idempotency_key_key')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('orders_event_id_idx').on(table.eventId),
    index('orders_buyer_phone_idx').on(table.buyerPhone),
    // "My tickets", newest first.
    index('orders_user_id_idx').on(table.userId, table.createdAt),
    // Used when linking a new account's verified email to past guest orders.
    index('orders_buyer_email_idx').on(table.buyerEmail),
    // Drives the expiry sweep: find live holds that have lapsed.
    index('orders_status_reserved_until_idx').on(table.status, table.reservedUntil),
    check('orders_totals_non_negative', sql`${table.totalCents} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// order_items — one row per tier in the basket. Prices are snapshotted so a
// later tier price change never rewrites history.
// ---------------------------------------------------------------------------

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    tierId: uuid('tier_id')
      .notNull()
      .references(() => ticketTiers.id, { onDelete: 'restrict' }),

    /** Denormalised for receipts — survives a tier rename. */
    tierName: text('tier_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('order_items_order_id_idx').on(table.orderId),
    index('order_items_tier_id_idx').on(table.tierId),
    uniqueIndex('order_items_order_id_tier_id_key').on(table.orderId, table.tierId),
    check('order_items_quantity_positive', sql`${table.quantity} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// payments — one row per gateway attempt. An order may have several if the
// buyer retries after cancelling the STK prompt.
// ---------------------------------------------------------------------------

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    /** 'mpesa' today; the column exists so a second gateway needs no migration. */
    gateway: text('gateway').notNull().default('mpesa'),

    /** Gateway's own id for the attempt — M-Pesa CheckoutRequestID. */
    gatewayRef: text('gateway_ref').notNull(),
    /** Secondary gateway id — M-Pesa MerchantRequestID. */
    merchantRef: text('merchant_ref'),

    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('KES'),
    payerPhone: text('payer_phone'),

    status: paymentStatus('status').notNull().default('pending'),
    resultCode: integer('result_code'),
    resultDesc: text('result_desc'),

    /** M-Pesa receipt (e.g. SFF1A2B3C4). Unique — a receipt settles one order. */
    receipt: text('receipt'),
    transactionDate: timestamp('transaction_date', { withTimezone: true }),

    /** Bumped by the reconciliation worker when a callback never arrives. */
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),

    // Settlement claim. The webhook and the reconciler race to settle a payment
    // by design; a conditional UPDATE that stamps this column is what makes
    // exactly one of them win. Cleared again if the outcome turns out to be
    // still-pending, or if settlement throws partway.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    rawRequest: jsonb('raw_request').$type<Record<string, unknown>>(),
    rawResult: jsonb('raw_result').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('payments_gateway_ref_key').on(table.gateway, table.gatewayRef),
    uniqueIndex('payments_receipt_key')
      .on(table.receipt)
      .where(sql`${table.receipt} IS NOT NULL`),
    index('payments_order_id_idx').on(table.orderId),
    // Drives reconciliation: pending attempts, oldest first.
    index('payments_status_created_at_idx').on(table.status, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// tickets — issued only after a payment settles. One row per admission.
// ---------------------------------------------------------------------------

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    tierId: uuid('tier_id')
      .notNull()
      .references(() => ticketTiers.id, { onDelete: 'restrict' }),

    /** Scannable code, Crockford base32. The QR encodes `code.signature`. */
    code: text('code').notNull(),

    holderName: text('holder_name'),
    holderEmail: text('holder_email'),

    status: ticketStatus('status').notNull().default('issued'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    /** Free-text identifier of the gate/scanner that admitted the holder. */
    checkedInBy: text('checked_in_by'),

    /** Guarantees issuance is idempotent: the Nth ticket for an order item can
     *  only ever be inserted once, even if the issue job runs twice. */
    sequence: integer('sequence').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('tickets_code_key').on(table.code),
    uniqueIndex('tickets_order_item_sequence_key').on(
      table.orderItemId,
      table.sequence,
    ),
    index('tickets_order_id_idx').on(table.orderId),
    index('tickets_event_id_status_idx').on(table.eventId, table.status),
  ],
);

// ---------------------------------------------------------------------------
// webhook_events — every inbound gateway callback, stored before processing.
// The unique dedupe_key makes replayed callbacks a no-op, which matters because
// Safaricom retries aggressively on any non-200.
// ---------------------------------------------------------------------------

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gateway: text('gateway').notNull().default('mpesa'),

    /** Stable identity of this delivery, e.g. `mpesa:<checkoutId>:<resultCode>`. */
    dedupeKey: text('dedupe_key').notNull(),

    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: webhookStatus('status').notNull().default('received'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),

    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_events_dedupe_key_key').on(table.gateway, table.dedupeKey),
    index('webhook_events_status_idx').on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Immutable ledger
//
// Append-only record of every state transition in the system. This is the
// cross-reference of record when a buyer says they paid and we say they did
// not, or when inventory counters disagree with tickets issued.
//
// Three properties make it trustworthy:
//
//   1. Append-only, enforced by Postgres. The migration REVOKEs UPDATE/DELETE
//      from the application role and installs a trigger that raises on either.
//      Application code *cannot* rewrite history, whatever a future bug does.
//   2. Hash-chained. Each row hashes its own contents together with the
//      previous row's hash, so any alteration is detectable on verification
//      rather than merely prohibited.
//   3. Written inside the same transaction as the change it describes. A
//      transition and its ledger entry commit together or not at all, so the
//      ledger can never disagree with the tables it audits.
//
// `seq` is an identity column rather than a timestamp so every entry has a
// stable, unique label even when two land in the same millisecond. Note that it
// is *not* the chain's order: the identity default is evaluated when the INSERT
// begins, while the chain link is assigned inside the trigger after it has taken
// the chain lock, so two concurrent appends can land in the opposite order to
// their sequence numbers. Verification therefore walks `prev_hash`, not `seq`.
// ---------------------------------------------------------------------------

export const ledgerEntity = pgEnum('ledger_entity', [
  'order',
  'payment',
  'inventory',
  'ticket',
  'webhook',
  /**
   * Event-level administrative decisions — archiving, and deletion.
   *
   * Deletion especially: the ledger holds no foreign key to `events`, so its
   * record of a removal outlives the row it describes. That is the only place a
   * deleted event leaves a trace.
   */
  'event',
]);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),

    entity: ledgerEntity('entity').notNull(),
    entityId: uuid('entity_id').notNull(),

    /** Dotted transition name, e.g. `payment.settled` or `order.expired`. */
    event: text('event').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),

    /** Who caused it: `system:checkout`, `webhook:mpesa`, `admin:<key-id>`. */
    actor: text('actor').notNull(),

    // Denormalised so the common "everything that happened to this order"
    // query needs no joins, and still resolves if a row is later deleted.
    orderId: uuid('order_id'),
    eventId: uuid('event_id'),

    /** Minor units, when the transition moved money. */
    amountCents: bigint('amount_cents', { mode: 'number' }),

    /** Before/after values and any gateway identifiers worth keeping. */
    detail: jsonb('detail').$type<Record<string, unknown>>(),

    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** sha256 over this row's payload plus `prevHash`. Set by a trigger. */
    entryHash: text('entry_hash').notNull(),
    prevHash: text('prev_hash'),
  },
  (table) => [
    index('ledger_entries_order_id_idx').on(table.orderId, table.seq),
    index('ledger_entries_entity_idx').on(table.entity, table.entityId, table.seq),
    index('ledger_entries_event_idx').on(table.event, table.recordedAt),
    uniqueIndex('ledger_entries_entry_hash_key').on(table.entryHash),
  ],
);

/**
 * Chain tips, one row per ledger chain.
 *
 * Managed entirely by the `ledger_entries_hash` trigger — the application never
 * reads or writes this table. It exists because reading "the last entry in this
 * chain" with a plain SELECT is snapshot-dependent: under READ COMMITTED a
 * transaction that just waited for a lock may still not see the row the winner
 * inserted, and two appends then claim the same predecessor.
 *
 * Locking a *pre-existing* row instead is snapshot-independent — `INSERT … ON
 * CONFLICT DO UPDATE … RETURNING` locks the row, re-reads its latest committed
 * version and returns that. It is declared here only so `drizzle-kit generate`
 * does not decide the table is unknown and drop it.
 */
export const ledgerChainTips = pgTable('ledger_chain_tips', {
  /** `order_id::text`, or the literal `global` for entries with no order. */
  chainKey: text('chain_key').primaryKey(),
  /** Empty string means "chain claimed but nothing appended yet". */
  lastHash: text('last_hash').notNull(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const eventsRelations = relations(events, ({ many }) => ({
  tiers: many(ticketTiers),
  orders: many(orders),
  tickets: many(tickets),
}));

export const ticketTiersRelations = relations(ticketTiers, ({ one, many }) => ({
  event: one(events, { fields: [ticketTiers.eventId], references: [events.id] }),
  orderItems: many(orderItems),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  event: one(events, { fields: [orders.eventId], references: [events.id] }),
  items: many(orderItems),
  payments: many(payments),
  tickets: many(tickets),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  tier: one(ticketTiers, {
    fields: [orderItems.tierId],
    references: [ticketTiers.id],
  }),
  tickets: many(tickets),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));

export const ticketsRelations = relations(tickets, ({ one }) => ({
  event: one(events, { fields: [tickets.eventId], references: [events.id] }),
  order: one(orders, { fields: [tickets.orderId], references: [orders.id] }),
  orderItem: one(orderItems, {
    fields: [tickets.orderItemId],
    references: [orderItems.id],
  }),
  tier: one(ticketTiers, {
    fields: [tickets.tierId],
    references: [ticketTiers.id],
  }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type TicketTier = typeof ticketTiers.$inferSelect;
export type NewTicketTier = typeof ticketTiers.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type LedgerEntity = (typeof ledgerEntity.enumValues)[number];

export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type TicketStatus = (typeof ticketStatus.enumValues)[number];
export type EventStatus = (typeof eventStatus.enumValues)[number];
export type TierStatus = (typeof tierStatus.enumValues)[number];
