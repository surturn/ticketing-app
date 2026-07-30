import { Worker, type Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createQueueClient } from '../../lib/redis.js';
import { getOrderByReference, getOrderById } from '../../services/orders.service.js';
import { QUEUE, type NotificationJob } from '../queues.js';

// ---------------------------------------------------------------------------
// Delivery of receipts and tickets.
//
// NOT IMPLEMENTED: no email or SMS provider is wired up yet, because none was
// chosen. Everything below resolves the order and logs exactly what would be
// sent, so the queue plumbing is proven end to end and adding a provider is a
// single function swap in `deliver()` — SMTP (nodemailer), Resend, or
// Africa's Talking for SMS.
// ---------------------------------------------------------------------------

interface Delivery {
  to: { email: string | null; phone: string };
  subject: string;
  body: string;
}

async function deliver(delivery: Delivery): Promise<void> {
  logger.info(
    { to: delivery.to, subject: delivery.subject },
    'notification (no provider configured — not actually sent)',
  );
}

async function build(job: NotificationJob): Promise<Delivery | null> {
  const order = await getOrderById(job.orderId);

  const to = { email: order.buyer.email, phone: order.buyer.phone };

  switch (job.kind) {
    case 'tickets-issued': {
      const lines = order.tickets
        .map((ticket) => `  ${ticket.tierName} — ${ticket.code}`)
        .join('\n');
      return {
        to,
        subject: `Your tickets for ${order.event.name}`,
        body:
          `Order ${order.reference} is confirmed.\n\n${lines}\n\n` +
          `Show the QR code at the gate.`,
      };
    }

    case 'order-paid':
      return {
        to,
        subject: `Payment received — ${order.reference}`,
        body: `We've received your payment for ${order.event.name}. Your tickets are on the way.`,
      };

    case 'order-failed':
      return {
        to,
        subject: `Payment not completed — ${order.reference}`,
        body:
          `Your order for ${order.event.name} was not completed.\n\n` +
          `Reason: ${job.reason}\n\nNo money has been taken. You can try again.`,
      };

    default:
      return null;
  }
}

export function createNotificationWorker(): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    QUEUE.NOTIFICATION,
    async (job: Job<NotificationJob>) => {
      const delivery = await build(job.data);
      if (!delivery) return { sent: false };

      await deliver(delivery);
      return { sent: true };
    },
    {
      connection: createQueueClient(),
      prefix: `${env.REDIS_PREFIX}:bull`,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
}

// Re-exported so a future provider integration has an obvious entry point.
export { deliver, getOrderByReference };
