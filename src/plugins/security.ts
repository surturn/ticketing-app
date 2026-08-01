import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import { env, isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Response security headers.
//
// The storefront and the API share one origin, so one policy has to serve both.
// That is mostly a simplification — the strict directives a JSON API wants are
// the same ones a single-page app wants, with the exception of the sources it
// legitimately loads.
// ---------------------------------------------------------------------------

const STOREFRONT_INDEX = path.resolve(process.cwd(), 'web', 'dist', 'index.html');

/**
 * SHA-256 hashes of the inline scripts in the entry document.
 *
 * The storefront has exactly one: the theme bootstrap, which must run before
 * first paint or a light-mode visitor gets a dark flash on every load. It
 * cannot be moved to a file without either that flash or an extra blocking
 * request.
 *
 * So it is allowed by hash rather than by `'unsafe-inline'`. The difference is
 * the whole value of the policy: a hash permits exactly this script and nothing
 * else, whereas `'unsafe-inline'` permits any script an attacker manages to
 * inject, which is the thing being defended against.
 *
 * Computed at boot from the file actually being served, so it cannot drift out
 * of step with the build. Edit the script and the hash follows automatically;
 * hardcode it and the page silently breaks on the next change.
 */
function inlineScriptHashes(): string[] {
  if (!existsSync(STOREFRONT_INDEX)) return [];

  const html = readFileSync(STOREFRONT_INDEX, 'utf8');
  const hashes: string[] = [];

  // Only scripts with no `src` — those are the inline ones.
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1];
    if (!body) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }

  return hashes;
}

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  const scriptHashes = inlineScriptHashes();

  if (scriptHashes.length > 0) {
    logger.info(
      { count: scriptHashes.length },
      'allowing inline storefront scripts by hash',
    );
  }

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],

        /**
         * Bundled JavaScript, the theme bootstrap by hash, and gstatic.
         *
         * No `'unsafe-inline'` and no `'unsafe-eval'`. gstatic is where the
         * Firebase Auth widgets load their helpers from during a popup sign-in;
         * omitting it produces a sign-in that fails only for some providers,
         * which is a worse bug than the narrow allowance it avoids.
         */
        scriptSrc: ["'self'", 'https://www.gstatic.com', 'https://apis.google.com', ...scriptHashes],

        /**
         * Styles need `'unsafe-inline'`, and this is a considered trade.
         *
         * React writes `style={{…}}` as a style attribute, and several
         * components set custom properties that way — the poster tone, the
         * marquee bulbs, the countdown ring's stroke offset. Hashing is not
         * available for attributes.
         *
         * Inline *style* is a far smaller risk than inline script: it cannot
         * execute, and the exfiltration tricks it enables are blocked here by
         * `img-src` and `connect-src` already being restricted.
         */
        styleSrc: ["'self'", "'unsafe-inline'"],

        /**
         * Posters come from two places: our own R2 bucket, and any https URL an
         * organiser pastes into the event form. The second is why this cannot
         * be an allowlist — it would have to name every image host in Kenya.
         *
         * `data:` covers the inlined favicon.
         */
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],

        // Self-hosted, so no font CDN needs allowing.
        fontSrc: ["'self'"],

        /**
         * Where the page may send requests. Our own origin, plus the Firebase
         * endpoints sign-in actually talks to — named individually rather than
         * allowing `*.googleapis.com`, which would also permit a great many
         * services this app has no business reaching.
         */
        connectSrc: [
          "'self'",
          'https://identitytoolkit.googleapis.com',
          'https://securetoken.googleapis.com',
          'https://www.googleapis.com',
          'https://firebaseinstallations.googleapis.com',
        ],

        // Google's sign-in popup renders in an iframe on its own domain.
        frameSrc: ["'self'", 'https://accounts.google.com', `https://${env.FIREBASE_PROJECT_ID ?? ''}.firebaseapp.com`].filter(
          (source) => !source.endsWith('.firebaseapp.com') || env.FIREBASE_PROJECT_ID,
        ),

        // Nothing here needs Flash, Java, or a plugin of any kind.
        objectSrc: ["'none'"],

        // Stops an injected `<base>` silently repointing every relative URL on
        // the page at somebody else's server.
        baseUri: ["'self'"],

        // Forms post to our own origin and nowhere else.
        formAction: ["'self'"],

        // Nobody may frame us. This is the clickjacking defence, and it is
        // strictly stronger than the X-Frame-Options header it supersedes.
        frameAncestors: ["'none'"],

        // Belt and braces behind HSTS: no subresource may load over plain http.
        ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },

    /**
     * A year, including subdomains, and preload-eligible.
     *
     * Only meaningful in production. Setting it in development would pin
     * localhost to https in the developer's browser for a year, which is a
     * genuinely unpleasant thing to debug.
     */
    hsts: isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,

    // Referrers leak URLs. Same-origin navigations keep the full path; anything
    // leaving the site sends the origin only, and never over a downgrade.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // Stops a browser second-guessing a Content-Type. Without it, a file we
    // serve as text could be sniffed as script.
    noSniff: true,

    /**
     * Off, deliberately.
     *
     * `Cross-Origin-Embedder-Policy: require-corp` would block every poster
     * that is not served with an explicit CORP header — which is every poster
     * an organiser links from a host we do not control.
     */
    crossOriginEmbedderPolicy: false,

    // Allows the storefront to display images from R2 and elsewhere.
    crossOriginResourcePolicy: { policy: 'cross-origin' },

    // Sign-in opens a popup and needs to talk to it.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },

    // The version is not a secret, but it is free reconnaissance.
    hidePoweredBy: true,
  });

  /**
   * Features this application never uses, switched off for anything it loads.
   *
   * Helmet does not set this one, and it is worth having: it means a compromised
   * dependency cannot quietly ask for the microphone or a location fix, because
   * the browser refuses before the user is ever prompted.
   */
  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'Permissions-Policy',
      [
        'accelerometer=()',
        'camera=()',
        'geolocation=()',
        'gyroscope=()',
        'magnetometer=()',
        'microphone=()',
        'payment=()',
        'usb=()',
        'interest-cohort=()',
      ].join(', '),
    );
  });
}
