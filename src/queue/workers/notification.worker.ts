import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { events } from '../../db/schema.js';
import { sendEmail } from '../../lib/email.js';
import { AppError } from '../../lib/errors.js';
import { formatMoney } from '../../lib/money.js';
import { logger } from '../../lib/logger.js';
import { createQueueClient } from '../../lib/redis.js';
import { getOrderByReference, getOrderById } from '../../services/orders.service.js';
import type { OrderView } from '../../services/orders.service.js';
import { QUEUE, type NotificationJob } from '../queues.js';

// ---------------------------------------------------------------------------
// Delivery of receipts and tickets, over Brevo transactional email.
//
// Email is the only channel, and it is now mandatory at checkout, so every
// order has an address by construction. SMS would still be the better fit for a
// Kenyan audience — a buyer paying by M-Pesa on a feature phone may not check
// email — but a sender ID needs approval lead time. `deliver()` is the single
// swap point when that arrives.
// ---------------------------------------------------------------------------

interface Delivery {
  to: { email: string; phone: string };
  subject: string;
  body: string;
}

async function deliver(delivery: Delivery): Promise<{ sent: boolean }> {
  const result = await sendEmail({
    to: delivery.to.email,
    subject: delivery.subject,
    text: delivery.body,
  });

  return { sent: result.sent };
}

/** Human-readable event date in East Africa Time. */
function formatEventDate(date: Date): string {
  return new Intl.DateTimeFormat('en-KE', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Africa/Nairobi',
  }).format(date);
}

/**
 * The link to the order, on its own line and labelled.
 *
 * On its own line because mail clients wrap and then mangle a URL that shares a
 * line with prose, and a half-linked ticket URL is a support ticket. Labelled
 * because "click here" is what every phishing mail says and a named destination
 * is what a careful reader is looking for.
 */
function orderLink(order: OrderView): string {
  if (!env.PUBLIC_ORDER_BASE_URL) return '';
  const base = env.PUBLIC_ORDER_BASE_URL.replace(/\/+$/, '');
  return `\n\nYour order and tickets:\n${base}/orders/${order.reference}`;
}

// ---------------------------------------------------------------------------
// House style.
//
// Every message is a service email about money or admission, so it is written
// to be scanned in the two seconds before someone decides whether it is real:
// what happened, what it concerns, what to do, who sent it. A buyer who cannot
// answer the last one quickly assumes phishing, and with a ticket link in the
// body that assumption is the expensive one.
//
// Plain text throughout, and deliberately. It renders identically everywhere,
// survives every client, and — unlike a styled HTML shell — cannot look broken.
// A broken template is worse for trust than no template at all.
// ---------------------------------------------------------------------------

const BRAND = 'Eventify Tickets';
const SUPPORT_EMAIL = 'hello@invonicstechnologies.com';

/** Capitalises a name typed in lower case, so a greeting never looks careless. */
function properName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * The signature every message closes with.
 *
 * The support address is on every one of them. The alternative — a reply-to
 * nobody reads — is what turns a small problem into a chargeback, because a
 * buyer who cannot reach anybody goes to their bank instead.
 */
function signOff(extra?: string): string {
  return (
    `\n\n—\n${BRAND}\n` +
    `Questions about this order? Reply to this email or write to ${SUPPORT_EMAIL}.` +
    (extra ? `\n${extra}` : '')
  );
}

/** The event, as a labelled block rather than a sentence. */
function eventBlock(order: OrderView): string {
  const when = formatEventDate(order.event.startsAt);
  const where = order.event.venue ? `\n  Venue    ${order.event.venue}` : '';
  return `  Event    ${order.event.name}\n  When     ${when}${where}`;
}

/**
 * The "new event is on sale" email.
 *
 * Handled before the order-based branches because it is the one notification with
 * no order behind it — the recipient may never have bought anything.
 *
 * Carries an unsubscribe link whenever the recipient came from the subscriber
 * list. Account holders manage the preference in their settings instead, which is
 * why their link points there rather than at a token.
 */
