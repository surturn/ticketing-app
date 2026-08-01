import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Serving Firebase's OAuth handler from our own origin puts Google's markup
// under our Content-Security-Policy. The site-wide policy forbids inline
// script — correct for our pages, fatal for that one, which is built around
// inline blocks. Sign-in failed with a console full of CSP violations and no
// other symptom: the page loaded, and then did nothing.
//
// The interesting property is not "a header is set" but "the header set on an
// onRequest hook by helmet, long before the route handler runs, is the one that
// loses". That ordering is the fix, so it is what is asserted here.
// ---------------------------------------------------------------------------

const UPSTREAM = 'ticketa-9d7e7.firebaseapp.com';

async function buildProxyApp() {
  vi.resetModules();
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  process.env.FIREBASE_AUTH_UPSTREAM = UPSTREAM;

  const { registerSecurityHeaders } = await import('./security.js');
  const { registerFirebaseAuthProxy } = await import('./firebase-auth-proxy.js');

  const app = Fastify();
  // Registered in the same order as the real server, so helmet's hook is
  // installed ahead of the proxy's routes exactly as it is in production.
  await registerSecurityHeaders(app);
  registerFirebaseAuthProxy(app);
  await app.ready();
  return app;
}

afterEach(() => {
  delete process.env.FIREBASE_AUTH_UPSTREAM;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the proxied Firebase auth handler', () => {
  it('replaces the site policy with one that permits the handler to run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html><script>init()</script></html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            // The upstream sets its own policy; ours must still be the one sent.
            'content-security-policy': "script-src 'none'",
          },
        }),
      ),
    );

    const app = await buildProxyApp();
    const response = await app.inject({ method: 'GET', url: '/__/auth/handler' });
    const csp = response.headers['content-security-policy'] as string;

    expect(response.statusCode).toBe(200);

    // The regression: without the override this is helmet's policy, which has
    // no 'unsafe-inline', and every inline block on the page is blocked.
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).toContain('https://apis.google.com');

    // And the upstream's own policy did not survive — we decide, not Google.
    expect(csp).not.toContain("script-src 'none'");

    // `/__/auth/iframe` is loaded in a frame by our own page during sign-in, so
    // the site-wide `frame-ancestors 'none'` would block the flow.
    expect(csp).toContain("frame-ancestors 'self'");
    // The older framing control says the same thing, so the two cannot
    // disagree about whether our own page may frame the sign-in iframe.
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');

    await app.close();
  });

  it('leaves the strict policy in place for everything else', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const app = await buildProxyApp();
    // A path the proxy does not claim, so it falls through to the site policy.
    const response = await app.inject({ method: 'GET', url: '/api/anything' });
    const csp = response.headers['content-security-policy'] as string;

    // The loosening is confined to the proxied pages. Anything that handles our
    // own data keeps the policy that forbids inline script.
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");

    await app.close();
  });
});
