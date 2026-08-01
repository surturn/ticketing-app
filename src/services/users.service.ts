import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db, withTransaction } from '../db/client.js';
import { orders, users, type User } from '../db/schema.js';
import { TERMS_VERSION } from '../lib/consent.js';
import { sendEmail } from '../lib/email.js';
import { renderEmail } from '../lib/email-template.js';
import { deleteFirebaseUser, type AuthenticatedUser } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordTransition } from './ledger.service.js';

// ---------------------------------------------------------------------------
// Accounts.
//
// Every function here takes an already-verified `AuthenticatedUser`. None of them
// accepts a uid or email as a plain string from a caller, because at that point
// the value is only an assertion — the whole security property of this module is
// that identity arrives from a verified token and nowhere else.
// ---------------------------------------------------------------------------

export interface SignInResult {
  user: User;
  /** True the first time this uid was seen. */
  created: boolean;
  /** Past guest orders attached to the account by this sign-in. */
  linkedOrders: number;
}

/**
 * Records a sign-in, creating the local row on first sight.
 *
 * Called on every sign-in rather than once at registration: Firebase is the
 * source of truth for email and verification state, both of which change without
 * this service being told (a buyer verifies their address, or changes it), so
 * every sign-in is a chance to re-sync.
 */
export async function recordSignIn(
  subject: AuthenticatedUser,
): Promise<SignInResult> {
  const now = new Date();

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.id, subject.uid))
    .limit(1);

  // A different uid already holding this email means the same person signed up
  // twice through different providers — password once, Google once. Firebase
  // treats those as separate accounts unless linked. Refusing here would leave
  // the buyer stuck, so the newer uid gets the account and the email moves with
  // it; the older row keeps its orders and simply stops matching on email.
  if (!existing) {
    const [emailOwner] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, subject.email), sql`${users.id} <> ${subject.uid}`))
      .limit(1);

    if (emailOwner) {
      logger.warn(
        { email: subject.email, existingUid: emailOwner.id, newUid: subject.uid },
        'email already held by another account — releasing it to the new sign-in',
      );
      // Suffixed so the unique index still holds while keeping the old value
      // legible for support.
      await db
        .update(users)
        .set({ email: `${emailOwner.email}#${emailOwner.id.slice(0, 8)}`, updatedAt: now })
        .where(eq(users.id, emailOwner.id));
    }
  }

  const [user] = await db
    .insert(users)
    .values({
      id: subject.uid,
      email: subject.email,
      emailVerified: subject.emailVerified,
      displayName: subject.displayName,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: subject.email,
        emailVerified: subject.emailVerified,
        // Only overwrite a stored name when the provider actually supplies one,
        // so a Google sign-in does not blank a name set some other way.
        ...(subject.displayName ? { displayName: subject.displayName } : {}),
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning();

  const created = !existing;
  const linkedOrders = await linkGuestOrders(subject);

  return { user: user!, created, linkedOrders };
}

/**
 * Attaches past guest orders to an account.
 *
 * Gated on `email_verified`, and that gate is load-bearing: proven control of
 * the address is the only thing that establishes the claim, so it is required
 * before any order changes hands. Do not relax it.
 *
 * Firebase reports verification for password accounts only after the buyer
 * clicks through, and immediately for federated sign-in, which is why the
 * federated route is the smoothest path.
 *
 * Only unclaimed orders are touched (`user_id IS NULL`), so this can never move
 * an order that already belongs to somebody.
 */
export async function linkGuestOrders(
  subject: AuthenticatedUser,
): Promise<number> {
  if (!subject.emailVerified) return 0;

  return withTransaction(async (tx) => {
    const claimed = await tx
      .update(orders)
      .set({ userId: subject.uid, updatedAt: new Date() })
      .where(and(eq(orders.buyerEmail, subject.email), isNull(orders.userId)))
      .returning({ id: orders.id, reference: orders.reference, eventId: orders.eventId });

    if (claimed.length === 0) return 0;

    // Recorded per order: an order changing hands is exactly the kind of thing
    // that needs explaining if it is ever questioned.
    for (const order of claimed) {
      await recordTransition(tx, {
        entity: 'order',
        entityId: order.id,
        event: 'order.linked_to_account',
        fromState: 'guest',
        toState: 'account',
        actor: `user:${subject.uid}`,
        orderId: order.id,
        eventId: order.eventId,
        detail: {
          reference: order.reference,
          email: subject.email,
          // Noted because it is the condition that authorised the transfer.
          emailVerified: true,
          signInProvider: subject.signInProvider,
        },
      });
    }

    logger.info(
      { uid: subject.uid, count: claimed.length },
      'linked guest orders to account',
    );

    return claimed.length;
  });
}

/** Orders belonging to an account, newest first. */
export async function getOrdersForUser(uid: string, limit = 50) {
  return db
    .select({
      reference: orders.reference,
      status: orders.status,
      eventId: orders.eventId,
      totalCents: orders.totalCents,
      currency: orders.currency,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .where(eq(orders.userId, uid))
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(limit, 200));
}

export async function setAnnouncementsOptIn(
  uid: string,
  optIn: boolean,
): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ announcementsOptIn: optIn, updatedAt: new Date() })
    .where(eq(users.id, uid))
    .returning();

  return updated!;
}

