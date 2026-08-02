import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { env, firebaseConfigured } from '../config/env.js';
import { cacheRedis } from '../lib/redis.js';
import { AppError, forbidden, serviceUnavailable, unauthorized } from '../lib/errors.js';
import {
  bearerToken,
  verifyIdToken,
  type AuthenticatedUser,
} from '../lib/firebase.js';
import { scopeForUser, type AdminScope } from '../services/tenancy.service.js';

// ---------------------------------------------------------------------------
// Three kinds of caller, deliberately unable to impersonate each other:
//
//   * admin — a static API key in `x-api-key`, held by the organiser dashboard.
//   * scanner — a short-lived JWT minted by an admin and handed to gate staff,
//     scoped to one event. Staff phones are lost and shared, so these expire.
//   * buyer — a Firebase ID token, for optional accounts.
//
// Scanner and buyer tokens share the `Authorization: Bearer` header, which is
// safe because they cannot satisfy each other's verifier: scanner tokens are
// HS256 signed with SCANNER_JWT_SECRET, buyer tokens are RS256 signed by Google
// for a specific Firebase project. A buyer token handed to `requireScanner`
// fails the signature check; a scanner token handed to `requireUser` fails the
// issuer check. Neither path can be reached with the other's credential, and
// buyer identity is never consulted for authorisation on admin routes.
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Whether a verified buyer token belongs to someone on the admin allowlist.
 *
 * Three conditions, all required. The allowlist must be configured at all; the
 * token must have already been verified by Firebase for this project; and the
 * address must be marked verified by the provider — an unverified one proves
 * nothing, because anyone can type somebody else's address into a sign-up form
 * and an allowlist checked against it would hand over the shortcode.
 */
function isAllowlistedAdmin(user: AuthenticatedUser): boolean {
  if (env.ADMIN_EMAILS.length === 0) return false;
  if (!user.emailVerified || !user.email) return false;
  return env.ADMIN_EMAILS.includes(user.email.toLowerCase());
}

export async function requireAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // The API key remains the primary path: it is what the dashboard falls back
  // to, and what a deployment with no allowlist uses exclusively.
  const provided = request.headers['x-api-key'];
  if (typeof provided === 'string' && safeEqual(provided, env.ADMIN_API_KEY)) {
    // The shared key is platform-wide, as it has always been. Stated here as a
    // scope rather than left implicit, so the routes downstream read the same
    // way for both kinds of caller.
    request.adminScope = { kind: 'platform' };
    return;
  }

  /**
   * Otherwise, an allowlisted account signed in as itself.
   *
   * Checked second and never in place of signature verification: the token is
   * put through the same `verifyIdToken` a buyer's is, so a forged or expired
   * one fails here exactly as it would anywhere else. The allowlist decides
   * *which* verified identity is an administrator, never whether the identity
   * is real.
   */
  const token = bearerToken(request.headers.authorization);
  if (token && firebaseConfigured && env.ADMIN_EMAILS.length > 0) {
    try {
      const user = await verifyIdToken(token);
      if (isAllowlistedAdmin(user)) {
        /**
         * Allowlisted, and therefore an administrator — of something.
         *
         * Membership decides what. An address on the allowlist with no
         * organisation has proved who it is and has nothing to manage, which is
         * a 403 rather than a 401: retrying with a better token will not help,
         * and saying "sign in" to somebody already signed in sends them round a
         * loop.
         */
        const scope = await scopeForUser(user.uid);
        if (!scope) {
          throw forbidden(
            'This account is not a member of any organisation. Ask an owner to add you.',
          );
        }

        request.user = user;
        request.adminScope = scope;
        return;
      }
    } catch {
      // Fall through to the same error an absent credential gets. Saying which
      // of the two paths failed would tell an attacker which one to work on.
    }
  }

  throw unauthorized('A valid x-api-key header, or an admin account, is required');
}

/**
 * Who performed an administrative action, for the ledger.
 *
 * The hash chain proves an entry was not altered after the fact. It cannot say
 * who wrote it, and every entry said `admin` — so a void, a price change or a
 * reopened sale was attributable to "whoever holds the key", which is everyone
 * with the dashboard open. Integrity was covered; attribution was not, and
 * attribution is the half somebody asks about afterwards.
 *
 * An allowlisted account signs its own actions. The shared key cannot be
 * resolved to a person by definition, so it says so plainly rather than
 * implying an identity it does not have.
 */
export function adminActor(request: FastifyRequest): string {
  return request.user?.email ? `admin:${request.user.email}` : 'admin:api-key';
}

// ─── Scanner tokens ────────────────────────────────────────────────────────

export interface ScannerClaims {
  role: 'scanner';
  eventId: string;
  gate: string;
  /** This token's own id, so one device can be shut out without the rest. */
  jti: string;
}

const scannerSecret = new TextEncoder().encode(env.SCANNER_JWT_SECRET);

/**
 * Redis key for a revoked scanner token.
 *
 * Namespaced under the configured prefix like everything else, so a shared
 * Redis between environments cannot have one deployment's revocations silently
 * apply to another's tokens.
 */
