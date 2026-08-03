import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getPublicEvent, type PublicEvent } from '../services/events.service.js';

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

// ---------------------------------------------------------------------------
// Per-event link previews.
//
// WhatsApp, Telegram, Facebook and the rest unfurl a shared link by fetching
// the raw HTML and reading its `<meta>` tags — they do not run the bundle, so
// a single-page app that only ever serves one generic entry document shows the
// same title and description for every event. That is precisely the moment a
// link is judged before anyone taps it: a poster and a name in the preview is
// the difference between an event that looks real and a bare blue link in a
// WhatsApp group.
//
// Handled by rewriting the same entry document that already exists rather
// than server-rendering the page. The bundle behaves exactly as before once
// it loads — this only changes what a link shows before a browser ever runs
// it, and the small string surgery below is cheaper than a render pipeline
// for the one thing that needed to change.
// ---------------------------------------------------------------------------

let indexHtmlTemplate: string | null = null;

/** Escapes a value for use inside an HTML attribute or text node. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Flattens a description into one line of plain prose for a preview card.
 *
 * Descriptions are written for `RichText` — paragraphs, bullets, `*emphasis*`
 * — and a card has no layout to render any of that in, so the same light
 * markup `RichText` parses is stripped here instead of carried through as
 * literal asterisks and dashes. Cut at a word boundary rather than mid-word,
 * because a truncated word reads as a bug and a truncated sentence reads as a
 * preview.
 */
function truncateDescription(raw: string, maxLength = 200): string {
  const flattened = raw
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^[ \t]*[*\-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (flattened.length <= maxLength) return flattened;

  const cut = flattened.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLength)}…`;
}

/**
 * Rewrites the entry document's `<title>`, description and preview tags for
 * one event.
 *
 * A pure string transform, deliberately: this runs on every request for an
 * event page, and the alternative — parsing the document into a DOM, editing
 * it, and serialising it back — is a real dependency and real work to redo
 * four lines of markup that are the same shape on every build.
 */
export function injectEventPreview(
  html: string,
  event: PublicEvent,
  canonicalUrl: string,
): string {
  const title = `${event.name} · Eventify Tickets`;
  const description = event.description
    ? truncateDescription(event.description)
    : `${event.name}${event.venue ? ` at ${event.venue}` : ''} — book with M-Pesa on Eventify Tickets.`;

  const withTitle = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${esc(title)}</title>`,
  );

  const withDescription = withTitle.replace(
    /<meta\s+name="description"[\s\S]*?\/>/,
    `<meta name="description" content="${esc(description)}" />`,
  );

  const preview =
    `    <meta property="og:type" content="website" />\n` +
    `    <meta property="og:site_name" content="Eventify Tickets" />\n` +
    `    <meta property="og:title" content="${esc(title)}" />\n` +
    `    <meta property="og:description" content="${esc(description)}" />\n` +
    `    <meta property="og:url" content="${esc(canonicalUrl)}" />\n` +
    (event.posterUrl
      ? `    <meta property="og:image" content="${esc(event.posterUrl)}" />\n` +
        `    <meta name="twitter:card" content="summary_large_image" />\n`
      : `    <meta name="twitter:card" content="summary" />\n`) +
    `    <meta name="twitter:title" content="${esc(title)}" />\n` +
    `    <meta name="twitter:description" content="${esc(description)}" />\n` +
    (event.posterUrl ? `    <meta name="twitter:image" content="${esc(event.posterUrl)}" />\n` : '');

  return withDescription.replace('</head>', `${preview}  </head>`);
}

/** The absolute origin to build `og:url` and `og:image` from. */
function resolveOrigin(request: FastifyRequest): string {
  if (env.PUBLIC_ORDER_BASE_URL) return env.PUBLIC_ORDER_BASE_URL.replace(/\/+$/, '');
  return `${request.protocol}://${request.hostname}`;
}

/**
 * Serves the entry document with one event's preview tags rewritten into it.
 *
 * Falls through to the plain entry document — not a 404 — for anything that
 * is not a real, published event. A stale or mistyped link should look like
 * the app that could not find that event, not like the server tripping over
 * the request; the client already renders that case.
 */