async function buildAnnouncement(
  job: Extract<NotificationJob, { kind: 'event-announced' }>,
): Promise<Delivery | null> {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, job.eventId))
    .limit(1);

  // Pulled from sale between the fan-out and the send. Not an error — just
  // nothing worth announcing any more.
  if (!event || event.status !== 'published') {
    logger.info(
      { eventId: job.eventId, status: event?.status },
      'skipping announcement — event is no longer published',
    );
    return null;
  }

  const base = env.PUBLIC_ORDER_BASE_URL?.replace(/\/+$/, '') ?? '';
  const eventLink = base ? `\n\nGet tickets: ${base}/events/${event.slug}` : '';

  const optOut = job.unsubscribeToken
    ? `\n\n—\nNo longer want these? Unsubscribe: ${base}/api/subscribe/unsubscribe/${job.unsubscribeToken}`
    : `\n\n—\nManage your email preferences in your account settings.`;

  const when = new Intl.DateTimeFormat('en-KE', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: event.timezone,
  }).format(event.startsAt);

  return {
    to: { email: job.email, phone: '' },
    subject: `On sale now: ${event.name}`,
    body:
      `${event.name} is on sale.\n\n` +
      `  When     ${when}` +
      (event.venue ? `\n  Venue    ${event.venue}` : '') +
      eventLink +
      `\n\nTickets are first come, first served, and popular events do sell out.` +
      signOff() +
      optOut,
  };
}

async function build(job: NotificationJob): Promise<Delivery | null> {
  if (job.kind === 'event-announced') return buildAnnouncement(job);

  const order = await getOrderById(job.orderId);

  const to = { email: order.buyer.email, phone: order.buyer.phone };
  const total = formatMoney(order.totalCents, order.currency);

  switch (job.kind) {
    case 'tickets-issued': {
      const one = order.tickets.length === 1;
      const lines = order.tickets
        .map((ticket) => `  ${ticket.tierName.padEnd(16)} ${ticket.code}`)
        .join('\n');
      return {
        to,
        // The event name in the subject, not the reference. It is what someone
        // searches for months later, and what tells them the mail is theirs.
        subject: `Your ${one ? 'ticket' : 'tickets'} for ${order.event.name}`,
        body:
          `Hi ${properName(order.buyer.name)},\n\n` +
          `You're going. Here ${one ? 'is your ticket' : 'are your tickets'}.\n\n` +
          `${eventBlock(order)}\n\n` +
          `  ${one ? 'Ticket' : 'Tickets'}\n${lines}\n\n` +
          `  Order    ${order.reference}\n  Paid     ${total}\n\n` +
          `At the door\n` +
          `Open the link below and show the QR code. Each code admits one\n` +
          `person once, so everyone coming with you needs their own. The page\n` +
          `works without signal once you have opened it — worth doing before\n` +
          `you set off rather than in the queue.` +
          orderLink(order) +
          signOff(),
      };
    }

    case 'order-paid':
      return {
        to,
        subject: `Payment received for ${order.event.name}`,
        body:
          `Hi ${properName(order.buyer.name)},\n\n` +
          `Your payment went through. Thank you.\n\n` +
          `${eventBlock(order)}\n\n` +
          `  Order    ${order.reference}\n  Paid     ${total}\n\n` +
          `Your ${order.tickets.length === 1 ? 'ticket is' : 'tickets are'} being\n` +
          `issued now and will arrive in a separate email within a minute or two.\n` +
          `You do not need to do anything.` +
          orderLink(order) +
          signOff(),
      };

    case 'order-failed':
      return {
        to,
        subject: `Your order for ${order.event.name} was not completed`,
        body:
          `Hi ${properName(order.buyer.name)},\n\n` +
          // The reassurance goes first. Someone reading "payment not completed"
          // wants to know whether they have been charged before anything else,
          // and burying it under a reason code is how a support ticket starts.
          `No money has been taken, and your card or M-Pesa balance is\n` +
          `untouched. The order below did not go through.\n\n` +
          `${eventBlock(order)}\n\n` +
          `  Order    ${order.reference}\n  Amount   ${total}\n  Reason   ${job.reason}\n\n` +
          `What to do\n` +
          `The tickets have gone back on sale, so you can order again from the\n` +
          `event page. If money did leave your account, send us the M-Pesa\n` +
          `message and the order number above and we will sort it out.` +
          orderLink(order) +
          signOff(),
      };

    default:
      return null;
  }
}

export function createNotificationWorker(): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    QUEUE.NOTIFICATION,
    async (job: Job<NotificationJob>) => {
      let delivery: Delivery | null;

      try {
        delivery = await build(job.data);
      } catch (error) {
        // A job whose subject no longer exists will never succeed, so retrying it
        // four more times only fills the log with the same failure. This happens
        // for real when a queue outlives the database it refers to — a restored
        // snapshot, or a development database recreated under a warm Redis.
        if (error instanceof AppError && error.statusCode === 404) {
          logger.warn(
            { job: job.data, reason: error.message },
            'dropping notification for a subject that no longer exists',
          );
          return { sent: false, dropped: true };
        }
        throw error;
      }

      if (!delivery) return { sent: false };

      return deliver(delivery);
    },
    {
      connection: createQueueClient(),
      prefix: `${env.REDIS_PREFIX}:bull`,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
}

export { deliver, getOrderByReference };
