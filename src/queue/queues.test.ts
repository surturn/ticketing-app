import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelOrderExpiry,
  enqueueNotification,
  enqueueTicketIssuance,
  closeQueues,
  notificationQueue,
  orderExpiryQueue,
  paymentReconcileQueue,
  scheduleOrderExpiry,
  scheduleReconcile,
  ticketIssuanceQueue,
} from './queues.js';

// ---------------------------------------------------------------------------
// Regression coverage for the producers.
//
// These exist because every one of them was broken and nothing caught it: the
// job ids used `:`, which BullMQ reserves as its own Redis key separator, so
// `queue.add` threw `Custom Ids cannot contain :` on every call. Nothing in the
// suite ever enqueued a job, and the one manual test path short-circuited on
// `gateway_not_configured` before reaching a queue — so a total outage of
// checkout, ticket issuance and email looked green.
//
// The lesson these encode: a producer is only proven by handing a job to a real
// broker. Asserting the id string here would have missed nothing *and* caught
// nothing, because the constraint lives in BullMQ, not in our code.
//
// Needs Redis: docker compose up -d redis
// Run with: RUN_DB_TESTS=true npm test
// ---------------------------------------------------------------------------

const enabled = process.env.RUN_DB_TESTS === 'true';

const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('queue producers', () => {
  beforeEach(async () => {
    await Promise.all([
      orderExpiryQueue.drain(true),
      paymentReconcileQueue.drain(true),
      ticketIssuanceQueue.drain(true),
      notificationQueue.drain(true),
    ]);
  });

  afterAll(async () => {
    await closeQueues();
  });

  it('schedules an order expiry with a delay', async () => {
    const orderId = uuid();
    await expect(
      scheduleOrderExpiry(orderId, new Date(Date.now() + 600_000)),
    ).resolves.toBeUndefined();

    const job = await orderExpiryQueue.getJob(`expire-${orderId}`);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ orderId });
    // Delayed to roughly the hold expiry, not run immediately.
    expect(job!.opts.delay).toBeGreaterThan(590_000);
  });

  it('treats a repeated expiry schedule as a no-op rather than a second release', async () => {
    const orderId = uuid();
    const expiresAt = new Date(Date.now() + 600_000);

    await scheduleOrderExpiry(orderId, expiresAt);
    await scheduleOrderExpiry(orderId, expiresAt);

    const counts = await orderExpiryQueue.getJobCounts('delayed');
    expect(counts.delayed).toBe(1);
  });

  it('cancels a scheduled expiry', async () => {
    const orderId = uuid();
    await scheduleOrderExpiry(orderId, new Date(Date.now() + 600_000));
    await cancelOrderExpiry(orderId);

    expect(await orderExpiryQueue.getJob(`expire-${orderId}`)).toBeUndefined();
  });

  it('schedules a reconcile per attempt, with increasing backoff', async () => {
    const paymentId = uuid();

    await expect(scheduleReconcile(paymentId, 1)).resolves.toBeUndefined();
    await expect(scheduleReconcile(paymentId, 2)).resolves.toBeUndefined();

    const first = await paymentReconcileQueue.getJob(`reconcile-${paymentId}-1`);
    const second = await paymentReconcileQueue.getJob(`reconcile-${paymentId}-2`);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Attempts are distinct jobs — a later attempt must not dedupe against an
    // earlier one, or the reconciler would only ever poll Daraja once.
    expect(second!.opts.delay).toBeGreaterThan(first!.opts.delay!);
  });

  it('enqueues ticket issuance, deduped per order', async () => {
    const orderId = uuid();

    await expect(enqueueTicketIssuance(orderId)).resolves.toBeUndefined();
    await enqueueTicketIssuance(orderId);

    const job = await ticketIssuanceQueue.getJob(`issue-${orderId}`);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ orderId });
    expect((await ticketIssuanceQueue.getJobCounts('waiting')).waiting).toBe(1);
  });

  it('enqueues each notification kind separately for one order', async () => {
    const orderId = uuid();

    await expect(
      enqueueNotification({ kind: 'order-paid', orderId }),
    ).resolves.toBeUndefined();
    await expect(
      enqueueNotification({ kind: 'tickets-issued', orderId }),
    ).resolves.toBeUndefined();
    await expect(
      enqueueNotification({ kind: 'order-failed', orderId, reason: 'declined' }),
    ).resolves.toBeUndefined();

    // Deduping on kind as well as order matters: a buyer should get the payment
    // receipt *and* the tickets, not whichever landed first.
    expect((await notificationQueue.getJobCounts('waiting')).waiting).toBe(3);

    const failed = await notificationQueue.getJob(`notify-order-failed-${orderId}`);
    expect(failed!.data).toMatchObject({ reason: 'declined' });
  });
});
