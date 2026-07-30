import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, isRetryablePgError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

// ---------------------------------------------------------------------------
// One error shape for the whole API:
//
//   { error: { code, message, details?, retryable } }
//
// Clients branch on `code`. `retryable` matters during a flash sale — a 409
// from lock contention should prompt the UI to retry, a 409 from "sold out"
// should not.
// ---------------------------------------------------------------------------

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // 4xx is the client's problem; only log the server's own failures loudly.
      const log = error.statusCode >= 500 ? request.log.error : request.log.warn;
      log.call(request.log, { err: error, code: error.code }, error.message);

      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request body is not valid',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          retryable: false,
        },
      });
    }

    // Fastify's own validation (schema on a route)
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: error.message,
          details: error.validation,
          retryable: false,
        },
      });
    }

    if (isRetryablePgError(error)) {
      request.log.warn({ err: error }, 'database contention');
      return reply.status(409).send({
        error: {
          code: 'contended',
          message: 'That resource is busy right now. Please try again.',
          retryable: true,
        },
      });
    }

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Slow down and try again.',
          retryable: true,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');

    return reply.status(error.statusCode ?? 500).send({
      error: {
        code: 'internal_error',
        message: isProduction
          ? 'Something went wrong on our end.'
          : (error.message ?? 'Internal error'),
        retryable: false,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'route_not_found',
        message: `No route for ${request.method} ${request.url}`,
        retryable: false,
      },
    });
  });
}
