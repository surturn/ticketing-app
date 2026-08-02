import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The callback token is the only thing separating a real settlement from a
// forged one, and a settlement is what turns a held order into issued tickets.
// The `gatewayRef` needed to aim a forgery at a specific payment is returned to
// the buyer in the checkout response, so "an attacker knows which payment to
// target" is the assumed starting point rather than a stretch.
//
// `env` is parsed once at module load, so each case re-imports the module with a
// different environment rather than mutating a frozen object.
// ---------------------------------------------------------------------------

const TOKEN = 'a'.repeat(32);

/**
 * Re-imports the gateway with only the environment this test set.
 *
 * `config/env.ts` calls `process.loadEnvFile('.env')` at module load, so a fresh
 * import re-reads the developer's own `.env` from disk and quietly reinstates
 * whatever this test just deleted. Without the stub the "no token configured"
 * case passes for the wrong reason — it sees the real local token, which is not
 * the one being offered, and returns false for a reason the test is not about.
 */
async function loadWith(token: string | undefined) {
  vi.resetModules();
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});

  if (token === undefined) delete process.env.MPESA_CALLBACK_TOKEN;
  else process.env.MPESA_CALLBACK_TOKEN = token;

  return import('./gateway.js');
}

afterEach(() => {
  delete process.env.MPESA_CALLBACK_TOKEN;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('isValidCallbackToken', () => {
  it('rejects everything when no token is configured', async () => {
    const { isValidCallbackToken } = await loadWith(undefined);

    // The regression that matters. This used to return `true` — an unconfigured
    // deployment accepted a settlement from anyone who found the URL.
    expect(isValidCallbackToken(undefined)).toBe(false);
    expect(isValidCallbackToken('')).toBe(false);
    expect(isValidCallbackToken(TOKEN)).toBe(false);
  });

  it('accepts the configured token', async () => {
    const { isValidCallbackToken } = await loadWith(TOKEN);
    expect(isValidCallbackToken(TOKEN)).toBe(true);
  });

  it('rejects a wrong, absent, or truncated token', async () => {
    const { isValidCallbackToken } = await loadWith(TOKEN);

    expect(isValidCallbackToken(undefined)).toBe(false);
    expect(isValidCallbackToken('')).toBe(false);
    expect(isValidCallbackToken('b'.repeat(32))).toBe(false);
    // A prefix must not pass: length is checked before the comparison, and a
    // shorter buffer would otherwise throw rather than return false.
    expect(isValidCallbackToken(TOKEN.slice(0, 31))).toBe(false);
    expect(isValidCallbackToken(`${TOKEN}x`)).toBe(false);
  });

  it('does not treat a non-string query value as a token', async () => {
    const { isValidCallbackToken } = await loadWith(TOKEN);

    // `?token=a&token=a` arrives as an array. Fastify's query parsing makes this
    // reachable from the wire, so it is checked rather than assumed away.
    expect(isValidCallbackToken([TOKEN] as unknown as string)).toBe(false);
  });
});

describe('authenticateCallback', () => {
  it('reaches the same verdict through the gateway interface', async () => {
    // The route talks to the interface, not to the exported function, so the
    // method is what actually guards production — testing only the function
    // would leave the wiring unasserted.
    const { mpesaGateway } = await loadWith(TOKEN);
    const headers = {};

    expect(
      mpesaGateway.authenticateCallback({ query: { token: TOKEN }, headers }),
    ).toBe(true);
    expect(
      mpesaGateway.authenticateCallback({ query: { token: 'wrong' }, headers }),
    ).toBe(false);
    expect(mpesaGateway.authenticateCallback({ query: {}, headers })).toBe(false);
    expect(mpesaGateway.authenticateCallback({ query: undefined, headers })).toBe(false);
  });

  it('refuses a repeated query parameter rather than trusting the array', async () => {
    const { mpesaGateway } = await loadWith(TOKEN);
    // `?token=x&token=x` parses to an array; only a string may be compared.
    expect(
      mpesaGateway.authenticateCallback({ query: { token: [TOKEN] }, headers: {} }),
    ).toBe(false);
  });

  it('fails closed when no token is configured', async () => {
    const { mpesaGateway } = await loadWith(undefined);
    expect(
      mpesaGateway.authenticateCallback({ query: { token: TOKEN }, headers: {} }),
    ).toBe(false);
  });
});

describe('mpesaConfigured', () => {
  it('is false when a callback token is missing but everything else is set', async () => {
    vi.resetModules();
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    process.env.MPESA_CONSUMER_KEY = 'key';
    process.env.MPESA_CONSUMER_SECRET = 'secret';
    process.env.MPESA_PASSKEY = 'passkey';
    process.env.MPESA_CALLBACK_URL = 'https://example.com/api/webhooks/mpesa';
    delete process.env.MPESA_CALLBACK_TOKEN;

    const { mpesaConfigured } = await import('../../config/env.js');

    // Charging a buyer and being able to tell a real settlement from a forged
    // one are not separable capabilities, so the gateway reports itself
    // unconfigured rather than half-configured.
    expect(mpesaConfigured).toBe(false);

    for (const key of [
      'MPESA_CONSUMER_KEY',
      'MPESA_CONSUMER_SECRET',
      'MPESA_PASSKEY',
      'MPESA_CALLBACK_URL',
    ]) {
      delete process.env[key];
    }
  });
});
