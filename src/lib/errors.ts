/**
 * Application errors carry an HTTP status and a stable machine-readable code so
 * clients can branch on `error.code` instead of matching message strings.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  /** Signals the caller may safely retry — used for lock contention at spike. */
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, { details });

export const unauthorized = (message = 'Unauthorized') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'Forbidden') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = 'Not found') =>
  new AppError(404, 'not_found', message);

export const conflict = (
  code: string,
  message: string,
  options: { details?: unknown; retryable?: boolean } = {},
) => new AppError(409, code, message, options);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, { details });

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message, { retryable: true });

export const serviceUnavailable = (code: string, message: string) =>
  new AppError(503, code, message, { retryable: true });

/**
 * Postgres raises 55P03 (lock_not_available) / 40P01 (deadlock_detected) when
 * a hot tier row is contended. Both are safe for the client to retry.
 */
export function isRetryablePgError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '55P03' || code === '40P01' || code === '40001';
}
