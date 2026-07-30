import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { env, firebaseConfigured } from '../config/env.js';
import { serviceUnavailable, unauthorized } from '../lib/errors.js';
import {
  bearerToken,
  verifyIdToken,
  type AuthenticatedUser,
} from '../lib/firebase.js';

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

export async function requireAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const provided = request.headers['x-api-key'];

  if (typeof provided !== 'string' || !safeEqual(provided, env.ADMIN_API_KEY)) {
    throw unauthorized('A valid x-api-key header is required');
  }
}

// ─── Scanner tokens ────────────────────────────────────────────────────────

export interface ScannerClaims {
  role: 'scanner';
  eventId: string;
  gate: string;
}

const scannerSecret = new TextEncoder().encode(env.SCANNER_JWT_SECRET);

export async function mintScannerToken(
  eventId: string,
  gate: string,
  ttlHours = 12,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  const token = await new SignJWT({ role: 'scanner', eventId, gate })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(scannerSecret);

  return { token, expiresAt };
}

declare module 'fastify' {
  interface FastifyRequest {
    scanner?: ScannerClaims;
    user?: AuthenticatedUser;
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

  try {
    const { payload } = await jwtVerify(header.slice(7), scannerSecret);
    if (payload.role !== 'scanner') {
      throw unauthorized('That token is not a scanner token');
    }
    request.scanner = {
      role: 'scanner',
      eventId: String(payload.eventId),
      gate: String(payload.gate ?? 'main'),
    };
  } catch {
    throw unauthorized('Scanner token is invalid or has expired');
  }
}
