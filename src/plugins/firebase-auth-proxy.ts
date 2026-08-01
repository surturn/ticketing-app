import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Firebase's auth handler, served from our own domain.
//
// Firebase Auth performs the OAuth dance on `<project>.firebaseapp.com`, and
// that domain is what the buyer sees: on Google's consent screen, and in the
// "you shared some data with…" mail Google sends afterwards. For a buyer
// halfway through signing in to Eventify, being asked to trust
// `ticketa-9d7e7.firebaseapp.com` is at best confusing and at worst exactly
// what a phishing page looks like.
//
// The fix is a custom auth domain: point `authDomain` at our own host and serve
// the handler from there. Firebase Hosting does this automatically, and this is
// the same arrangement done by hand — every `/__/auth/*` and `/__/firebase/*`
// request is forwarded upstream and its response returned verbatim.
//
// Only the OAuth handler moves. Token minting and verification still happen
// against Google's own endpoints from the client, so nothing security-relevant
// is being proxied: this path carries a redirect dance, not a credential we
// could weaken by touching it.
// ---------------------------------------------------------------------------

/** Everything Firebase serves from the auth domain, and nothing else. */
const PROXY_PREFIXES = ['/__/auth', '/__/firebase'];

/**
 * Headers that must not be copied through.
 *
 * `host` has to become the upstream's or it routes to the wrong project.
 * Hop-by-hop headers describe *this* connection and are meaningless on the
 * next one — forwarding `content-length` in particular breaks the response
 * when the upstream body is re-encoded.
 */
const STRIP_REQUEST = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
]);

const STRIP_RESPONSE = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  // Ours are stricter and already set; letting the upstream's through would
  // relax the policy on our own origin.
  'content-security-policy',
  'strict-transport-security',
]);

/**
 * Puts the parsed body back on the wire in the shape it arrived in.
 *
 * Fastify has already parsed and discarded the raw bytes by the time a handler
 * runs, so they have to be reconstructed. The handler receives form posts and
 * JSON; anything else is passed through as a string, which is what the default
 * parser would have produced anyway.
 */
function serialiseBody(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');

  const contentType = String(request.headers['content-type'] ?? '');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body as Record<string, string>).toString();
  }
  return JSON.stringify(body);
}

export function registerFirebaseAuthProxy(app: FastifyInstance): boolean {
  const upstream = env.FIREBASE_AUTH_UPSTREAM;
  if (!upstream) return false;

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const target = `https://${upstream}${request.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (STRIP_REQUEST.has(key) || value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
    headers.set('host', upstream);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : serialiseBody(request),
        // Redirects are the whole mechanism here, so they are passed back to
        // the browser rather than followed on its behalf.
        redirect: 'manual',
      });
    } catch (error) {
      logger.error({ err: error, target }, 'Firebase auth proxy failed');
      return reply.status(502).send({
        error: {
          code: 'auth_upstream_unavailable',
          message: 'Sign-in is temporarily unavailable. Please try again shortly.',
          retryable: true,
        },
      });
    }

    upstreamResponse.headers.forEach((value, key) => {
      if (STRIP_RESPONSE.has(key.toLowerCase())) return;
      // `set-cookie` can legitimately repeat; `append` keeps every one.
      reply.header(key, value);
    });

    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    return reply.status(upstreamResponse.status).send(body);
  };

  for (const prefix of PROXY_PREFIXES) {
    app.all(`${prefix}/*`, { config: { rateLimit: false } }, handler);
    app.all(prefix, { config: { rateLimit: false } }, handler);
  }

  logger.info({ upstream }, 'serving the Firebase auth handler from this origin');
  return true;
}