async function sendEventPreview(
  request: FastifyRequest<{ Params: { slug: string } }>,
  reply: FastifyReply,
) {
  if (indexHtmlTemplate) {
    try {
      const event = await getPublicEvent(request.params.slug);
      const canonicalUrl = `${resolveOrigin(request)}/events/${event.slug}`;
      const html = injectEventPreview(indexHtmlTemplate, event, canonicalUrl);

      return reply
        .type('text/html')
        .header('cache-control', 'no-cache')
        .send(html);
    } catch {
      // Not found, not published, or the database is unreachable — the
      // buyer still gets the app, which already knows how to say "we could
      // not find that event".
    }
  }

  return sendStorefrontIndex(request, reply);
}

/**
 * Whether an unmatched request should be answered with the entry document.
 *
 * The naive version of this — "any GET that is not /api/" — is actively
 * harmful. A request for a missing `/assets/index-abc123.js` would be answered
 * with HTML and a `200`, the browser would refuse to execute HTML as a module,
 * and the page would render blank with nothing in the console and a success
 * status on every request. That is a broken deploy disguised as a working one.
 *
 * A browser asking for a *page* sends `Accept: text/html`; asking for a module,
 * a stylesheet or an image it does not. That header is the discriminator, and
 * anything with a file extension is excluded as well, so a missing asset fails
 * as a missing asset.
 */
export function wantsStorefrontDocument(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.url.startsWith('/api/')) return false;

  const accept = request.headers.accept ?? '';
  if (!accept.includes('text/html')) return false;

  // `/orders/TKT-8F3KQ2XA` is a route; `/assets/app.js` is a file that is not
  // there. Only the path is inspected, never the query string.
  const path = request.url.split('?')[0] ?? '';
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
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

  // Read once at startup rather than per request — the file does not change
  // between deploys, and re-reading a few hundred bytes from disk on every
  // event view is work `injectEventPreview` has no reason to wait on.
  indexHtmlTemplate = await readFile(path.join(STOREFRONT_ROOT, 'index.html'), 'utf8');

  // Ahead of the not-found fallback that would otherwise answer this path
  // with the same generic document every other route gets — see the
  // "Per-event link previews" section above for why this one needs its own
  // route instead.
  app.get<{ Params: { slug: string } }>('/events/:slug', sendEventPreview);

  /**
   * The icon, for pages that cannot carry it inline.
   *
   * `index.html` declares the favicon as a data URI precisely so there is
   * nothing to request — but that only covers documents we author. The proxied
   * Firebase auth pages are Google's markup with no icon link of ours in them,
   * so the browser falls back to `/favicon.ico` and gets a 404 in the middle of
   * the sign-in flow. Harmless, and it sat in the console next to the errors
   * that were not, which is its own cost when someone is debugging sign-in.
   *
   * The same mark as the inline one, served as SVG. Browsers have accepted an
   * SVG at this path for years, and the alternative is committing a binary.
   */
  const FAVICON =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<mask id="n"><rect width="32" height="32" fill="white"/>` +
    `<circle cx="0" cy="16" r="5" fill="black"/>` +
    `<circle cx="32" cy="16" r="5" fill="black"/></mask>` +
    `<rect width="32" height="32" rx="9" fill="#0B5FD9" mask="url(#n)"/>` +
    `<circle cx="16" cy="11" r="1.6" fill="#001B3E"/>` +
    `<circle cx="16" cy="16" r="1.6" fill="#001B3E"/>` +
    `<circle cx="16" cy="21" r="1.6" fill="#001B3E"/></svg>`;

  app.get('/favicon.ico', async (_request, reply) =>
    reply
      .type('image/svg+xml')
      .header('cache-control', 'public, max-age=604800')
      .send(FAVICON),
  );

  enabled = true;
  logger.info({ root: STOREFRONT_ROOT }, 'serving the storefront');
  return true;
}
