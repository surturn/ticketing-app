import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  events,
  orders,
  payments,
  ticketTiers,
  tickets,
} from '../db/schema.js';
import { invalidateEvent } from '../lib/cache.js';
import { notFound } from '../lib/errors.js';
import { mintScannerToken, requireAdmin } from '../plugins/auth.js';
import { voidTicket } from '../services/tickets.service.js';

// ---------------------------------------------------------------------------
// Organiser-facing endpoints. Everything under /api/admin requires the API key.
// ---------------------------------------------------------------------------

const eventBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens only'),
  name: z.string().min(1).max(200),
  description: z.string().max(5_000).optional(),
  venue: z.string().max(200).optional(),
  timezone: z.string().max(60).default('Africa/Nairobi'),
  currency: z.string().length(3).default('KES'),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  status: z.enum(['draft', 'published', 'closed', 'cancelled']).default('draft'),
});

const tierBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  priceCents: z.number().int().min(0),
  quantityTotal: z.number().int().min(1),
  minPerOrder: z.number().int().min(1).default(1),
  maxPerOrder: z.number().int().min(1).default(10),
  salesStartAt: z.coerce.date().optional(),
  salesEndAt: z.coerce.date().optional(),
  status: z.enum(['active', 'paused', 'hidden']).default('active'),
  sortOrder: z.number().int().default(0),
});

const idParams = z.object({ id: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  // ─── Events ─────────────────────────────────────────────────────────────

  app.get('/api/admin/events', async () => ({
    events: await db.select().from(events).orderBy(desc(events.startsAt)),
  }));

  app.post('/api/admin/events', async (request, reply) => {
    const body = eventBody.parse(request.body);
    const [created] = await db.insert(events).values(body).returning();
    await invalidateEvent(created!.id, created!.slug);
    return reply.status(201).send({ event: created });
  });

  app.patch('/api/admin/events/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = eventBody.partial().parse(request.body);

    const [updated] = await db
      .update(events)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();

    if (!updated) throw notFound(`No event with id ${id}`);
    await invalidateEvent(updated.id, updated.slug);
    return { event: updated };
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
    const body = tierBody.partial().parse(request.body);

    const [updated] = await db
      .update(ticketTiers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(ticketTiers.id, id))
      .returning();

    if (!updated) throw notFound(`No tier with id ${id}`);
    await invalidateEvent(updated.eventId);
    return { tier: updated };
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

  // ─── Reporting ──────────────────────────────────────────────────────────

  app.get('/api/admin/events/:id/stats', async (request) => {
    const { id } = idParams.parse(request.params);

    const [inventory] = await db
      .select({
        capacity: sum(ticketTiers.quantityTotal),
        reserved: sum(ticketTiers.quantityReserved),
        sold: sum(ticketTiers.quantitySold),
      })
      .from(ticketTiers)
      .where(eq(ticketTiers.eventId, id));

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

    return {
      inventory: {
        capacity: Number(inventory?.capacity ?? 0),
        reserved: Number(inventory?.reserved ?? 0),
        sold: Number(inventory?.sold ?? 0),
        available:
          Number(inventory?.capacity ?? 0) -
          Number(inventory?.reserved ?? 0) -
          Number(inventory?.sold ?? 0),
      },
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
        gate: z.string().min(1).max(60).default('main'),
        ttlHours: z.number().int().min(1).max(72).default(12),
      })
      .parse(request.body ?? {});

    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw notFound(`No event with id ${id}`);

    return mintScannerToken(id, body.gate, body.ttlHours);
  });

  app.post('/api/admin/tickets/:code/void', async (request) => {
    const { code } = z.object({ code: z.string().min(4) }).parse(request.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(
      request.body ?? {},
    );

    await voidTicket(code, body.reason);
    return { voided: true, code };
  });
}
