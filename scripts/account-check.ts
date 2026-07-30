/**
 * Buyer accounts, end to end against the running API.
 *
 *   npm run check:account
 *
 * The other check scripts stop at the gate; this one covers the path a buyer
 * takes *around* the purchase — signing in, and finding tickets they bought as a
 * guest before they had an account.
 *
 * The token is real. A custom token is minted with the Admin SDK and exchanged
 * for a genuine ID token through Identity Toolkit, exactly as the browser SDK
 * would, so `requireUser` and `verifyIdToken` are exercised for real rather than
 * stubbed — which is the only way to prove the service-account credential, the
 * project id and the route guard all agree.
 *
 * Requires the API on :4000. Creates a throwaway Firebase user and deletes it.
 */
process.env.LOG_LEVEL ??= 'warn';

import { readFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:4000';

const { env, firebaseConfigured } = await import('../src/config/env.js');
const { db, closeDatabase } = await import('../src/db/client.js');
const { events, ticketTiers, orders } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');
const { closeRedis } = await import('../src/lib/redis.js');
const { closeQueues } = await import('../src/queue/queues.js');

if (!firebaseConfigured) {
  console.log('Accounts are not configured. Fill in the FIREBASE_* values in .env.');
  process.exit(1);
}

/**
 * The web API key, which is what Identity Toolkit authenticates the exchange
 * with. It lives in `web/.env` because it is a client value, so it is read from
 * there rather than duplicated into the server's environment.
 */
function webApiKey(): string {
  if (process.env.FIREBASE_WEB_API_KEY) return process.env.FIREBASE_WEB_API_KEY;

  const match = /^VITE_FIREBASE_API_KEY=(.+)$/m.exec(
    readFileSync(new URL('../web/.env', import.meta.url), 'utf8'),
  );
  const key = match?.[1]?.trim();

  if (!key) {
    console.log('No web API key. Set FIREBASE_WEB_API_KEY, or fill in web/.env.');
    process.exit(1);
  }
  return key;
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

function heading(text: string): void {
  console.log(`\n${'─'.repeat(64)}\n${text}\n${'─'.repeat(64)}`);
}

const { cert, initializeApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');

const adminApp = initializeApp(
  {
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID!,
      clientEmail: env.FIREBASE_CLIENT_EMAIL!,
      privateKey: env.FIREBASE_PRIVATE_KEY!,
    }),
    projectId: env.FIREBASE_PROJECT_ID!,
  },
  'account-check',
);

const email = `account-check-${Date.now()}@example.com`;
let uid: string | null = null;
let orderId: string | null = null;

try {
  // ─── A guest order, bought before the account exists ─────────────────────
  heading('1. A guest order exists for this address');

  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.slug, 'sample-summit-2026'))
    .limit(1);

  if (!event) throw new Error('Seed data missing — run npm run db:seed first.');

  const [tier] = await db
    .select()
    .from(ticketTiers)
    .where(eq(ticketTiers.eventId, event.id))
    .limit(1);

  const [guestOrder] = await db
    .insert(orders)
    .values({
      reference: `TKT-AC${Date.now().toString(36).toUpperCase().slice(-6)}`,
      eventId: event.id,
      // Null is the point: nobody owns it yet.
      userId: null,
      buyerName: 'Account Check',
      buyerEmail: email,
      buyerPhone: '254708374149',
      subtotalCents: tier!.priceCents,
      totalCents: tier!.priceCents,
      status: 'paid',
      reservedUntil: new Date(Date.now() + 600_000),
      paidAt: new Date(),
    })
    .returning();

  orderId = guestOrder!.id;
  console.log(`guest order ${guestOrder!.reference} for ${email}`);

  // ─── An account, with a verified address ─────────────────────────────────
  heading('2. Sign in, with a real ID token');

  const user = await getAuth(adminApp).createUser({
    email,
    emailVerified: true, // As Google and Apple arrive; the gate for linking.
    displayName: 'Account Check',
  });
  uid = user.uid;

  const customToken = await getAuth(adminApp).createCustomToken(uid);

  const exchange = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );

  const exchanged = (await exchange.json()) as { idToken?: string; error?: unknown };
  if (!exchanged.idToken) {
    throw new Error(`Token exchange failed: ${JSON.stringify(exchanged.error)}`);
  }
  const idToken = exchanged.idToken;
  check('exchanged a custom token for an ID token', true, `${idToken.length} chars`);

  // ─── The guard ───────────────────────────────────────────────────────────
  heading('3. The route guard');

  const anonymous = await fetch(`${API}/api/account/session`, { method: 'POST' });
  check('an unauthenticated call is refused', anonymous.status === 401, `${anonymous.status}`);

  const forged = await fetch(`${API}/api/account/session`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-real-token' },
  });
  check('a forged token is refused', forged.status === 401, `${forged.status}`);

  // ─── Session ─────────────────────────────────────────────────────────────
  heading('4. Session — mirrors the account and adopts guest orders');

  const sessionResponse = await fetch(`${API}/api/account/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const session = (await sessionResponse.json()) as {
    user?: { email: string; emailVerified: boolean };
    created?: boolean;
    linkedOrders?: number;
    verificationRequiredToLinkOrders?: boolean;
  };

  check('the session call succeeds', sessionResponse.ok, `${sessionResponse.status}`);
  check('it reports the account as new', session.created === true);
  check('the email round-trips', session.user?.email === email, session.user?.email ?? '—');
  check('the address is verified', session.user?.emailVerified === true);
  check('verification is not demanded', session.verificationRequiredToLinkOrders === false);
  check('the guest order was adopted', session.linkedOrders === 1, `${session.linkedOrders}`);

  // Asserted from Postgres, not the response — the response could be right
  // about a write that did not land.
  const [linked] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  check('and the order row now carries the uid', linked!.userId === uid);

  // ─── Repeat ──────────────────────────────────────────────────────────────
  heading('5. Signing in again is idempotent');

  const again = await fetch(`${API}/api/account/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const secondSession = (await again.json()) as { created?: boolean; linkedOrders?: number };
  check('the account is no longer new', secondSession.created === false);
  check('nothing is linked twice', secondSession.linkedOrders === 0, `${secondSession.linkedOrders}`);

  // ─── The buyer's own orders ──────────────────────────────────────────────
  heading("6. The buyer's orders");

  const mine = await fetch(`${API}/api/account/orders`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const body = (await mine.json()) as { orders?: { reference: string }[] };

  check('the order list is returned', mine.ok, `${mine.status}`);
  check(
    'and contains the adopted order',
    body.orders?.some((o) => o.reference === guestOrder!.reference) === true,
    `${body.orders?.length ?? 0} order(s)`,
  );
} finally {
  // Always: a leaked Firebase user with a verified address would silently claim
  // future orders sent to the same address.
  if (uid) await getAuth(adminApp).deleteUser(uid).catch(() => {});
  if (orderId) await db.delete(orders).where(eq(orders.id, orderId)).catch(() => {});

  await closeQueues().catch(() => {});
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
}

heading('Result');
if (failures.length > 0) {
  console.log(`FAIL — ${failures.length} check(s) failed:`);
  for (const failure of failures) console.log(`  • ${failure}`);
  process.exit(1);
}
console.log('PASS — token verified, account mirrored, guest order adopted.\n');
process.exit(0);
