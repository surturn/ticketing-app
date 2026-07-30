import { Worker, type Job } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { events } from '../../db/schema.js';
import { cacheKeys, cacheDelete } from '../../lib/cache.js';
import { logger } from '../../lib/logger.js';
import { createQueueClient } from '../../lib/redis.js';
import { archivePastEvents } from '../../services/events.service.js';
import { recordStandaloneTransition } from '../../services/ledger.service.js';
import { getAnnouncementRecipients } from '../../services/subscribers.service.js';
import {
  enqueueNotification,
  JOB,
  QUEUE,
  type AnnounceEventJob,
  type ArchivePastEventsJob,
} from '../queues.js';

// ---------------------------------------------------------------------------
// Housekeeping.
//
// Retires events that finished more than EVENT_ARCHIVE_AFTER_DAYS ago. Archiving
// moves an event out of the current listing and into past events — it deletes
// nothing. Orders, tickets and payments stay exactly where they are, so a buyer
// who kept a link still sees their ticket, and the financial record survives for
// reconciliation.
//
// Deliberately never deletes. An automatic job that removed rows would eventually
// destroy M-Pesa payment records without anyone having asked it to.
// ---------------------------------------------------------------------------

async function archive(afterDays: number): Promise<number> {
  const archived = await archivePastEvents(afterDays);

  if (archived.length === 0) return 0;

  // One entry per event, so the reason an event left the listing is recoverable.
  for (const event of archived) {
    await recordStandaloneTransition({
      entity: 'event',
      entityId: event.id,
      event: 'event.archived',
      fromState: 'listed',
      toState: 'archived',
      actor: 'system:maintenance',
      eventId: event.id,
      detail: { slug: event.slug, afterDays, automatic: true },
    });
  }

  // Both listings change when an event moves between them.
  await cacheDelete(cacheKeys.publicEventList(), cacheKeys.pastEventList());
  for (const event of archived) {
    await cacheDelete(cacheKeys.eventBySlug(event.slug));
  }

  logger.info(
    { count: archived.length, slugs: archived.map((event) => event.slug), afterDays },
    'archived past events',
  );

  return archived.length;
}

/**
 * Fans an event announcement out into one notification job per recipient.
 *
 * `announced_at` is claimed with a conditional UPDATE before anything is queued.
 * That is what makes the whole send once-only: a retried or duplicated fan-out
 * job finds the claim taken and stops, so nobody is mailed twice about the same
 * event even if this job runs again.
 */
async function announce(eventId: string): Promise<number> {
  const claimed = await db
    .update(events)
    .set({ announcedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(events.id, eventId), isNull(events.announcedAt)))
    .returning({ id: events.id, name: events.name, slug: events.slug });

  const event = claimed[0];
  if (!event) {
    logger.info({ eventId }, 'event already announced — skipping');
    return 0;
  }

  const recipients = await getAnnouncementRecipients();

  for (const recipient of recipients) {
    await enqueueNotification({
      kind: 'event-announced',
      eventId,
      email: recipient.email,
      unsubscribeToken: recipient.unsubscribeToken,
    });
  }

  logger.info(
    { eventId, slug: event.slug, recipients: recipients.length },
    'queued event announcement',
  );

  return recipients.length;
}

export function createMaintenanceWorker(): Worker<
  ArchivePastEventsJob | AnnounceEventJob
> {
  return new Worker<ArchivePastEventsJob | AnnounceEventJob>(
    QUEUE.MAINTENANCE,
    async (job: Job<ArchivePastEventsJob | AnnounceEventJob>) => {
      if (job.name === JOB.ANNOUNCE_EVENT) {
        return announce((job.data as AnnounceEventJob).eventId);
      }
      if (job.name !== JOB.ARCHIVE_PAST_EVENTS) return null;
      return archive(
        (job.data as ArchivePastEventsJob).afterDays ?? env.EVENT_ARCHIVE_AFTER_DAYS,
      );
    },
    {
      connection: createQueueClient(),
      prefix: `${env.REDIS_PREFIX}:bull`,
      // One at a time: the sweep is a single bulk UPDATE, and running two
      // concurrently would only contend for the same rows.
      concurrency: 1,
    },
  );
}

export { archive as archivePastEventsNow };
