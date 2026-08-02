import { LIMITS } from '../config/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TERMS_VERSION, acceptanceIsCurrent } from '../lib/consent.js';
import { enqueueNotification } from '../queue/queues.js';
import { boundedText, emailAddress, mpesaPhone } from '../lib/validation.js';
import { requireUser } from '../plugins/auth.js';
import {
  confirmSubscription,
  subscribe,
  unsubscribe,
} from '../services/subscribers.service.js';
import {
  deleteAccount,
  getOrdersForUser,
  recordSignIn,
  setAnnouncementsOptIn,
  updateProfile,
} from '../services/users.service.js';

// ---------------------------------------------------------------------------
// Optional buyer accounts, and the announcement list.
//
// Nothing here is on the purchase path. A buyer can complete a checkout, receive
// tickets and get through the gate without ever touching these routes — which is
// why every one of them may return 503 when accounts are not configured, and none
// of that affects a sale.
// ---------------------------------------------------------------------------

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // ─── Session ────────────────────────────────────────────────────────────
  //
  // Called by the client after Firebase reports a successful sign-in. Creates the
  // local mirror row on first sight and re-syncs email and verification state on
  // every call, since both change in Firebase without this service being told.
  //
  // Also where past guest orders get attached, so a buyer who bought before
  // registering finds their tickets waiting.
  app.post(
    '/api/account/session',
    {
      preHandler: requireUser,
      // Tight: one call per sign-in is all a client needs, and this writes.
      config: { rateLimit: LIMITS.signIn },
    },
    async (request) => {
      const result = await recordSignIn(request.user!);

      /**
       * Once, on the sign-in that created the account — and queued, not sent.
       *
       * This used to be `void sendWelcomeEmail(...).catch(log)`, which meant a
       * provider that was briefly unreachable lost the welcome permanently:
       * nothing retried it and nothing recorded that a buyer never got one.
       * That is exactly what happened while Brevo was rejecting our IP. Every
       * other email here goes through the queue and retries; this was the one
       * exception, and the exception is the one that broke.
       *
       * Still never allowed to fail the sign-in: enqueueing is cheap, but a
       * Redis hiccup must not turn a successful sign-in into an error.
       */
      if (result.created) {
        void enqueueNotification({
          kind: 'account-welcome',
          userId: result.user.id,
          email: result.user.email,
          displayName: result.user.displayName,
        }).catch((error: unknown) => {
          request.log.warn({ err: error }, 'could not queue the welcome email');
        });
      }

      return {
        user: {
          email: result.user.email,
          emailVerified: result.user.emailVerified,
          displayName: result.user.displayName,
          phone: result.user.phone,
          announcementsOptIn: result.user.announcementsOptIn,
        },
        created: result.created,
        linkedOrders: result.linkedOrders,
        /**
         * Whether this account has accepted the terms currently in force.
         *
         * False for an account created before consent was captured, and false
         * again after the notice is revised. The client uses it to prompt, not
         * to lock anyone out — re-consent is a question, and someone who has
         * not answered it yet still owns their tickets.
         */
        termsAccepted: acceptanceIsCurrent(result.user.termsVersion),
        termsVersion: TERMS_VERSION,
        // Stated explicitly so a client can prompt for verification: without it,
        // past guest orders stay unclaimed.
        verificationRequiredToLinkOrders: !result.user.emailVerified,
      };
    },
  );

  app.get('/api/account/me', { preHandler: requireUser }, async (request) => {
    const subject = request.user!;
    return {
      user: {
        email: subject.email,
        emailVerified: subject.emailVerified,
        displayName: subject.displayName,
        signInProvider: subject.signInProvider,
      },
    };
  });

  /**
   * The buyer's own orders.
   *
   * Scoped by uid from the verified token, with no id accepted from the caller,
   * so there is no parameter to tamper with — a buyer cannot ask for somebody
   * else's orders because there is nowhere to put the request.
   */
  app.get('/api/account/orders', { preHandler: requireUser }, async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .strict()
      .parse(request.query ?? {});

    return { orders: await getOrdersForUser(request.user!.uid, limit) };
  });

  app.patch(
    '/api/account/me',
    { preHandler: requireUser, config: { rateLimit: LIMITS.accountWrite } },
    async (request) => {
    const body = z
      .object({
        displayName: boundedText(1, 120).optional(),
        phone: mpesaPhone.optional(),
        /**
         * Accept the current terms and privacy notice.
         *
         * Only `true` is meaningful. Consent cannot be withdrawn by sending
         * `false` here — withdrawal of the terms is closing the account, which
         * has its own endpoint, and accepting a `false` would quietly erase
         * evidence of a consent that was genuinely given.
         */
        acceptTerms: z.literal(true).optional(),
      })
      .strict()
      .parse(request.body ?? {});

    const updated = await updateProfile(request.user!.uid, body);
    return {
      user: { displayName: updated.displayName, phone: updated.phone },
    };
  });

  /**
   * Closes the buyer's own account.
   *
   * `requireUser` verifies the ID token, so the account being deleted is always
   * the caller's own — there is no id in the path to tamper with, which is the
   * simplest way to make this impossible to point at somebody else.
   *
   * Tickets and orders survive; only the profile does. See `deleteAccount` for
   * why that split is deliberate rather than an oversight.
   */
  app.delete(
    '/api/account/me',
    { preHandler: requireUser, config: { rateLimit: LIMITS.accountWrite } },
    async (request, reply) => {
    await deleteAccount(request.user!.uid);
    request.log.warn({ uid: request.user!.uid }, 'account deleted at user request');
    return reply.status(204).send();
  });

  app.put(
    '/api/account/announcements',
    { preHandler: requireUser, config: { rateLimit: LIMITS.accountWrite } },
    async (request) => {
      const { optIn } = z
        .object({ optIn: z.boolean() })
        .strict()
        .parse(request.body ?? {});

      const updated = await setAnnouncementsOptIn(request.user!.uid, optIn);
      return { announcementsOptIn: updated.announcementsOptIn };
    },
  );

  // ─── Announcement list, no account needed ───────────────────────────────

  app.post(
    '/api/subscribe',
    {
      // Public and unauthenticated, so it is the most abusable endpoint here:
      // a loose limit turns it into a way to send confirmation mail at strangers.
      config: { rateLimit: LIMITS.subscribe },
    },
    async (request) => {
      const { email } = z
        .object({ email: emailAddress })
        .strict()
        .parse(request.body ?? {});

      const result = await subscribe(email, 'signup-form');

      // The token is deliberately never returned to the caller. It is the proof
      // of inbox control, so it travels only by email; returning it over HTTP
      // would defeat the point of double opt-in. Delivery is handled out of
      // band — see the internal integration notes.
      if (result.confirmToken) {
        request.log.info(
          { email, status: result.status },
          'subscription pending confirmation',
        );
      }

      // One response shape regardless of prior state, so this cannot be used to
      // probe whether an address is already on the list.
      return {
        status: 'ok',
        message: 'Check your inbox to confirm your subscription.',
      };
    },
  );

  const tokenParam = z
    .object({
      // base64url, as minted by crypto.randomBytes(32).
      token: z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict();

  app.get('/api/subscribe/confirm/:token', async (request) => {
    const { token } = tokenParam.parse(request.params);
    const subscriber = await confirmSubscription(token);
    return { status: 'confirmed', email: subscriber.email };
  });

  /**
   * Unsubscribe. Available as GET as well as POST because mail clients render a
   * link, and a one-click opt-out is both a deliverability requirement and the
   * decent thing to offer.
   *
   * Always reports success. A crawler prefetching the link must not learn whether
   * the token matched anything.
   */
  const handleUnsubscribe = async (request: { params: unknown }) => {
    const { token } = tokenParam.parse(request.params);
    await unsubscribe(token);
    return { status: 'unsubscribed' };
  };

  app.get('/api/subscribe/unsubscribe/:token', handleUnsubscribe);
  app.post('/api/subscribe/unsubscribe/:token', handleUnsubscribe);
}
