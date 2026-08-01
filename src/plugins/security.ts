import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import { env, isProduction } from '../config/env.js';

// ---------------------------------------------------------------------------
// Response security headers.
//
// The storefront and the API share one origin, so one policy has to serve both.
// That is mostly a simplification — the strict directives a JSON API wants are
// the same ones a single-page app wants, with the exception of the sources it
// legitimately loads.
// ---------------------------------------------------------------------------

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],

        /**
         * Bundled JavaScript and two Google origins. No inline scripts at all.
         *
         * The theme bootstrap used to be inline and allowed by hash. That could
         * not be made to work: Cloudflare rewrites the document in flight for
         * browser requests — injecting its analytics beacon, among other things
         * — so the bytes the server hashed were not the bytes the browser
         * parsed, and the policy rejected a script that was entirely legitimate.
         * It lives at `/theme.js` now and needs nothing but `'self'`.
         *
         * gstatic and apis.google.com are where the Firebase Auth popup loads
         * its helpers; omitting them breaks sign-in for some providers only,
         * which is a worse failure than the narrow allowance avoids.
         *
         * `cloudflareinsights.com` is deliberately *not* here. Cloudflare
         * injects that beacon on its own, and allowing it would make the
         * privacy notice untrue — it states plainly that we run no third-party
         * analytics. Blocking it keeps the page working and the notice honest;
         * turning the feature off in the Cloudflare dashboard removes the
         * console noise for good.
         */
        scriptSrc: ["'self'", 'https://www.gstatic.com', 'https://apis.google.com'],

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

        /**
         * Self-hosted, so no font CDN needs allowing — but `data:` does.
         *
         * Vite inlines assets under its size threshold as data URIs, and the
         * smaller font subsets fall under it. `'self'` alone blocked exactly
         * those, which is why some weights rendered and others silently fell
         * back to a system face.
         */
        fontSrc: ["'self'", 'data:'],

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
