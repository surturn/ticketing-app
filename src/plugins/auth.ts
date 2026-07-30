import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Two kinds of caller:
//
//   * admin — a static API key held by the event organiser's dashboard.
//   * scanner — a short-lived JWT minted by an admin and handed to gate staff,
//     scoped to one event. Staff phones are lost and shared, so these expire.
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