export async function updateProfile(
  uid: string,
  fields: { displayName?: string; phone?: string; acceptTerms?: true },
): Promise<User> {
  const { acceptTerms, ...profile } = fields;

  const [updated] = await db
    .update(users)
    .set({
      ...profile,
      // Stamped server-side. A client-supplied timestamp would be evidence the
      // client controls, which is worth nothing as proof of when consent was
      // actually given.
      ...(acceptTerms
        ? { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, uid))
    .returning();

  return updated!;
}

/**
 * The welcome, sent once — the first time an account is seen.
 *
 * Gated on `created` at the call site rather than on anything here, because
 * `recordSignIn` runs on *every* sign-in: a welcome that fired each time would
 * become the thing people filter to spam within a week.
 *
 * Not a marketing message, so it does not need announcement consent. It
 * confirms an account exists, says what it is for, and gives a reply address —
 * exactly the service message someone who just signed up expects. It carries no
 * promotion, which is what keeps that true.
 *
 * Failures are logged and swallowed by the caller: a sign-in must never fail
 * because an email did not send.
 */
export async function sendWelcomeEmail(
  email: string,
  displayName: string | null,
): Promise<void> {
  const firstName = displayName?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  await sendEmail({
    to: email,
    toName: displayName,
    subject: 'Welcome to Eventify Tickets',
    html: renderEmail({
      heading: firstName ? `Welcome, ${firstName}` : 'Welcome to Eventify Tickets',
      intro: [
        'Your account is ready — thank you for joining us.',
        'Everything you buy now lives in one place. Your tickets are here whether you change phone, lose the email, or arrive at the gate with no signal.',
      ],
      section: {
        title: 'A few things worth knowing',
        body: [
          'Any tickets you bought as a guest with this address have been added automatically.',
          'Every ticket still arrives by email as well, so nothing depends on you remembering a password on the night.',
          'We only email you about new events if you have asked us to, and you can change that any time in account settings.',
        ],
      },
      ...(env.PUBLIC_ORDER_BASE_URL
        ? {
            action: {
              label: 'See my tickets',
              url: `${env.PUBLIC_ORDER_BASE_URL.replace(/\/+$/, '')}/account`,
            },
          }
        : {}),
    }),
    text: [
      greeting,
      '',
      'Your account is ready — thank you for joining us.',
      '',
      'Everything you buy now lives in one place. Your tickets are here whether',
      'you change phone, lose the email, or arrive at the gate with no signal,',
      'and any tickets you bought as a guest with this address have been added',
      'automatically.',
      '',
      'A few things worth knowing:',
      '',
      '  - Your tickets are always at eventify under My tickets.',
      '  - Every ticket still arrives by email as well. Nothing depends on you',
      '    remembering a password on the night.',
      '  - We only email you about new events if you have asked us to. You can',
      '    change that any time in account settings.',
      '',
      'If anything ever goes wrong — a ticket that has not arrived, a payment',
      'that looks wrong, a question about an event — just reply to this email.',
      'It reaches a person.',
      '',
      'See you at the show.',
      '',
      'Eventify Tickets',
      'hello@invonicstechnologies.com',
    ].join('\n'),
  });
}

/**
 * Closes an account permanently.
 *
 * What is removed and what survives is the whole design here, and the two are
 * not the same thing:
 *
 *   - The profile row goes. Name, phone, email, announcement preference — every
 *     field that exists because the buyer told us about themselves.
 *   - Orders and tickets stay. `orders.user_id` is declared `on delete set
 *     null`, so they detach rather than cascade. They are financial records of
 *     a real transaction, and a ticket that vanished from the gate because
 *     someone tidied up their account would be a buyer turned away at a door
 *     they had paid to walk through. The order reference still resolves for
 *     anyone holding the link.
 *
 * The Firebase user is deleted last, and deliberately so. If it were removed
 * first and the database write then failed, the buyer would be locked out of an
 * account that still existed — unable to sign in, and unable to ask us to
 * finish deleting it. This order fails safe: a failure after the row is gone
 * leaves a Firebase identity with nothing attached, which the next sign-in
 * simply recreates as a fresh account.
 */
export async function deleteAccount(uid: string): Promise<void> {
  await db.delete(users).where(eq(users.id, uid));
  await deleteFirebaseUser(uid);
}
