import rateLimit from '@fastify/rate-limit';
import { cacheRedis } from '../lib/redis.js';
import { LIMITS } from '../config/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTransaction } from '../db/client.js';
import {
  events,
  orders,
  payments,
  ticketTiers,
  tickets,
} from '../db/schema.js';
import { invalidateEvent } from '../lib/cache.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  MAX_UPLOAD_BYTES,
  readLimited,
  sniffImageType,
  storePoster,
} from '../lib/storage.js';
import { logger } from '../lib/logger.js';
import { boundedMultilineText, boundedText } from '../lib/validation.js';
import { env } from '../config/env.js';
import { mintScannerToken, requireAdmin } from '../plugins/auth.js';
import { enqueueEventAnnouncement } from '../queue/queues.js';
import { archivePastEvents } from '../services/events.service.js';
import {
  getOrderHistory,
  getRecentEntries,
  recordTransition,
  verifyChain,
} from '../services/ledger.service.js';
import { voidTicket } from '../services/tickets.service.js';

// ---------------------------------------------------------------------------
// Organiser-facing endpoints. Everything under /api/admin requires the API key.
// ---------------------------------------------------------------------------

// The field shapes and the cross-field rules are kept apart because `.refine()`
// yields a ZodEffects, which has no `.partial()` — and PATCH needs a partial.
// Each rule is written to hold for a partial too: it passes when the fields it
// compares are absent, and only bites when both are supplied.
const eventFields = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens only'),
    name: boundedText(1, 200),
    description: boundedMultilineText(1, 5_000).optional(),
    venue: boundedText(1, 200).optional(),
    /**
     * The poster, as a URL.
     *
     * Restricted to https. The storefront embeds this straight into an <img>,
     * and an http source on an https page is blocked as mixed content — the
     * poster would simply not appear, with nothing to explain why. Rejecting it
     * here turns a silent blank card into an error the organiser can act on
     * while they are still looking at the form.
     */
    posterUrl: z
      .string()
      .url('Must be a full URL, including https://')
      .max(2_000)
      .refine(
        (value) => value.startsWith('https://'),
        'Must be an https:// URL — browsers block insecure images on a secure page',
      )
      .optional(),
    // Validated against the runtime's own tz database rather than a length
    // bound: an unknown zone would otherwise only surface much later, when
    // Intl.DateTimeFormat threw while formatting a ticket email.
    timezone: z
      .string()
      .max(60)
      .default('Africa/Nairobi')
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, 'must be a valid IANA time zone, e.g. Africa/Nairobi'),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO code')
      .default('KES'),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().optional(),
    status: z.enum(['draft', 'published', 'closed', 'cancelled']).default('draft'),
  })
  .strict();

const eventDatesOrdered = (body: { startsAt?: Date; endsAt?: Date }) =>
  !body.endsAt || !body.startsAt || body.endsAt > body.startsAt;

const eventBody = eventFields.refine(eventDatesOrdered, {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
});

const eventPatchBody = eventFields.partial().refine(eventDatesOrdered, {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
});

