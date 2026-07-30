// Runs before every test file, ahead of any import of config/env.ts — which
// validates the environment at module load and would otherwise throw.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://ticketing:ticketing@localhost:5432/ticketing_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.TICKET_SIGNING_SECRET ??= 'test-ticket-signing-secret-at-least-32-chars';
process.env.SCANNER_JWT_SECRET ??= 'test-scanner-jwt-secret-at-least-32-characters';
process.env.ADMIN_API_KEY ??= 'test-admin-api-key-value';
process.env.CACHE_ENABLED ??= 'false';
process.env.LOG_LEVEL ??= 'silent';
