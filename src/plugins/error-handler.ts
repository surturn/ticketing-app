import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, isRetryablePgError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';
import {
  sendStorefrontIndex,
  storefrontEnabled,
  wantsStorefrontDocument,
} from './storefront.js';

// ---------------------------------------------------------------------------
// One error shape for the whole API:
//
//   { error: { code, message, details?, retryable } }
//
// Clients branch on `code`. `retryable` matters during a flash sale — a 409
// from lock contention should prompt the UI to retry, a 409 from "sold out"
// should not.
// ---------------------------------------------------------------------------

/**
 * The fallback for a server-side failure with nothing better to say.
 *
 * Deliberately tells the reader what to do rather than what broke. "Something
 * went wrong on our end" leaves someone mid-purchase with no idea whether to
 * wait, retry, or give up — and giving up is what they do.
 */
const SAFE_5XX_MESSAGE =
  'Something went wrong on our end. Nothing was charged — please try again in a moment.';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // 4xx is the client's problem; only log the server's own failures loudly.
      const log = error.statusCode >= 500 ? request.log.error : request.log.warn;
      log.call(request.log, { err: error, code: error.code }, error.message);

      /**
       * What actually goes over the wire.
       *
       * An explicit `publicMessage` always wins. Otherwise a 4xx sends its
       * message — those are written for the person who made the request and
       * describe something they can fix. A 5xx does not: its message is a log
       * line, and in production it is replaced by something the reader can act
       * on. Development keeps the detail, because that is when it is useful.
       *
       * This is why the gateway's raw response stopped appearing on the
       * checkout screen: the fix belongs here, once, rather than in every call
       * site that might one day throw a 503.
       */
      const publicMessage =
        error.publicMessage ??
        (error.statusCode >= 500 && isProduction
          ? SAFE_5XX_MESSAGE
          : error.message);

      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: publicMessage,
          // Details are Zod issues on a 4xx — safe and useful. On a 5xx they
          // are whatever a service attached, so they are withheld.
          details: error.statusCode >= 500 ? undefined : error.details,
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

    // Everything past this point is either a FastifyError or a plain throw, and
    // Fastify types the handler's argument as `unknown`. One narrowing here
    // beats casting at each of the six reads below.
    const err = error as FastifyError;

    // Fastify's own validation (schema on a route)
    if (err.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: err.message,
          details: err.validation,
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

    if (err.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Slow down and try again.',
          retryable: true,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');

    return reply.status(err.statusCode ?? 500).send({
      error: {
        code: 'internal_error',
        message: isProduction
          ? 'Something went wrong on our end.'
          : (err.message ?? 'Internal error'),
        retryable: false,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    // An unmatched navigation is a client-side route — the buyer following a
    // deep link to their order. Hand it the storefront and let the front end
    // resolve it. A missing asset, an API path or a non-GET is not a navigation
    // and falls through to the JSON envelope below; see `wantsStorefrontDocument`
    // for why that distinction has to be made carefully.
    if (storefrontEnabled() && wantsStorefrontDocument(request)) {
      return sendStorefrontIndex(request, reply);
    }

    return reply.status(404).send({
      error: {
        code: 'route_not_found',
        message: `No route for ${request.method} ${request.url}`,
        retryable: false,
      },
    });
  });
}
