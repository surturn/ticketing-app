import { afterAll, describe, expect, it } from 'vitest';
import { cacheRedis, closeRedis } from '../lib/redis.js';
import { shouldRunDbTests } from '../test/disposable-db.js';
import {
  adminActor,
  mintScannerToken,
  requireScanner,
  revokeScannerToken,
} from './auth.js';

// ---------------------------------------------------------------------------
// A gate credential you cannot withdraw is the problem being solved, so the
// case that matters is the negative one: a token that was valid a moment ago
// must stop working the instant it is revoked.
//
// Runs against a real Redis, because the denylist *is* Redis — asserting
// against a fake would only prove the test double behaves as written.
//
//   docker compose up -d redis
//   RUN_DB_TESTS=true npm test
// ---------------------------------------------------------------------------

const enabled = shouldRunDbTests();

/** The parts of a Fastify request the scanner guard actually reads. */
function fakeRequest(token?: string) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    log: { error: () => {}, warn: () => {}, debug: () => {} },
  } as never;
}

const reply = {} as never;

describe.skipIf(!enabled)('scanner token revocation', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('accepts a freshly minted token', async () => {
    const { token } = await mintScannerToken('event-1', 'main', 1);
    const request = fakeRequest(token);

    await expect(requireScanner(request, reply)).resolves.toBeUndefined();
    expect((request as { scanner?: { eventId: string } }).scanner?.eventId).toBe('event-1');
  });

  it('refuses the same token once it is revoked', async () => {
    const { token, jti } = await mintScannerToken('event-1', 'main', 1);

    // Valid first — otherwise a later rejection proves nothing about revocation.
    await expect(requireScanner(fakeRequest(token), reply)).resolves.toBeUndefined();

    await revokeScannerToken(jti, 3_600);

    await expect(requireScanner(fakeRequest(token), reply)).rejects.toThrow(/revoked/i);
  });

  it('revokes one device without touching the others', async () => {
    // The whole point. Rotating the signing secret would have stopped both.
    const lost = await mintScannerToken('event-1', 'north-gate', 1);
    const kept = await mintScannerToken('event-1', 'south-gate', 1);

    await revokeScannerToken(lost.jti, 3_600);

    await expect(requireScanner(fakeRequest(lost.token), reply)).rejects.toThrow(/revoked/i);
    await expect(requireScanner(fakeRequest(kept.token), reply)).resolves.toBeUndefined();
  });

  it('expires the denylist entry with the token rather than keeping it forever', async () => {
    const { jti } = await mintScannerToken('event-1', 'main', 1);
    await revokeScannerToken(jti, 3_600);

    const ttl = await cacheRedis.ttl(`${process.env.REDIS_PREFIX}:scanner:revoked:${jti}`);

    // Past its expiry the signature stops being accepted on its own, so a key
    // that outlived the token would only grow the set.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3_600);
  });

  it('does nothing for a token that has already expired', async () => {
    const { jti } = await mintScannerToken('event-1', 'main', 1);
    expect(await revokeScannerToken(jti, 0)).toEqual({ revoked: false });
  });

  it('refuses a token minted before tokens carried an id', async () => {
    // An unrevocable credential at a gate is what this exists to end, so a
    // legacy token is refused rather than grandfathered.
    const { SignJWT } = await import('jose');
    const legacy = await new SignJWT({ role: 'scanner', eventId: 'event-1', gate: 'main' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3_600)
      .sign(new TextEncoder().encode(process.env.SCANNER_JWT_SECRET!));

    await expect(requireScanner(fakeRequest(legacy), reply)).rejects.toThrow();
  });

  it('rejects a request with no token at all', async () => {
    await expect(requireScanner(fakeRequest(), reply)).rejects.toThrow();
  });
});

describe('admin attribution', () => {
  it('names the account when one signed the request', () => {
    const request = { user: { email: 'organiser@example.com' } } as never;
    expect(adminActor(request)).toBe('admin:organiser@example.com');
  });

  it('says plainly that the shared key identifies nobody', () => {
    // The ledger recorded `admin` for every action before this. Integrity was
    // covered; attribution was not, and this is the half people ask about.
    expect(adminActor({} as never)).toBe('admin:api-key');
  });
});
