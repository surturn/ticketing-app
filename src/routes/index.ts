import type { FastifyInstance } from 'fastify';
import { adminRoutes } from './admin.routes.js';
import { checkInRoutes } from './checkin.routes.js';
import { checkoutRoutes } from './checkout.routes.js';
import { eventRoutes } from './events.routes.js';
import { healthRoutes } from './health.routes.js';
import { orderRoutes } from './orders.routes.js';
import { webhookRoutes } from './webhooks.routes.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(eventRoutes);
  await app.register(checkoutRoutes);
  await app.register(orderRoutes);
  await app.register(webhookRoutes);
  await app.register(checkInRoutes);
  // Registered in its own scope so the admin preHandler cannot leak onto the
  // public routes above.
  await app.register(adminRoutes);
}
