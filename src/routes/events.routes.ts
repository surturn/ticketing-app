import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getAvailability,
  getPublicEvent,
  listPublishedEvents,
} from '../services/events.service.js';

const slugParams = z.object({ slug: z.string().min(1).max(120) });

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', async () => ({
    events: await listPublishedEvents(),
  }));

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
