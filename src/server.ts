import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { env, isProduction } from './config/env.js';
import { logger } from './lib/logger.js';
import { cacheRedis } from './lib/redis.js';
import { MAX_UPLOAD_BYTES } from './lib/storage.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerSecurityHeaders } from './plugins/security.js';
import { registerStorefront } from './plugins/storefront.js';
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

  // Before everything that can produce a response, so no route can answer
  // without the headers — including the error handler and the static files.
  await registerSecurityHeaders(app);

  /**
   * Compression, for what benefits from it.
   *
   * Cloudflare already compresses to the browser, so this is about the hop
   * between here and Cloudflare — a JSON listing or a JavaScript bundle costs
   * meaningfully less egress compressed, and egress is metered.
   *
   * `global: false` on the threshold means small payloads are left alone: below
   * about a kilobyte, the CPU and the few bytes of framing cost more than the
   * saving. Images and fonts are already compressed and are skipped by their
   * content type.
   */
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
  });

  // Poster uploads. The cap is enforced again while reading the stream, because
  // this limit truncates rather than rejects — a plugin-truncated file would
  // otherwise be stored as a valid, broken image.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  });

  /**
   * CORS, closed by default in production.
   *
   * The storefront and the API share an origin, so the browser never makes a
   * cross-origin request in normal use and there is nothing to allow. Falling
   * back to `true` — reflecting whatever Origin arrives — was reasonable while
   * the two were served separately, but with `CORS_ORIGINS` unset in production
   * it quietly meant "any site may call this API from a visitor's browser".
   *
   * Development keeps the permissive fallback, where a Vite server on another
   * port genuinely is a different origin.
   */
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : !isProduction,
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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

    /**
     * Cloudflare's word for who the client is, where available.
     *
     * `request.ip` derives from `X-Forwarded-For`, and with `trustProxy: true`
     * that header is partly client-supplied — a caller can prepend addresses to
     * it. `CF-Connecting-IP` carries a single value that Cloudflare sets and
     * overwrites, so it cannot be influenced from outside.
     *
     * Measured against production before changing: rotating a forged
     * `X-Forwarded-For` did *not* reset the budget, so this is not closing an
     * open hole. It removes the dependency on that remaining true.
     */
    keyGenerator: (request) => {
      const cf = request.headers['cf-connecting-ip'];
      return (typeof cf === 'string' && cf) || request.ip;
    },

    // The limit is per-IP, and an IP hitting it is either a bot or a bug —
    // either way worth seeing in the logs rather than only in a 429 count.
    onExceeding: (request) => {
      request.log.warn({ url: request.url }, 'rate limit approaching');
    },
    onExceeded: (request) => {
      request.log.warn({ url: request.url }, 'rate limit exceeded');
    },
  });

  // Before the error handler, which needs the reply decorator this adds in order
  // to serve the storefront as the not-found fallback.
  await registerStorefront(app);

  registerErrorHandler(app);
  await registerRoutes(app);

  if (!isProduction) {
    app.ready(() => {
      app.log.debug(`\n${app.printRoutes()}`);
    });
  }

  return app;
}
