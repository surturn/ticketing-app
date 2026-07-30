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

function orderLink(order: OrderView): string {
  if (!env.PUBLIC_ORDER_BASE_URL) return '';
  const base = env.PUBLIC_ORDER_BASE_URL.replace(/\/+$/, '');
  return `\n\nView your order: ${base}/orders/${order.reference}`;
}

function eventBlock(order: OrderView): string {
  const when = formatEventDate(order.event.startsAt);
  const where = order.event.venue ? `\nVenue: ${order.event.venue}` : '';
  return `${order.event.name}\nWhen: ${when}${where}`;
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
    subject: `Tickets are live: ${event.name}`,
    body:
      `${event.name} just went on sale.\n\n` +
      `When: ${when}` +
      (event.venue ? `\nVenue: ${event.venue}` : '') +
      eventLink +
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
      const lines = order.tickets
        .map((ticket) => `  ${ticket.tierName} — ${ticket.code}`)
        .join('\n');
      return {
        to,
        subject: `Your tickets for ${order.event.name}`,
        body:
          `Hi ${order.buyer.name},\n\n` +
          `Order ${order.reference} is confirmed. ${total} paid.\n\n` +
          `${eventBlock(order)}\n\n` +
          `Your ticket${order.tickets.length === 1 ? '' : 's'}:\n${lines}\n\n` +
          `Show the QR code at the gate. Each code admits one person once.` +
          orderLink(order),
      };
    }

    case 'order-paid':
      return {
        to,
        subject: `Payment received — ${order.reference}`,
        body:
          `Hi ${order.buyer.name},\n\n` +
          `We've received your ${total} payment for ${order.event.name}.\n` +
          `Your tickets are being issued and will arrive in a moment.` +
          orderLink(order),
      };

    case 'order-failed':
      return {
        to,
        subject: `Payment not completed — ${order.reference}`,
        body:
          `Hi ${order.buyer.name},\n\n` +
          `Your order for ${order.event.name} was not completed.\n\n` +
          `Reason: ${job.reason}\n\n` +
          `No money has been taken. You can try again.`,
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
