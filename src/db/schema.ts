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

export const tierStatus = pgEnum('tier_status', ['active', 'paused', 'hidden']);

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

    quantityTotal: integer('quantity_total').notNull(),
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
    check(
      'ticket_tiers_no_oversell',
      sql`${table.quantityReserved} + ${table.quantitySold} <= ${table.quantityTotal}`,
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

    buyerName: text('buyer_name').notNull(),
    buyerEmail: text('buyer_email'),
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

export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type TicketStatus = (typeof ticketStatus.enumValues)[number];
export type EventStatus = (typeof eventStatus.enumValues)[number];
export type TierStatus = (typeof tierStatus.enumValues)[number];
