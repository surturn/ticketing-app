/**
 * The happy path: paid order → tickets issued → admitted at the gate.
 *
 *   npm run check:success
 *
 * Sandbox's test MSISDN has no handset, so a real push always times out and the
 * success path can never be reached that way. Here the STK push is real, but the
 * callback is synthesised — a Safaricom-shaped body with ResultCode 0 posted to the
 * live webhook route, carrying the CheckoutRequestID Daraja actually returned.
 *
 * That keeps everything downstream of the callback genuine: route, token check,
 * delivery dedupe, settlement, inventory commit, ticket issuance, QR signing and
 * single-use check-in.
 *
 * Requires the API on :4000. Run the worker too, or issuance is invoked directly.
 */
process.env.LOG_LEVEL ??= 'warn';

const SANDBOX_TEST_MSISDN = '254708374149';
const API = process.env.API_URL ?? 'http://localhost:4000';

const { env } = await import('../src/config/env.js');
const { db, closeDatabase } = await import('../src/db/client.js');
const { events, ticketTiers, orders, payments, webhookEvents } = await import(
  '../src/db/schema.js'
);
const { eq } = await import('drizzle-orm');
const { issueTicketsForOrder, checkInTicket } = await import(
  '../src/services/tickets.service.js'
);
const { getOrderHistory, verifyChain } = await import('../src/services/ledger.service.js');
const { closeRedis } = await import('../src/lib/redis.js');
const { closeQueues } = await import('../src/queue/queues.js');

if (env.MPESA_ENVIRONMENT === 'production') {
  console.log('Refusing to run against production.');
  process.exit(1);
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};
const heading = (text: string) =>
  console.log(`\n${'─'.repeat(64)}\n${text}\n${'─'.repeat(64)}`);

const availability = (t: {
  quantityTotal: number;
  quantityReserved: number;
  quantitySold: number;
}) => t.quantityTotal - t.quantityReserved - t.quantitySold;

const readTier = async (id: string) =>
  (await db.select().from(ticketTiers).where(eq(ticketTiers.id, id)).limit(1))[0]!;

// ─── Setup ─────────────────────────────────────────────────────────────────
const [event] = await db
  .select()
  .from(events)
  .where(eq(events.slug, 'sample-summit-2026'))
  .limit(1);
if (!event) {
  console.log('Run `npm run db:seed` first.');
  process.exit(1);
}

// The VIP tier, to keep this independent of the other check scripts.
const tiers = await db.select().from(ticketTiers).where(eq(ticketTiers.eventId, event.id));
const tier = tiers.find((t) => t.name === 'VIP') ?? tiers[0]!;

const before = await readTier(tier.id);
const soldBefore = before.quantitySold;

heading('1. Checkout over HTTP');
const buyerEmail = `success-${Date.now()}@example.com`;

const checkoutResponse = await fetch(`${API}/api/checkout`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': `success-${Date.now()}`,
  },
  body: JSON.stringify({
    eventSlug: 'sample-summit-2026',
    items: [{ tierId: tier.id, quantity: 2 }],
    buyer: { name: 'Happy Path', email: buyerEmail, phone: SANDBOX_TEST_MSISDN },
  }),
});

if (!checkoutResponse.ok) {
  console.log(`checkout failed (${checkoutResponse.status}): ${await checkoutResponse.text()}`);
  console.log('\nIs the API running? `npm run dev`');
  process.exit(1);
}

const checkout = (await checkoutResponse.json()) as {
  reference: string;
  status: string;
  totalCents: number;
  payment: { gatewayRef: string };
};

console.log(`reference ${checkout.reference}`);
console.log(`gatewayRef ${checkout.payment.gatewayRef}`);
check('order is awaiting_payment', checkout.status === 'awaiting_payment', checkout.status);

const afterCheckout = await readTier(tier.id);
check(
  'two seats moved to reserved',
  availability(afterCheckout) === availability(before) - 2,
  `available ${availability(afterCheckout)}`,
);

// ─── Callback ──────────────────────────────────────────────────────────────
heading('2. Successful callback, posted to the live webhook route');

const receipt = `RKT${Date.now().toString(36).toUpperCase().slice(-7)}`;
const amountShillings = checkout.totalCents / 100;

const callbackBody = {
  Body: {
    stkCallback: {
      MerchantRequestID: 'sim-merchant-request',
      CheckoutRequestID: checkout.payment.gatewayRef,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: amountShillings },
          { Name: 'MpesaReceiptNumber', Value: receipt },
          { Name: 'TransactionDate', Value: Number(new Date().toISOString().slice(0, 19).replace(/\D/g, '')) },
          { Name: 'PhoneNumber', Value: Number(SANDBOX_TEST_MSISDN) },
        ],
      },
    },
  },
};

const callbackUrl = new URL(`${API}/api/webhooks/mpesa`);
if (env.MPESA_CALLBACK_TOKEN) callbackUrl.searchParams.set('token', env.MPESA_CALLBACK_TOKEN);

const callbackResponse = await fetch(callbackUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(callbackBody),
});

const ack = (await callbackResponse.json()) as { ResultCode: number };
console.log(`receipt ${receipt}, amount KES ${amountShillings}`);
check('webhook acknowledged with 200', callbackResponse.status === 200, String(callbackResponse.status));
check('acknowledgement body is ResultCode 0', ack.ResultCode === 0);

