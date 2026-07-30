/**
 * Drives one order through the entire settlement pipeline against Safaricom's
 * sandbox.
 *
 *   npm run check:settlement
 *
 * Sandbox's test MSISDN has no handset behind it, so a push always resolves to
 * result 1037 (`DS timeout user cannot be reached`). That is a *terminal* outcome,
 * which makes it genuinely useful: it exercises the reconciler, the settlement
 * compare-and-swap, the compensating inventory release and the ledger writes,
 * without needing anyone to enter a PIN.
 *
 * Every assertion is on state read back from Postgres, not on return values.
 */
process.env.LOG_LEVEL ??= 'warn';

const SANDBOX_TEST_MSISDN = '254708374149';

const { env } = await import('../src/config/env.js');
const { db, closeDatabase } = await import('../src/db/client.js');
const { events, ticketTiers, orders, payments } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');
const { createCheckout } = await import('../src/services/checkout.service.js');
const { applySettlement } = await import('../src/services/payments.service.js');
const { mpesaGateway } = await import('../src/gateways/mpesa/gateway.js');
const { getOrderHistory, verifyChain } = await import('../src/services/ledger.service.js');
const { closeRedis } = await import('../src/lib/redis.js');
const { closeQueues } = await import('../src/queue/queues.js');

if (env.MPESA_ENVIRONMENT === 'production') {
  console.log('Refusing to run against production — this places a real charge.');
  process.exit(1);
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

function heading(text: string): void {
  console.log(`\n${'─'.repeat(64)}\n${text}\n${'─'.repeat(64)}`);
}

const availability = (t: { quantityTotal: number; quantityReserved: number; quantitySold: number }) =>
  t.quantityTotal - t.quantityReserved - t.quantitySold;

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

const [seedTier] = await db
  .select()
  .from(ticketTiers)
  .where(eq(ticketTiers.eventId, event.id))
  .limit(1);

const tierId = seedTier!.id;
const availableBefore = availability(seedTier!);

heading('1. Checkout — reserves inventory and pushes to Daraja');
console.log(`tier "${seedTier!.name}", available ${availableBefore}`);

const checkout = await createCheckout({
  eventSlug: 'sample-summit-2026',
  items: [{ tierId, quantity: 1 }],
  buyer: {
    name: 'Settlement Check',
    email: `settlement-${Date.now()}@example.com`,
    phone: SANDBOX_TEST_MSISDN,
  },
  idempotencyKey: `settlement-${Date.now()}`,
});

console.log(`reference ${checkout.reference}, gatewayRef ${checkout.payment?.gatewayRef}`);

const afterCheckout = await readTier(tierId);
check('order is awaiting_payment', checkout.status === 'awaiting_payment', checkout.status);
check('a gateway reference was recorded', Boolean(checkout.payment?.gatewayRef));
check(
  'one seat moved to reserved',
  availability(afterCheckout) === availableBefore - 1,
  `available ${availability(afterCheckout)}`,
);

// ─── Idempotency ───────────────────────────────────────────────────────────
heading('2. Idempotency — a retried key must not reserve twice');
const replay = await createCheckout({
  eventSlug: 'sample-summit-2026',
  items: [{ tierId, quantity: 1 }],
  buyer: {
    name: 'Settlement Check',
    email: 'ignored-on-replay@example.com',
    phone: SANDBOX_TEST_MSISDN,
  },
  idempotencyKey: checkout.reference, // reuse a stable key
});

const afterReplayFirst = await readTier(tierId);
const replayAgain = await createCheckout({
  eventSlug: 'sample-summit-2026',
  items: [{ tierId, quantity: 1 }],
  buyer: {
    name: 'Settlement Check',
    email: 'ignored-on-replay@example.com',
    phone: SANDBOX_TEST_MSISDN,
  },
  idempotencyKey: checkout.reference,
});
const afterReplaySecond = await readTier(tierId);

check(
  'second call with the same key returns the same order',
  replayAgain.reference === replay.reference,
  replayAgain.reference,
);
check('and it is flagged as a replay', replayAgain.idempotentReplay === true);
check(
  'and reserves no further inventory',
  availability(afterReplaySecond) === availability(afterReplayFirst),
  `available ${availability(afterReplaySecond)}`,
);

// ─── Reconcile ─────────────────────────────────────────────────────────────
heading('3. Reconciliation — the path used when no callback arrives');

const gatewayRef = checkout.payment!.gatewayRef;

/**
 * Polls the way the reconcile worker does, rather than querying once.
 *
 * While a push is still in flight Daraja answers the status query with a 500
 * carrying `500.001.1001`, which the gateway raises as a retryable error. The
 * worker catches exactly that and reschedules; a single query here would
 * instead fail the check for a transient state that the real system handles
 * correctly — testing something production never does.
 *
 * A `pending` outcome is treated the same way, since it means the same thing.
 */
async function queryUntilTerminal(ref: string, attempts = 10, delayMs = 5_000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await mpesaGateway.queryStatus(ref);
      if (result.outcome !== 'pending') return result;
      console.log(`  attempt ${attempt}: still pending`);
    } catch (error) {
      console.log(`  attempt ${attempt}: inconclusive — ${(error as Error).message.split('\n')[0]}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `Daraja never reached a terminal state for ${ref} after ${attempts} attempts. ` +
      'That is a sandbox availability problem, not a defect in this service.',
  );
}

console.log('polling Daraja until the push reaches a terminal state…');
const settlement = await queryUntilTerminal(gatewayRef);
console.log(`Daraja says: ${settlement.resultCode} — ${settlement.resultDesc}`);
console.log(`mapped outcome: ${settlement.outcome}`);

const applied = await applySettlement(settlement);
console.log(`applySettlement: ${JSON.stringify(applied)}`);

check('settlement was applied', applied.applied === true, applied.reason ?? '');

// ─── Second delivery must be rejected ──────────────────────────────────────
heading('4. Duplicate settlement — the compare-and-swap must reject it');
const duplicate = await applySettlement(settlement);
check(
  'a repeated settlement is refused',
  duplicate.applied === false && duplicate.reason === 'already_settled',
  `applied=${duplicate.applied} reason=${duplicate.reason}`,
);

// ─── Final state ───────────────────────────────────────────────────────────
heading('5. Final state in Postgres');
const [finalOrder] = await db
  .select()
  .from(orders)
  .where(eq(orders.reference, checkout.reference))
  .limit(1);

const [finalPayment] = await db
  .select()
  .from(payments)
  .where(eq(payments.gatewayRef, gatewayRef))
  .limit(1);

const finalTier = await readTier(tierId);

check(
  'payment reached a terminal status',
  ['failed', 'cancelled', 'timeout', 'succeeded'].includes(finalPayment!.status),
  finalPayment!.status,
);
check('payment records the result code', finalPayment!.resultCode !== null, String(finalPayment!.resultCode));
check('settledAt is stamped', finalPayment!.settledAt !== null);
check(
  'order reached a terminal status',
  ['failed', 'cancelled', 'expired', 'paid'].includes(finalOrder!.status),
  finalOrder!.status,
);
// At least, not exactly. The idempotency step above leaves a second order
// holding a seat, and if the worker is running the reconciler will settle that
// one too — on its own schedule, correctly, and mid-run. An equality assertion
// here fails whenever that happens, which means it fails *because the system
// worked*. Both effects can only return seats, never take them, so the bound is
// the honest assertion; that this specific order released its own seat is what
// the `inventory.released` ledger check below establishes.
check(
  'the held seat was returned',
  availability(finalTier) >= availability(afterReplaySecond) + 1,
  `available ${availability(finalTier)}, was ${availability(afterReplaySecond)}`,
);

// ─── Ledger ────────────────────────────────────────────────────────────────
heading('6. Ledger');
const history = await getOrderHistory(finalOrder!.id);
for (const entry of history) {
  console.log(
    `  ${entry.event.padEnd(24)} ${String(entry.fromState).padEnd(18)} -> ${entry.toState.padEnd(16)} ${entry.actor}`,
  );
}

const seen = history.map((e) => e.event);
const expected = [
  'order.created',
  'inventory.reserved',
  'order.awaiting_payment',
  'payment.initiated',
];
for (const event of expected) {
  check(`recorded ${event}`, seen.includes(event));
}
check(
  'recorded the terminal payment transition',
  seen.some((e) => e.startsWith('payment.') && e !== 'payment.initiated'),
  seen.filter((e) => e.startsWith('payment.')).join(', '),
);
check('recorded the inventory release', seen.includes('inventory.released'));

const integrity = await verifyChain({ orderId: finalOrder!.id });
check('hash chain verifies', integrity.valid, `${integrity.entriesChecked} entries`);

// ─── Result ────────────────────────────────────────────────────────────────
heading('Result');
if (failures.length === 0) {
  console.log(`PASS — ${history.length} ledger entries, chain intact, inventory balanced.`);
} else {
  console.log(`FAIL — ${failures.length} check(s) failed:`);
  for (const failure of failures) console.log(`  • ${failure}`);
}

await closeQueues();
await closeRedis();
await closeDatabase();
process.exit(failures.length === 0 ? 0 : 1);
