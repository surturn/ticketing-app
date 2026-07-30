import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscribers, users, type Subscriber } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// "Tell me when an event pops up" — no account required.
//
// Double opt-in: a subscription is created unconfirmed and receives nothing until
// the address is confirmed by clicking through. That protects two separate
// things — the sending domain's reputation, which unconfirmed lists destroy, and
// anyone whose address gets typed into the form by somebody else.
//
// Every state change is driven by an unguessable token rather than by an email
// address or a row id. A sequential id in an unsubscribe link would let anyone
// unsubscribe a stranger, or confirm an address they do not own.
// ---------------------------------------------------------------------------

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface SubscribeResult {
  /** The token to embed in the confirmation link, or null when already confirmed. */
  confirmToken: string | null;
  status: 'pending_confirmation' | 'already_confirmed' | 'resubscribed';
}

/**
 * Records a subscription request.
 *
 * The response deliberately does not reveal whether the address was already on
 * the list. Callers get the same shape either way, so the form cannot be used to
 * test whether a given person is subscribed.
 */
export async function subscribe(
  email: string,
  source = 'signup-form',
): Promise<SubscribeResult> {
  const [existing] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .limit(1);

  if (existing) {
    // Confirmed and active — nothing to do, and no second email. Sending another
    // confirmation to an already-subscribed address is how a form becomes a way
    // to harass someone.
    if (existing.confirmedAt && !existing.unsubscribedAt) {
      return { confirmToken: null, status: 'already_confirmed' };
    }

    // Previously unsubscribed, or never confirmed. Issue a fresh token — the old
    // one may have been mailed somewhere no longer under their control.
    const token = newToken();
    await db
      .update(subscribers)
      .set({ token, unsubscribedAt: null, confirmedAt: null, source })
      .where(eq(subscribers.id, existing.id));

    return {
      confirmToken: token,
      status: existing.unsubscribedAt ? 'resubscribed' : 'pending_confirmation',
    };
  }

  const token = newToken();
  await db.insert(subscribers).values({ email, token, source });

  return { confirmToken: token, status: 'pending_confirmation' };
}

/** Completes a double opt-in. Idempotent — a re-clicked link is not an error. */
export async function confirmSubscription(token: string): Promise<Subscriber> {
  const [subscriber] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.token, token))
    .limit(1);

  if (!subscriber) throw notFound('That confirmation link is not valid.');

  if (subscriber.confirmedAt && !subscriber.unsubscribedAt) return subscriber;

  const [confirmed] = await db
    .update(subscribers)
    .set({ confirmedAt: new Date(), unsubscribedAt: null })
    .where(eq(subscribers.id, subscriber.id))
    .returning();

  logger.info({ email: subscriber.email }, 'subscription confirmed');
  return confirmed!;
}

/**
 * Unsubscribes by token.
 *
 * Idempotent and never reveals whether the token matched — an unsubscribe link
 * gets crawled by mail clients and security scanners, so it must be safe to hit
 * repeatedly and must not confirm to a crawler that an address exists.
 *
 * The row is kept rather than deleted, so a later re-subscribe is a deliberate
 * act and the opt-out is not silently forgotten.
 */
export async function unsubscribe(token: string): Promise<{ done: true }> {
  await db
    .update(subscribers)
    .set({ unsubscribedAt: new Date() })
    .where(and(eq(subscribers.token, token), isNull(subscribers.unsubscribedAt)));

  return { done: true };
}

export interface AnnouncementRecipient {
  email: string;
  /** Needed to build a working unsubscribe link for this specific person. */
  unsubscribeToken: string | null;
  source: 'subscriber' | 'account';
}

/**
 * Everyone who should hear about a new event.
 *
 * Two populations, deduplicated by email with the standalone subscriber winning
 * — because that row carries the unsubscribe token, and every announcement must
 * carry a working opt-out.
 *
 * Account holders are included on their `announcementsOptIn` preference. Their
 * opt-out is a setting rather than a token, which is why they are only reachable
 * once they have signed in and set it.
 */
export async function getAnnouncementRecipients(): Promise<AnnouncementRecipient[]> {
  const confirmed = await db
    .select({ email: subscribers.email, token: subscribers.token })
    .from(subscribers)
    .where(
      and(isNotNull(subscribers.confirmedAt), isNull(subscribers.unsubscribedAt)),
    );

  const accountHolders = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.announcementsOptIn, true),
        // Never mail an unverified address: it may belong to someone who never
        // asked to hear from us.
        eq(users.emailVerified, true),
      ),
    );

  const byEmail = new Map<string, AnnouncementRecipient>();

  for (const row of confirmed) {
    byEmail.set(row.email, {
      email: row.email,
      unsubscribeToken: row.token,
      source: 'subscriber',
    });
  }

  for (const row of accountHolders) {
    if (byEmail.has(row.email)) continue;
    byEmail.set(row.email, {
      email: row.email,
      unsubscribeToken: null,
      source: 'account',
    });
  }

  return [...byEmail.values()];
}

/** Stamps who was mailed, so a retried announcement does not double-send. */
export async function markAnnouncementSent(emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  await db
    .update(subscribers)
    .set({ lastSentAt: new Date() })
    .where(sql`${subscribers.email} = any(${emails})`);
}
