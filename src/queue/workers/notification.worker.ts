import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { events } from '../../db/schema.js';
import { sendEmail } from '../../lib/email.js';
import { renderEmail, type DetailRow, type EmailLayout } from '../../lib/email-template.js';
import { AppError } from '../../lib/errors.js';
import { formatMoney } from '../../lib/money.js';
import { logger } from '../../lib/logger.js';
import { qrDataUrl } from '../../lib/qr.js';
import { createQueueClient } from '../../lib/redis.js';
import { getOrderByReference, getOrderById } from '../../services/orders.service.js';
import { welcomeContent } from '../../services/users.service.js';
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
  /** The plain-text version. Always present, never a second-class citizen. */
  body: string;
  /** The structured version, rendered into the HTML shell. */
  layout?: EmailLayout;
}

async function deliver(delivery: Delivery): Promise<{ sent: boolean }> {
  const result = await sendEmail({
    to: delivery.to.email,
    subject: delivery.subject,
    text: delivery.body,
    // Both parts are sent. A client that prefers text gets the text, and the
    // text version is also one of the signals a spam filter weighs — an
    // HTML-only message scores worse than a properly paired one.
    ...(delivery.layout ? { html: renderEmail(delivery.layout) } : {}),
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
 * The event and order facts, as rows for the HTML detail block.
 *
 * Built from the same values the plain-text block uses, so the two versions of
 * a message can never disagree about what was paid or when the doors open.
 */
function detailRows(order: OrderView, total: string): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Event', value: order.event.name },
    { label: 'When', value: formatEventDate(order.event.startsAt) },
  ];
  if (order.event.venue) rows.push({ label: 'Venue', value: order.event.venue });
  rows.push({ label: 'Order', value: order.reference });
  rows.push({ label: 'Amount', value: total });
  return rows;
}

/** The absolute URL of an order, or undefined when no base URL is configured. */
function orderUrl(order: OrderView): string | undefined {
  if (!env.PUBLIC_ORDER_BASE_URL) return undefined;
  return `${env.PUBLIC_ORDER_BASE_URL.replace(/\/+$/, '')}/orders/${order.reference}`;
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
    layout: {
      heading: event.name,
      intro: ['This one just went on sale.'],
      details: [
        { label: 'When', value: when },
        ...(event.venue ? [{ label: 'Venue', value: event.venue }] : []),
      ],
      section: {
        title: 'Worth being quick',
        body: ['Tickets are first come, first served, and popular events do sell out.'],
      },
      ...(base ? { action: { label: 'Get tickets', url: `${base}/events/${event.slug}` } } : {}),
      footnote: job.unsubscribeToken
        ? `You are receiving this because you asked to hear about new events. Unsubscribe: ${base}/api/subscribe/unsubscribe/${job.unsubscribeToken}`
        : 'You are receiving this because you asked to hear about new events. Change that any time in your account settings.',
    },
  };
}

/**
 * The welcome, as a queued delivery.
 *
 * Reuses the same words the inline version sent — `welcomeContent` owns them —
 * so moving this onto the queue changed how it is delivered and not what it
 * says. There is no phone on an account, so the SMS field is empty; nothing in
 * this path reads it.
 */
function buildWelcome(job: Extract<NotificationJob, { kind: 'account-welcome' }>): Delivery {
  const content = welcomeContent(job.displayName);
  return {
    to: { email: job.email, phone: '' },
    subject: content.subject,
    body: content.text,
    layout: content.layout,
  };
}

async function build(job: NotificationJob): Promise<Delivery | null> {
  if (job.kind === 'event-announced') return buildAnnouncement(job);

  // Handled before the order lookup: a welcome belongs to an account, not to a
  // purchase, and there is no order to fetch.
  if (job.kind === 'account-welcome') return buildWelcome(job);

  // Trusted: this is the system building the buyer's own ticket email, not an
  // external viewer reading a forwarded link, so the redaction in
  // `orders.service.ts` that protects against exactly that does not apply.
  const order = await getOrderById(job.orderId, { uid: null, trusted: true });

  const to = { email: order.buyer.email, phone: order.buyer.phone };
  const total = formatMoney(order.totalCents, order.currency);

  switch (job.kind) {
    case 'tickets-issued': {
      const one = order.tickets.length === 1;
      const lines = order.tickets
        .map((ticket) => `  ${ticket.tierName.padEnd(16)} ${ticket.code}`)
        .join('\n');

      // Every ticket gets a scannable QR in the email itself — the gate needs
      // it and a guest checkout, which is the default, never signs in to see
      // the one on the order page. `ticket.qr` is populated because `order`
      // was fetched with `trusted: true` above.
      const ticketQrs = await Promise.all(
        order.tickets.map(async (ticket) => ({
          label: ticket.tierName,
          code: ticket.code!,
          dataUrl: await qrDataUrl(ticket.qr!),
        })),
      );

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
          `Show the QR code${one ? '' : 's'} below on your phone. Each one admits one\n` +
          `person once, so everyone coming with you needs their own. No signal\n` +
          `needed — it is already in this email.` +
          orderLink(order) +
          signOff(),
        layout: {
          heading: one ? 'Your ticket is ready' : 'Your tickets are ready',
          intro: [
            `Hi ${properName(order.buyer.name)},`,
            `You're going. ${one ? 'Your ticket is' : 'Your tickets are'} below.`,
          ],
          details: detailRows(order, total),
          tickets: ticketQrs,
          section: {
            title: 'At the door',
            body: [
              `Show the QR code${one ? '' : 's'} above on your phone. Each one admits one person once, so everyone coming with you needs their own.`,
              'No signal needed at the gate — the code is already in this email. Your order page has the same tickets if you ever need them again.',
            ],
          },
          ...(orderUrl(order)
            ? { action: { label: one ? 'View my ticket' : 'View my tickets', url: orderUrl(order)! } }
            : {}),
        },
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
        layout: {
          heading: 'Payment received',
          intro: [
            `Hi ${properName(order.buyer.name)},`,
            'Your payment went through. Thank you.',
          ],
          details: detailRows(order, total),
          section: {
            title: 'What happens next',
            body: [
              `Your ${order.tickets.length === 1 ? 'ticket is' : 'tickets are'} being issued now and will arrive in a separate email within a minute or two. You do not need to do anything.`,
            ],
          },
          ...(orderUrl(order)
            ? { action: { label: 'View my order', url: orderUrl(order)! } }
            : {}),
        },
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
        layout: {
          heading: 'Your order was not completed',
          intro: [
            `Hi ${properName(order.buyer.name)},`,
            'No money has been taken, and your M-Pesa balance is untouched. The order below did not go through.',
          ],
          details: [...detailRows(order, total), { label: 'Reason', value: job.reason }],
          section: {
            title: 'What to do',
            body: [
              'The tickets have gone back on sale, so you can order again from the event page.',
              'If money did leave your account, send us the M-Pesa message and the order number above and we will sort it out.',
            ],
          },
          ...(orderUrl(order)
            ? { action: { label: 'Try again', url: orderUrl(order)! } }
            : {}),
        },
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