const tierFields = z
  .object({
    name: boundedText(1, 120),
    description: boundedMultilineText(1, 2_000).optional(),
    // Bounded above as well as below: a price typo of an extra three zeros is
    // far more likely than a genuine ten-million-shilling ticket, and the
    // multiplication reaching totalCents must stay inside a safe integer.
    priceCents: z.number().int().min(0).max(1_000_000_00),
    // Omit or send null to sell without a capacity limit — for an event whose
    // venue is chosen once the organiser sees how much sold. `null` is accepted
    // explicitly so a PATCH can clear a cap that was set earlier; omitting the
    // key on a PATCH leaves it unchanged.
    quantityTotal: z.number().int().min(1).max(10_000_000).nullish(),
    minPerOrder: z.number().int().min(1).max(100).default(1),
    maxPerOrder: z.number().int().min(1).max(100).default(10),
    salesStartAt: z.coerce.date().optional(),
    salesEndAt: z.coerce.date().optional(),
    status: z.enum(['active', 'paused', 'hidden', 'closed']).default('active'),
    sortOrder: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict();

const tierOrderBoundsValid = (body: { minPerOrder?: number; maxPerOrder?: number }) =>
  body.maxPerOrder === undefined ||
  body.minPerOrder === undefined ||
  body.maxPerOrder >= body.minPerOrder;

const tierSalesWindowValid = (body: { salesStartAt?: Date; salesEndAt?: Date }) =>
  !body.salesEndAt || !body.salesStartAt || body.salesEndAt > body.salesStartAt;

const tierBody = tierFields
  .refine(tierOrderBoundsValid, {
    message: 'maxPerOrder must be at least minPerOrder',
    path: ['maxPerOrder'],
  })
  .refine(tierSalesWindowValid, {
    message: 'salesEndAt must be after salesStartAt',
    path: ['salesEndAt'],
  });

const tierPatchBody = tierFields
  .partial()
  .refine(tierOrderBoundsValid, {
    message: 'maxPerOrder must be at least minPerOrder',
    path: ['maxPerOrder'],
  })
  .refine(tierSalesWindowValid, {
    message: 'salesEndAt must be after salesStartAt',
    path: ['salesEndAt'],
  });

const idParams = z.object({ id: z.string().uuid() }).strict();

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  /**
   * A scope-wide limit, so every admin route has one without being told.
   *
   * Registering the limiter inside this encapsulated plugin makes its settings
   * the default for the routes declared here, which is what closes the gap:
   * previously only the two routes that named a limit had one, and the other
   * twenty inherited the global 240 a minute. A route added tomorrow is covered
   * by construction rather than by whoever writes it remembering.
   *
   * The API key is still the real control. This is what stops a leaked key from
   * rewriting the catalogue at machine speed before anyone notices.
   */
  await app.register(rateLimit, {
    max: LIMITS.adminWrite.max,
    timeWindow: LIMITS.adminWrite.timeWindow,
    redis: cacheRedis,
    nameSpace: 'ratelimit:admin:',
    skipOnError: true,
    keyGenerator: (request) => {
      const cf = request.headers['cf-connecting-ip'];
      return (typeof cf === 'string' && cf) || request.ip;
    },
  });

  // ─── Poster uploads ─────────────────────────────────────────────────────

  /**
   * Accepts an image from the organiser's device and returns its URL.
   *
   * Admin-only, like everything else in this scope. That matters more here than
   * elsewhere: an open image upload is a free file host, and a free file host
   * attached to a real domain is used within days for things nobody wants their
   * domain associated with.
   *
   * Returns a URL rather than attaching it to an event. Upload and save stay
   * separate so an organiser can change their mind about the artwork without
   * having created an event first, and so a failed save does not lose the file
   * they just waited to upload.
   */
  app.post(
    '/api/admin/uploads/poster',
    {
      config: {
        // Uploads are expensive in bandwidth and storage in a way JSON is not.
        rateLimit: LIMITS.upload,
      },
    },
    async (request, reply) => {
      const file = await request.file({
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      });

      if (!file) throw badRequest('No image was uploaded.');

      const body = await readLimited(file.file);

      // Fastify sets this when its own limit trips mid-stream. Checked because
      // the truncated buffer would otherwise be stored as a valid, broken image.
      if (file.file.truncated) {
        throw badRequest('That image is larger than 2MB. Please use a smaller file.');
      }

      /**
       * The bytes decide the type, not the filename or the browser's header.
       * Both of those are supplied by the client, and a file claiming to be a
       * PNG while actually being an HTML document is the whole attack.
       */
      const contentType = sniffImageType(body);
      if (!contentType) {
        throw badRequest(
          'That file is not a PNG, JPEG or WebP image. Please upload one of those.',
        );
      }

      const stored = await storePoster(body, contentType);

      request.log.info(
        { key: stored.key, bytes: stored.bytes, contentType },
        'poster uploaded',
      );

      return reply.status(201).send({ poster: stored });
    },
  );

  // ─── Events ─────────────────────────────────────────────────────────────

  app.get('/api/admin/events', async () => ({
    events: await db.select().from(events).orderBy(desc(events.startsAt)),
  }));

  app.post('/api/admin/events', async (request, reply) => {
    const body = eventBody.parse(request.body);
    const [created] = await db.insert(events).values(body).returning();
    await invalidateEvent(created!.id, created!.slug);

    // Created already published — announce it.
    if (created!.status === 'published') {
      await enqueueEventAnnouncement(created!.id);
    }

    return reply.status(201).send({ event: created });
  });

  app.patch('/api/admin/events/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = eventPatchBody.parse(request.body);

    const [before] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!before) throw notFound(`No event with id ${id}`);

    const [updated] = await db
      .update(events)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();

    await invalidateEvent(updated!.id, updated!.slug);

    // Announce on the transition *into* published, not on every save of an
    // already-published event. The worker also claims `announced_at` before
    // sending, so correcting a typo on a live event cannot re-mail the list.
    if (before.status !== 'published' && updated!.status === 'published') {
      await enqueueEventAnnouncement(id);
    }

    return { event: updated };
  });

  // ─── Retiring an event ──────────────────────────────────────────────────
  //
  // Two different operations, and the difference matters:
  //
  //   archive — moves the event out of the current listing and into past events.
  //             Nothing is destroyed; orders, tickets and payments stay readable,
  //             so a buyer with a saved link still sees their ticket. Reversible.
  //             This is also what the hourly sweep does automatically.
  //
  //   delete  — removes the row. Permitted only for an event that has finished
  //             and never sold anything, which in practice means a test or a
  //             mistake. An event with orders cannot be deleted: those rows are
  //             the record of money that moved, and `orders.event_id` is
  //             ON DELETE restrict precisely so no code path can take them out.

  /** True once the event's end (or start, if open-ended) is in the past. */
  function hasFinished(event: { startsAt: Date; endsAt: Date | null }): boolean {
    return (event.endsAt ?? event.startsAt).getTime() < Date.now();
  }

  const reasonBody = z.object({ reason: boundedText(1, 300).optional() }).strict();

  app.post('/api/admin/events/:id/archive', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = reasonBody.parse(request.body ?? {});

    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw notFound(`No event with id ${id}`);

    if (!hasFinished(event)) {
      // Archiving a future event would remove it from the listing while it is
      // still selling — almost certainly not what was meant. Unpublish it or set
      // it to cancelled instead.
      throw conflict(
        'event_not_finished',
        `"${event.name}" has not happened yet. Change its status instead of archiving it.`,
        { details: { startsAt: event.startsAt, endsAt: event.endsAt } },
      );
    }

    if (event.archivedAt) {
      return { event, alreadyArchived: true };
    }

    const archived = await withTransaction(async (tx) => {
      const [row] = await tx
        .update(events)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(events.id, id))
        .returning();

      await recordTransition(tx, {
        entity: 'event',
        entityId: id,
        event: 'event.archived',
        fromState: 'listed',
        toState: 'archived',
        actor: 'admin',
        eventId: id,
        detail: { slug: event.slug, name: event.name, reason: body.reason ?? null },
      });

      return row!;
    });

    await invalidateEvent(id, event.slug);
    return { event: archived, alreadyArchived: false };
  });

  app.post('/api/admin/events/:id/unarchive', async (request) => {
    const { id } = idParams.parse(request.params);

    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw notFound(`No event with id ${id}`);

    const restored = await withTransaction(async (tx) => {
      const [row] = await tx
        .update(events)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(events.id, id))
        .returning();

      await recordTransition(tx, {
        entity: 'event',
        entityId: id,
        event: 'event.unarchived',
        fromState: 'archived',
        toState: 'listed',
        actor: 'admin',
        eventId: id,
        detail: { slug: event.slug, name: event.name },
      });

      return row!;
    });

    await invalidateEvent(id, event.slug);

    // A finished event reappears under past events, not the current listing —
    // worth saying so the caller is not left wondering where it went.
    return {
      event: restored,
      listedUnder: hasFinished(restored) ? 'past events' : 'current events',
    };
  });

  app.delete('/api/admin/events/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = reasonBody.parse(request.body ?? {});

    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw notFound(`No event with id ${id}`);

    if (!hasFinished(event)) {
      throw conflict(
        'event_not_finished',
        `"${event.name}" has not happened yet and cannot be deleted.`,
        { details: { startsAt: event.startsAt, endsAt: event.endsAt } },
      );
    }

    // Counted rather than trusted to the foreign key: a raw FK violation would
    // surface as an opaque 500, and the reply should say what is in the way.
    const [counts] = await db
      .select({
        orders: count(orders.id),
        paidOrders: sql<number>`count(*) filter (where ${orders.status} in ('paid', 'refunded'))`,
      })
      .from(orders)
      .where(eq(orders.eventId, id));

    const [ticketCount] = await db
      .select({ total: count(tickets.id) })
      .from(tickets)
      .where(eq(tickets.eventId, id));

    const orderCount = Number(counts?.orders ?? 0);
    const issued = Number(ticketCount?.total ?? 0);

    if (orderCount > 0 || issued > 0) {
      throw conflict(
        'event_has_records',
        `"${event.name}" has ${orderCount} order(s) and ${issued} ticket(s), which are the record of money that moved. Archive it instead — it will be listed under past events and nothing is lost.`,
        {
          details: {
            orders: orderCount,
            paidOrders: Number(counts?.paidOrders ?? 0),
            tickets: issued,
            archiveInstead: `POST /api/admin/events/${id}/archive`,
          },
        },
      );
    }

    await withTransaction(async (tx) => {
      // Recorded before the row goes. The ledger holds no foreign key to
      // `events`, so this entry outlives the event and is the only trace a
      // deletion leaves.
      await recordTransition(tx, {
        entity: 'event',
        entityId: id,
        event: 'event.deleted',
        fromState: event.archivedAt ? 'archived' : 'listed',
        toState: 'deleted',
        actor: 'admin',
        eventId: id,
        detail: {
          slug: event.slug,
          name: event.name,
          startsAt: event.startsAt.toISOString(),
          reason: body.reason ?? null,
          // Stated explicitly so the entry proves nothing was destroyed.
          ordersAtDeletion: 0,
          ticketsAtDeletion: 0,
        },
      });

      // Tiers are ON DELETE cascade, so they go with it.
      await tx.delete(events).where(eq(events.id, id));
    });

    await invalidateEvent(id, event.slug);
    logger.info({ eventId: id, slug: event.slug }, 'event deleted');

    return { deleted: true, id, slug: event.slug, name: event.name };
  });

  // ─── Tiers ──────────────────────────────────────────────────────────────

  app.get('/api/admin/events/:id/tiers', async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      tiers: await db
        .select()
        .from(ticketTiers)
        .where(eq(ticketTiers.eventId, id))
        .orderBy(ticketTiers.sortOrder),
    };
  });

  app.post('/api/admin/events/:id/tiers', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = tierBody.parse(request.body);

    const [created] = await db
      .insert(ticketTiers)
      .values({ ...body, eventId: id })
      .returning();

    await invalidateEvent(id);
    return reply.status(201).send({ tier: created });
  });

  app.patch('/api/admin/tiers/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    // quantityTotal is the only inventory field an organiser may set directly.
    // reserved/sold are owned by the checkout and settlement paths.
    const body = tierPatchBody.parse(request.body);

    const [updated] = await db
      .update(ticketTiers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(ticketTiers.id, id))
      .returning();

    if (!updated) throw notFound(`No tier with id ${id}`);
    await invalidateEvent(updated.eventId);
    return { tier: updated };
  });

  // ─── Closing a sale ─────────────────────────────────────────────────────
  //
  // Explicit endpoints rather than expecting the organiser to PATCH a status
  // string. This is the action an uncapped tier is built around — the organiser
  // watches what sold, books a venue that can host it, and closes the sale at
  // that figure — so it deserves a name, and it is recorded in the ledger,
  // because "why did sales stop at 412?" is a question that gets asked later.
  //
  // Tickets already sold are untouched. Closing stops new reservations; it does
  // not cancel anything.

  async function setTierSalesClosed(tierId: string, closed: boolean, reason?: string) {
    const [tier] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tierId))
      .limit(1);

    if (!tier) throw notFound(`No tier with id ${tierId}`);

    const nextStatus = closed ? 'closed' : 'active';

    const updated = await withTransaction(async (tx) => {
      const [row] = await tx
        .update(ticketTiers)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(ticketTiers.id, tierId))
        .returning();

      await recordTransition(tx, {
        entity: 'inventory',
        entityId: tierId,
        event: closed ? 'inventory.sales_closed' : 'inventory.sales_reopened',
        fromState: tier.status,
        toState: nextStatus,
        actor: 'admin',
        eventId: tier.eventId,
        detail: {
          tierName: tier.name,
          reason: reason ?? null,
          // The counters at the moment of the decision — the number the
          // organiser actually acted on.
          soldAtDecision: tier.quantitySold,
          reservedAtDecision: tier.quantityReserved,
          capacity: tier.quantityTotal,
        },
      });

      return row!;
    });

    await invalidateEvent(tier.eventId);
    return updated;
  }

  const closeBody = z
    .object({ reason: boundedText(1, 300).optional() })
    .strict();

  app.post('/api/admin/tiers/:id/close-sales', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = closeBody.parse(request.body ?? {});
    const tier = await setTierSalesClosed(id, true, body.reason);

    return {
      tier,
      // Says plainly what buyers will now see, so an organiser closing a sale is
      // not guessing at the storefront's behaviour.
      buyersSee: 'sold out',
      soldAtClose: tier.quantitySold,
    };
  });

  app.post('/api/admin/tiers/:id/reopen-sales', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = closeBody.parse(request.body ?? {});
    const tier = await setTierSalesClosed(id, false, body.reason);
    return { tier, buyersSee: 'on sale' };
  });

  // ─── Orders ─────────────────────────────────────────────────────────────

  app.get('/api/admin/events/:id/orders', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        status: z
          .enum([
            'pending',
            'awaiting_payment',
            'paid',
            'failed',
            'expired',
            'cancelled',
            'refunded',
          ])
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);

    const where = query.status
      ? and(eq(orders.eventId, id), eq(orders.status, query.status))
      : eq(orders.eventId, id);

    return {
      orders: await db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(query.limit),
    };
  });

  // ─── Buyers ─────────────────────────────────────────────────────────────
  //
  // One row per buyer rather than per order, keyed on email. Somebody who buys
  // twice is one person to an organiser working a door list, not two — and the
  // `orders` listing above already covers the per-transaction view.
  //
  // Only paid orders count. Including in-flight ones would show an organiser
  // names that may never pay, which is worse than useless on a door list.

  app.get('/api/admin/events/:id/buyers', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(1_000).default(200),
        // Substring match on name or email, for finding one person at the gate.
        search: boundedText(1, 120).optional(),
      })
      .strict()
      .parse(request.query ?? {});

    const conditions = [eq(orders.eventId, id), eq(orders.status, 'paid')];

    if (query.search) {
      // Escape the LIKE wildcards so a buyer searching for "a_b" does not match
      // every three-character string.
      const pattern = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(
        sql`(${orders.buyerName} ILIKE ${pattern} OR ${orders.buyerEmail} ILIKE ${pattern})`,
      );
    }

    const rows = await db
      .select({
        email: orders.buyerEmail,
        // Buyers occasionally vary capitalisation between orders; the most recent
        // spelling of the name is the one to show.
        name: sql<string>`(array_agg(${orders.buyerName} ORDER BY ${orders.createdAt} DESC))[1]`,
        phone: sql<string>`(array_agg(${orders.buyerPhone} ORDER BY ${orders.createdAt} DESC))[1]`,
        orderCount: count(orders.id),
        totalCents: sql<number>`coalesce(sum(${orders.totalCents}), 0)`,
        // Aggregates over a timestamptz come back as Postgres' own text format,
        // not the ISO strings every other endpoint returns, so they are cast here
        // rather than leaving the client to handle two date formats.
        firstPurchaseAt: sql<string>`to_char(min(${orders.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        lastPurchaseAt: sql<string>`to_char(max(${orders.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        references: sql<string[]>`array_agg(${orders.reference} ORDER BY ${orders.createdAt} DESC)`,
      })
      .from(orders)
      .where(and(...conditions))
      .groupBy(orders.buyerEmail)
      .orderBy(desc(sql`max(${orders.createdAt})`))
      .limit(query.limit);

    // Ticket counts come from `tickets`, not from order quantities: an order can
    // be paid before issuance runs, and a ticket can be voided afterwards.
    const ticketCounts = await db
      .select({
        email: orders.buyerEmail,
        ticketsIssued: sql<number>`count(*) filter (where ${tickets.status} <> 'void')`,
        ticketsCheckedIn: sql<number>`count(*) filter (where ${tickets.status} = 'checked_in')`,
        ticketsVoid: sql<number>`count(*) filter (where ${tickets.status} = 'void')`,
      })
      .from(tickets)
      .innerJoin(orders, eq(tickets.orderId, orders.id))
      .where(eq(orders.eventId, id))
      .groupBy(orders.buyerEmail);

    const countsByEmail = new Map(ticketCounts.map((row) => [row.email, row]));

    return {
      buyers: rows.map((row) => {
        const counts = countsByEmail.get(row.email);
        return {
          name: row.name,
          email: row.email,
          phone: row.phone,
          orderCount: Number(row.orderCount),
          totalCents: Number(row.totalCents),
          ticketsIssued: Number(counts?.ticketsIssued ?? 0),
          ticketsCheckedIn: Number(counts?.ticketsCheckedIn ?? 0),
          ticketsVoid: Number(counts?.ticketsVoid ?? 0),
          fullyCheckedIn:
            Number(counts?.ticketsIssued ?? 0) > 0 &&
            Number(counts?.ticketsCheckedIn ?? 0) === Number(counts?.ticketsIssued ?? 0),
          firstPurchaseAt: row.firstPurchaseAt,
          lastPurchaseAt: row.lastPurchaseAt,
          references: row.references,
        };
      }),
    };
  });

  // ─── Reporting ──────────────────────────────────────────────────────────

  app.get('/api/admin/events/:id/stats', async (request) => {
    const { id } = idParams.parse(request.params);

    // `sum()` skips NULLs, so an uncapped tier would quietly vanish from the
    // capacity total and leave `available` overstating what is really left.
    // Capped and uncapped tiers are therefore counted separately, and the
    // remaining-seats figure is computed only over tiers that have a limit.
    const [inventory] = await db
      .select({
        cappedCapacity: sql<number>`coalesce(sum(${ticketTiers.quantityTotal}), 0)`,
        cappedTiers: sql<number>`count(*) filter (where ${ticketTiers.quantityTotal} is not null)`,
        uncappedTiers: sql<number>`count(*) filter (where ${ticketTiers.quantityTotal} is null)`,
        reserved: sql<number>`coalesce(sum(${ticketTiers.quantityReserved}), 0)`,
        sold: sql<number>`coalesce(sum(${ticketTiers.quantitySold}), 0)`,
        cappedAvailable: sql<number>`coalesce(sum(
          greatest(${ticketTiers.quantityTotal} - ${ticketTiers.quantityReserved} - ${ticketTiers.quantitySold}, 0)
        ) filter (where ${ticketTiers.quantityTotal} is not null), 0)`,
      })
      .from(ticketTiers)
      .where(eq(ticketTiers.eventId, id));

    // Per-tier breakdown, which is what an organiser actually reads: how many of
    // each tier sold, and how many of those have walked through the gate.
    const tierBreakdown = await db
      .select({
        tierId: ticketTiers.id,
        name: ticketTiers.name,
        priceCents: ticketTiers.priceCents,
        status: ticketTiers.status,
        capacity: ticketTiers.quantityTotal,
        reserved: ticketTiers.quantityReserved,
        sold: ticketTiers.quantitySold,
      })
      .from(ticketTiers)
      .where(eq(ticketTiers.eventId, id))
      .orderBy(ticketTiers.sortOrder, ticketTiers.name);

    const checkedInByTier = await db
      .select({
        tierId: tickets.tierId,
        issued: count(tickets.id),
        checkedIn: sql<number>`count(*) filter (where ${tickets.status} = 'checked_in')`,
      })
      .from(tickets)
      .where(eq(tickets.eventId, id))
      .groupBy(tickets.tierId);

    const admissionsByTier = new Map(
      checkedInByTier.map((row) => [row.tierId, row]),
    );

    const [revenue] = await db
      .select({
        paidOrders: count(orders.id),
        grossCents: sum(orders.totalCents),
      })
      .from(orders)
      .where(and(eq(orders.eventId, id), eq(orders.status, 'paid')));

    const [admissions] = await db
      .select({
        issued: count(tickets.id),
        checkedIn: sql<number>`count(*) filter (where ${tickets.status} = 'checked_in')`,
      })
      .from(tickets)
      .where(eq(tickets.eventId, id));

    // Orders paid but flagged because they settled after the hold lapsed.
    const [needsRefund] = await db
      .select({ total: count(orders.id) })
      .from(orders)
      .where(
        and(
          eq(orders.eventId, id),
          sql`${orders.metadata} ->> 'refundRequired' = 'true'`,
        ),
      );

    const uncappedTiers = Number(inventory?.uncappedTiers ?? 0);

    return {
      inventory: {
        /** Total seats across tiers that have a limit. */
        cappedCapacity: Number(inventory?.cappedCapacity ?? 0),
        cappedTiers: Number(inventory?.cappedTiers ?? 0),
        /** Tiers selling with no limit. When above zero, capacity is open-ended. */
        uncappedTiers,
        hasUncappedTiers: uncappedTiers > 0,
        reserved: Number(inventory?.reserved ?? 0),
        sold: Number(inventory?.sold ?? 0),
        /** Remaining seats across capped tiers only. */
        available: Number(inventory?.cappedAvailable ?? 0),
      },
      tiers: tierBreakdown.map((tier) => {
        const admissions = admissionsByTier.get(tier.tierId);
        const available =
          tier.capacity === null
            ? null
            : Math.max(tier.capacity - tier.reserved - tier.sold, 0);

        return {
          tierId: tier.tierId,
          name: tier.name,
          priceCents: tier.priceCents,
          status: tier.status,
          /** `null` means this tier sells without a capacity limit. */
          capacity: tier.capacity,
          uncapped: tier.capacity === null,
          reserved: tier.reserved,
          sold: tier.sold,
          available,
          issued: Number(admissions?.issued ?? 0),
          checkedIn: Number(admissions?.checkedIn ?? 0),
        };
      }),
      revenue: {
        paidOrders: Number(revenue?.paidOrders ?? 0),
        grossCents: Number(revenue?.grossCents ?? 0),
      },
      admissions: {
        issued: Number(admissions?.issued ?? 0),
        checkedIn: Number(admissions?.checkedIn ?? 0),
      },
      attention: { refundRequired: Number(needsRefund?.total ?? 0) },
    };
  });

  app.get('/api/admin/events/:id/payments', async (request) => {
    const { id } = idParams.parse(request.params);

    return {
      payments: await db
        .select({
          id: payments.id,
          orderReference: orders.reference,
          gateway: payments.gateway,
          gatewayRef: payments.gatewayRef,
          amountCents: payments.amountCents,
          status: payments.status,
          receipt: payments.receipt,
          resultDesc: payments.resultDesc,
          createdAt: payments.createdAt,
          settledAt: payments.settledAt,
        })
        .from(payments)
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(eq(orders.eventId, id))
        .orderBy(desc(payments.createdAt))
        .limit(500),
    };
  });

  // ─── Gate staff ─────────────────────────────────────────────────────────

  app.post('/api/admin/events/:id/scanner-tokens', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        gate: boundedText(1, 60).default('main'),
        ttlHours: z.number().int().min(1).max(72).default(12),
      })
      .strict()
      .parse(request.body ?? {});

    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw notFound(`No event with id ${id}`);

    return mintScannerToken(id, body.gate, body.ttlHours);
  });

  app.post('/api/admin/tickets/:code/void', async (request) => {
    const { code } = z
      .object({
        code: z
          .string()
          .min(4)
          .max(20)
          .transform((value) => value.trim().toUpperCase())
          .pipe(z.string().regex(/^[0-9A-Z-]+$/, 'must be a ticket code')),
      })
      .strict()
      .parse(request.params);

    const body = z
      .object({ reason: boundedText(1, 500).optional() })
      .strict()
      .parse(request.body ?? {});

    // The actor is recorded in the ledger, so voiding is attributable rather
    // than anonymous. There is one admin key today; when there are several this
    // is where the key's identity belongs.
    await voidTicket(code, body.reason, 'admin');
    return { voided: true, code };
  });

  // Runs the archive sweep now instead of waiting for the hourly job. Useful for
  // verifying the retention window without moving the clock, and for clearing a
  // backlog immediately after changing EVENT_ARCHIVE_AFTER_DAYS.
  app.post('/api/admin/events/archive-past', async (request) => {
    const { afterDays } = z
      .object({ afterDays: z.coerce.number().int().min(0).max(3_650).optional() })
      .strict()
      .parse(request.body ?? {});

    const archived = await archivePastEvents(afterDays ?? env.EVENT_ARCHIVE_AFTER_DAYS);

    for (const event of archived) {
      await invalidateEvent(event.id, event.slug);
    }

    return {
      archived: archived.length,
      events: archived,
      afterDays: afterDays ?? env.EVENT_ARCHIVE_AFTER_DAYS,
    };
  });

  // ─── Audit ──────────────────────────────────────────────────────────────
  //
  // The ledger is the cross-reference of record when the tables and reality
  // disagree — a buyer insisting they paid, counters that do not match tickets
  // issued, a Safaricom receipt with no order against it.

  app.get('/api/admin/orders/:reference/history', async (request) => {
    const { reference } = z
      .object({
        reference: z
          .string()
          .min(4)
          .max(40)
          .regex(/^[A-Za-z0-9-]+$/, 'must be an order reference'),
      })
      .strict()
      .parse(request.params);

    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.reference, reference))
      .limit(1);

    if (!order) throw notFound(`No order with reference ${reference}`);

    // Verifying alongside the history is the point: an operator reading this in
    // a dispute needs to know the entries have not been altered, not just what
    // they say.
    const [history, integrity] = await Promise.all([
      getOrderHistory(order.id),
      verifyChain({ orderId: order.id }),
    ]);

    return { reference, integrity, history };
  });

  app.get('/api/admin/ledger', async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .strict()
      .parse(request.query ?? {});

    return { entries: await getRecentEntries(query.limit) };
  });

  // Recomputes every digest and walks every chain. Run it before relying on the
  // ledger in a dispute. Deliberately not cached and rate-limited hard: it is a
  // full table scan, not a dashboard widget.
  app.post(
    '/api/admin/ledger/verify',
    { config: { rateLimit: LIMITS.adminWrite } },
    async (request) => {
      const body = z
        .object({ limit: z.coerce.number().int().min(1).max(1_000_000).optional() })
        .strict()
        .parse(request.body ?? {});

      const result = await verifyChain(
        body.limit === undefined ? {} : { limit: body.limit },
      );

      if (!result.valid) {
        request.log.error({ result }, 'LEDGER VERIFICATION FAILED');
      }

      return result;
    },
  );
}
