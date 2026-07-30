import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Serving the storefront from the API.
//
// One origin, deliberately: the API at /api/* and the buyer's pages at /. The
// M-Pesa callback therefore arrives on the same host the buyer is already on,
// there is no cross-origin request anywhere in the purchase path, and CORS stops
// being something that can break a sale.
//
// Optional at runtime. In development the storefront is served by Vite on its
// own port and proxies /api here, so there is no build to serve and this stays
// switched off — which is also what happens if an image is ever built without
// the web stage. The API must not fail to start over a missing front end.
// ---------------------------------------------------------------------------

/**
 * Where the built storefront lives, relative to the working directory.
 *
 * Matches the Dockerfile, which copies the Vite output to `web/dist` beside the
 * compiled server. Kept cwd-relative rather than resolved from `import.meta.url`
 * so it reads the same in `dist/` as it does in `src/`.
 */
const STOREFRONT_ROOT = path.resolve(process.cwd(), 'web', 'dist');

let enabled = false;

/** True when a built storefront was found and is being served. */
export function storefrontEnabled(): boolean {
  return enabled;
}

/**
 * Serves a request with the storefront's entry document.
 *
 * The SPA fallback: the client owns its routes, so a deep link like
 * `/orders/TKT-XXXXXXXX` is a real page to the buyer and a path the server has
 * never heard of. Without this it 404s on refresh or when the link is shared,
 * which are precisely the moments someone is trying to find their ticket.
 */
export function sendStorefrontIndex(_request: FastifyRequest, reply: FastifyReply) {
  return (
    reply
      .type('text/html')
      // Never cached, unlike the fingerprinted assets it references. A cached
      // entry document keeps pointing at bundles a later deploy has already
      // removed, so the buyer gets a blank page that a reload does not fix.
      //
      // `cacheControl: false` is load-bearing: without it the plugin writes its
      // own max-age over this header and the document inherits the one-year
      // lifetime meant only for fingerprinted assets.
      .header('cache-control', 'no-cache')
      .sendFile('index.html', { cacheControl: false })
  );
}

export async function registerStorefront(app: FastifyInstance): Promise<boolean> {
  if (!existsSync(path.join(STOREFRONT_ROOT, 'index.html'))) {
    logger.info(
      { root: STOREFRONT_ROOT },
      'no built storefront found — serving the API only',
    );
    enabled = false;
    return false;
  }

  await app.register(fastifyStatic, {
    root: STOREFRONT_ROOT,
    // The fallback handles unmatched paths. Left on, the wildcard route would
    // swallow every URL — including /api/* typos, which must keep answering
    // with the API's JSON error envelope rather than a page.
    wildcard: false,
    // Vite fingerprints everything it emits under /assets, so those are safe to
    // treat as immutable.
    maxAge: '1y',
    // The entry document is deliberately not served from here, so it cannot pick
    // up that cache lifetime. It is handled by the route below and the not-found
    // fallback, both of which send it with no-cache.
    index: false,
  });

  app.get('/', sendStorefrontIndex);

  enabled = true;
  logger.info({ root: STOREFRONT_ROOT }, 'serving the storefront');
  return true;
}
