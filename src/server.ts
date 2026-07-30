import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { env, isProduction } from './config/env.js';
import { logger } from './lib/logger.js';
import { cacheRedis } from './lib/redis.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Widened to FastifyBaseLogger deliberately. Passing the concrete pino
    // Logger makes Fastify specialise every generic on it, and the instance
    // then stops matching the plain `FastifyInstance` that route plugins take.
    loggerInstance: logger as FastifyBaseLogger,
    // Railway terminates TLS at its edge, so the client IP that rate limiting
    // and logs should use lives in X-Forwarded-For.
    trustProxy: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    bodyLimit: 1_048_576, // 1 MB — no endpoint here accepts anything large
  });

  await app.register(sensible);

  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : true,
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });

  // Rate limit state lives in Redis so the budget is shared across every
  // autoscaled replica — otherwise scaling out multiplies the effective limit.
  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    redis: cacheRedis,
    nameSpace: 'ratelimit:',
    // Never let a Redis hiccup take the API down with it.
    skipOnError: true,
    keyGenerator: (request) => request.ip,
  });

  registerErrorHandler(app);
  await registerRoutes(app);

  if (!isProduction) {
    app.ready(() => {
      app.log.debug(`\n${app.printRoutes()}`);
    });
  }

  return app;
}
