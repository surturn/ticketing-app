/**
 * End-to-end check that the ledger records a real order lifecycle.
 *
 * Runs a genuine checkout with deliberately invalid M-Pesa credentials. That is
 * the useful failure: the gateway passes its `isConfigured()` check, so the
 * inventory transaction commits and its ledger entries are written, then the
 * Daraja call fails and the compensating release runs. One pass therefore
 * exercises reserve → ledger, release → ledger, and the counters returning to
 * where they started.
 *
 *   npx tsx scripts/ledger-lifecycle-check.ts
 */
process.env.MPESA_CONSUMER_KEY ??= 'invalid-key-for-lifecycle-check';
process.env.MPESA_CONSUMER_SECRET ??= 'invalid-secret-for-lifecycle-check';
process.env.MPESA_PASSKEY ??= 'invalid-passkey-for-lifecycle-check';
process.env.MPESA_CALLBACK_URL ??= 'https://example.invalid/api/webhooks/mpesa';
process.env.LOG_LEVEL = 'silent';

const { db, closeDatabase } = await import('../src/db/client.js');
const { events, ticketTiers, orders } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');
const { createCheckout } = await import('../src/services/checkout.service.js');
const { getOrderHistory, verifyChain } = await import('../src/services/ledger.service.js');
const { closeRedis } = await import('../src/lib/redis.js');

const [event] = await db
  .select()
  .from(events)
  .where(eq(events.slug, 'sample-summit-2026'))
  .limit(1);

if (!event) throw new Error('run `npm run db:seed` first');

const [tier] = await db
  .select()
  .from(ticketTiers)
  .where(eq(ticketTiers.eventId, event.id))
  .limit(1);

if (!tier) throw new Error('seeded event has no tiers');

const before = tier.quantityTotal - tier.quantityReserved - tier.quantitySold;
console.log(`tier "${tier.name}" available before: ${before}`);

// A unique email per run, so the order this check inspects is unambiguously the
// one it just created rather than a leftover from a previous run.
const runId = Date.now();
const buyerEmail = `lifecycle-${runId}@example.com`;

let failed = false;
try {
  await createCheckout({
    eventSlug: 'sample-summit-2026',
    items: [{ tierId: tier.id, quantity: 2 }],
    buyer: {
      name: 'Lifecycle Check',
      email: buyerEmail,
      phone: '254712345678',
    },
    idempotencyKey: `lifecycle-${runId}`,
  });
} catch (error) {
  failed = true;
  console.log(`checkout failed as expected: ${(error as Error).message}`);
}

const [after] = await db
  .select()
  .from(ticketTiers)
  .where(eq(ticketTiers.id, tier.id))
  .limit(1);

const availableAfter =
  after!.quantityTotal - after!.quantityReserved - after!.quantitySold;
console.log(`tier "${tier.name}" available after:  ${availableAfter}`);

// The order exists even though the charge failed, so its history is readable.
const [order] = await db
  .select()
  .from(orders)
  .where(eq(orders.buyerEmail, buyerEmail))
  .limit(1);

if (!order) throw new Error('no order was written — the inventory transaction never committed');

const history = await getOrderHistory(order.id);
console.log(`\nledger history for ${order.reference} (status: ${order.status}):`);
for (const entry of history) {
  console.log(
    `  seq=${entry.seq} ${entry.event.padEnd(22)} ${String(entry.fromState).padEnd(18)} -> ${entry.toState.padEnd(14)} by ${entry.actor}`,
  );
}

const integrity = await verifyChain({ orderId: order.id });
console.log('\nchain integrity:', JSON.stringify(integrity));

await closeRedis();
await closeDatabase();

const expected = ['order.created', 'inventory.reserved', 'order.failed', 'inventory.released'];
const seen = history.map((entry) => entry.event);
const missing = expected.filter((event) => !seen.includes(event));

const ok =
  failed &&
  availableAfter === before &&
  missing.length === 0 &&
  integrity.valid;

if (!ok) {
  console.log('\nFAIL');
  if (!failed) console.log('  - checkout unexpectedly succeeded');
  if (availableAfter !== before) console.log('  - inventory was not returned');
  if (missing.length) console.log(`  - ledger missing: ${missing.join(', ')}`);
  if (!integrity.valid) console.log(`  - chain invalid: ${integrity.reason}`);
  process.exit(1);
}

console.log('\nPASS: inventory returned, full lifecycle recorded, chain intact');
process.exit(0);