// A rejected token must also return 200, so a prober learns nothing.
const badTokenResponse = await fetch(`${API}/api/webhooks/mpesa?token=wrong`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(callbackBody),
});
check(
  'a bad token still returns 200',
  badTokenResponse.status === 200,
  String(badTokenResponse.status),
);

// ─── Settlement ────────────────────────────────────────────────────────────
heading('3. Settlement');
const [settledPayment] = await db
  .select()
  .from(payments)
  .where(eq(payments.gatewayRef, checkout.payment.gatewayRef))
  .limit(1);

const [paidOrder] = await db
  .select()
  .from(orders)
  .where(eq(orders.reference, checkout.reference))
  .limit(1);

check('payment succeeded', settledPayment!.status === 'succeeded', settledPayment!.status);
check('the M-Pesa receipt was stored', settledPayment!.receipt === receipt, settledPayment!.receipt ?? 'null');
check('order is paid', paidOrder!.status === 'paid', paidOrder!.status);
check('paidAt is stamped', paidOrder!.paidAt !== null);

const afterSettle = await readTier(tier.id);
check(
  'two seats moved reserved → sold',
  afterSettle.quantitySold === soldBefore + 2,
  `sold ${afterSettle.quantitySold}`,
);
check(
  'reserved returned to its starting value',
  afterSettle.quantityReserved === before.quantityReserved,
  `reserved ${afterSettle.quantityReserved}`,
);

// A replayed delivery must be recognised and dropped.
const replayResponse = await fetch(callbackUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(callbackBody),
});
const deliveries = await db
  .select()
  .from(webhookEvents)
  .where(eq(webhookEvents.dedupeKey, `${checkout.payment.gatewayRef}:0`));

check('a replayed callback returns 200', replayResponse.status === 200);
check('and is stored exactly once', deliveries.length === 1, `${deliveries.length} row(s)`);
check('with status processed', deliveries[0]?.status === 'processed', deliveries[0]?.status ?? '');

// ─── Ticket issuance ───────────────────────────────────────────────────────
heading('4. Ticket issuance');
const issued = await issueTicketsForOrder(paidOrder!.id);
console.log(`issued ${issued.length} ticket(s)`);
for (const ticket of issued) console.log(`  ${ticket.tierName}  ${ticket.code}`);

check('two tickets exist', issued.length === 2, String(issued.length));
check('each carries a signed QR payload', issued.every((t) => t.qr.includes('.')));
check('codes are unique', new Set(issued.map((t) => t.code)).size === issued.length);

// Issuance runs from a queue that can deliver the same job twice.
const reissued = await issueTicketsForOrder(paidOrder!.id);
check('re-running issuance creates no duplicates', reissued.length === 2, String(reissued.length));

// ─── Check-in ──────────────────────────────────────────────────────────────
heading('5. Check-in at the gate');
const first = issued[0]!;

const admitted = await checkInTicket(first.qr, { eventId: event.id, scannedBy: 'gate-1' });
check('a valid QR is admitted', admitted.admitted === true);
check('the holder name is returned', Boolean(admitted.ticket.holderName), admitted.ticket.holderName ?? '');

const second = await checkInTicket(first.qr, { eventId: event.id, scannedBy: 'gate-2' });
check('a second scan is refused', second.admitted === false);
check('and says why', second.reason === 'already_checked_in', second.reason ?? '');
check('and reports the original gate', second.ticket.checkedInBy === 'gate-1', second.ticket.checkedInBy ?? '');

// A tampered signature must not pass.
const tampered = `${first.code}.AAAAAAAAAAAAAAAAAAAAAAAAAAA`;
let rejected = false;
try {
  await checkInTicket(tampered, { eventId: event.id });
} catch {
  rejected = true;
}
check('a forged QR signature is rejected', rejected);

// ─── Ledger ────────────────────────────────────────────────────────────────
heading('6. Ledger');
const history = await getOrderHistory(paidOrder!.id);
for (const entry of history) {
  console.log(
    `  ${entry.event.padEnd(24)} ${String(entry.fromState).padEnd(18)} -> ${entry.toState.padEnd(14)} ${entry.actor}`,
  );
}

const seen = history.map((e) => e.event);
for (const expected of [
  'order.created',
  'inventory.reserved',
  'payment.initiated',
  'order.awaiting_payment',
  'payment.settled',
  'order.paid',
  'inventory.sold',
  'ticket.issued',
  'ticket.checked_in',
]) {
  check(`recorded ${expected}`, seen.includes(expected));
}

const settledEntry = history.find((e) => e.event === 'payment.settled');
check(
  'the settled entry carries the M-Pesa receipt',
  (settledEntry?.detail as { receipt?: string } | null)?.receipt === receipt,
  String((settledEntry?.detail as { receipt?: string } | null)?.receipt),
);

const integrity = await verifyChain({ orderId: paidOrder!.id });
check('hash chain verifies', integrity.valid, `${integrity.entriesChecked} entries`);

// ─── Result ────────────────────────────────────────────────────────────────
heading('Result');
if (failures.length === 0) {
  console.log(`PASS — paid, issued, admitted. ${history.length} ledger entries, chain intact.`);
} else {
  console.log(`FAIL — ${failures.length} check(s) failed:`);
  for (const failure of failures) console.log(`  • ${failure}`);
}

await closeQueues();
await closeRedis();
await closeDatabase();
process.exit(failures.length === 0 ? 0 : 1);