const revokedKey = (jti: string) => `${env.REDIS_PREFIX}:scanner:revoked:${jti}`;

export async function mintScannerToken(
  eventId: string,
  gate: string,
  ttlHours = 12,
): Promise<{ token: string; expiresAt: Date; jti: string }> {
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  /**
   * A per-token id, which is what makes revocation possible at all.
   *
   * Without one, the only way to shut out a phone left in a taxi is to rotate
   * `SCANNER_JWT_SECRET` — which invalidates every gate at the same venue,
   * mid-event, and is precisely the sort of remedy nobody reaches for while a
   * queue is forming. A `jti` turns that into one line in a denylist.
   */
  const jti = crypto.randomUUID();

  const token = await new SignJWT({ role: 'scanner', eventId, gate })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(scannerSecret);

  return { token, expiresAt, jti };
}

/**
 * Shuts out one scanner token.
 *
 * The denylist entry expires when the token would have anyway. A revocation
 * has no meaning past that point — the signature stops being accepted on its
 * own — so keeping the key would only grow the set forever.
 *
 * `ttlSeconds` is derived from the token's own expiry by the caller. A token
 * already past expiry is accepted here and simply writes nothing.
 */
export async function revokeScannerToken(
  jti: string,
  ttlSeconds: number,
): Promise<{ revoked: boolean }> {
  if (ttlSeconds <= 0) return { revoked: false };
  await cacheRedis.set(revokedKey(jti), '1', 'EX', Math.ceil(ttlSeconds));
  return { revoked: true };
}

declare module 'fastify' {
  interface FastifyRequest {
    scanner?: ScannerClaims;
    user?: AuthenticatedUser;
    /** Set by `requireAdmin`, so every admin route has one by construction. */
    adminScope?: AdminScope;
  }
}

// ─── Buyer accounts ────────────────────────────────────────────────────────

/**
 * Requires a signed-in buyer.
 *
 * Rejects rather than ignores a bad token: these routes exist only to return one
 * person's own data, so proceeding anonymously would be worse than failing.
 */
export async function requireUser(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!firebaseConfigured) {
    throw serviceUnavailable(
      'accounts_not_configured',
      'Buyer accounts are not available on this server',
    );
  }

  const token = bearerToken(request.headers.authorization);
  if (!token) {
    throw unauthorized('Sign in to continue');
  }

  request.user = await verifyIdToken(token);
}

/**
 * Attaches a buyer if one is signed in, and proceeds regardless.
 *
 * For endpoints that work either way — checkout above all. A malformed or expired
 * token must never fail a purchase, so a verification failure here is logged and
 * discarded, and the request continues as a guest. That is the difference from
 * `requireUser`: this one cannot turn an auth problem into a lost sale.
 */
export async function optionalUser(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!firebaseConfigured) return;

  const token = bearerToken(request.headers.authorization);
  if (!token) return;

  try {
    request.user = await verifyIdToken(token);
  } catch {
    // Genuinely ignored. A buyer whose session lapsed mid-checkout still gets
    // their tickets; the order is simply recorded as a guest purchase.
    request.log.debug('ignoring an invalid token on an optional-auth route');
  }
}

/**
 * Accepts a scanner JWT, or an admin API key as an override — an organiser
 * standing at the gate with the dashboard open should not be locked out.
 */
export async function requireScanner(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && safeEqual(apiKey, env.ADMIN_API_KEY)) {
    return;
  }

  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('A scanner token is required');
  }

  let claims: ScannerClaims;

  try {
    const { payload } = await jwtVerify(header.slice(7), scannerSecret);
    if (payload.role !== 'scanner') {
      throw unauthorized('That token is not a scanner token');
    }
    if (!payload.jti) {
      // Minted before tokens carried an id. Refused rather than trusted: an
      // unrevocable credential at a gate is exactly what this is meant to end,
      // and the fix is to issue a new one, which takes seconds.
      throw unauthorized('That scanner token predates revocation support');
    }
    claims = {
      role: 'scanner',
      eventId: String(payload.eventId),
      gate: String(payload.gate ?? 'main'),
      jti: String(payload.jti),
    };
  } catch {
    throw unauthorized('Scanner token is invalid or has expired');
  }

  /**
   * Checked after the signature, and outside the try above.
   *
   * Outside, because a Redis failure must not be swallowed by the same catch
   * that reports a bad signature — those are different problems and conflating
   * them would have a Redis outage look like a forged token to whoever is
   * standing at the door.
   *
   * The check fails *open* on a Redis error. That is the opposite of the
   * webhook token's rule, and deliberately so: the credential here has already
   * been cryptographically verified and is short-lived, the failure mode of
   * closing is a queue of paying guests who cannot get into an event, and a
   * revoked device is a narrower risk than a gate that stops working.
   */
  try {
    if (await cacheRedis.get(revokedKey(claims.jti))) {
      throw unauthorized('That scanner token has been revoked');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    request.log.error({ err: error }, 'could not check scanner revocation; allowing');
  }

  request.scanner = claims;
}
