import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '../db/client.js';
import { checkRedis } from '../lib/redis.js';
import { listGateways } from '../gateways/registry.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — is the process up. Must not touch dependencies, or a brief
  // Redis blip would have Railway restart a perfectly healthy container.
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Readiness — should this instance receive traffic.
  app.get('/health/ready', async (_request, reply) => {
    const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
    const ready = database && redis;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      checks: { database, redis },
      gateways: listGateways(),
    });
  });
}
