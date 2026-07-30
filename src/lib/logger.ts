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
});

export type Logger = typeof logger;
