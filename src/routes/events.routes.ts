import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getAvailability,
  getPublicEvent,
  listPastEvents,
  listPublishedEvents,
} from '../services/events.service.js';

// Constrained to the slug alphabet rather than any string: these values reach a
// cache key and a WHERE clause, and rejecting the impossible shapes up front
// keeps both from being probed with junk.
const slugParams = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/, 'must be a lowercase slug'),
  })
  .strict();

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', async () => ({
    events: await listPublishedEvents(),
  }));

  // Events that have already happened, including archived ones. Separate from
  // the current listing rather than a flag on it, so a storefront cannot show a
  // finished event as bookable by forgetting to filter.
  app.get('/api/events/past', async (request, reply) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .strict()
      .parse(request.query ?? {});

    reply.header('Cache-Control', 'public, max-age=300');
    return { events: await listPastEvents(limit) };
  });

  app.get('/api/events/:slug', async (request) => {
    const { slug } = slugParams.parse(request.params);
    return { event: await getPublicEvent(slug) };
  });

  // Polled by the sale page. Cached for a few seconds, so a thousand clients
  // refreshing every two seconds cost one query per interval, not a thousand.
  app.get('/api/events/:slug/availability', async (request, reply) => {
    const { slug } = slugParams.parse(request.params);
    const tiers = await getAvailability(slug);

    // Let intermediaries cache it for the same short window.
    reply.header('Cache-Control', 'public, max-age=5');
    return { tiers, asOf: new Date().toISOString() };
  });
}
