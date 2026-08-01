import { pino } from 'pino';
import { env, isProduction } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Structured JSON in production so Railway's log viewer can parse it;
  // human-readable locally.
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'password',
      '*.password',
      '*.Password',
      'consumerSecret',
      '*.passkey',
    ],
    censor: '[redacted]',
  },

  serializers: {
    /**
     * Logs the path, never the query string.
     *
     * Redaction above covers headers, which is where credentials normally live —
     * but not all of ours do. Daraja cannot send a custom header, so the M-Pesa
     * callback token rides on the query string (`config/env.ts`,
     * `gateways/mpesa/daraja.ts`), and Fastify's default serialiser logs
     * `req.url` whole. Every genuine Safaricom callback was therefore writing
     * `POST /api/webhooks/mpesa?token=<the secret>` into the log stream.
     *
     * That matters more than a leaked path would: the token is the only thing
     * authenticating a settlement, so anyone able to read logs — a support
     * agent, a log shipper, an error-reporting sink — could mint paid orders.
     * Dropping the query string collapses that back to what a log should be.
     *
     * Nothing here needs query parameters to be debuggable: the routes that take
     * them validate into `request.query` and log the parsed values where they
     * matter.
     */
    req(request) {
      return {
        method: request.method,
        url: request.url.split('?')[0],
        remoteAddress: request.ip,
      };
    },
  },
});

export type Logger = typeof logger;
