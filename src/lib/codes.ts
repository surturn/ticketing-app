import crypto from 'node:crypto';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Human-facing codes.
//
// Crockford base32 — no I, L, O or U, so codes can't be misread off a phone
// screen at a noisy gate and can't accidentally spell anything.
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // Modulo bias is negligible here (256 % 32 === 0, so it is in fact zero).
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Order reference quoted by buyers in support, e.g. TKT-8F3KQ2XA. */
export function generateOrderReference(): string {
  return `TKT-${randomCode(8)}`;
}

/** Scannable ticket code, e.g. 7KQ2-8F3M-XA9P. ~1.1e18 keyspace. */
export function generateTicketCode(): string {
  const raw = randomCode(12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// ---------------------------------------------------------------------------
// QR signing.
//
// The QR encodes `<code>.<signature>`. The signature means a scanner can reject
// a forged code offline, and it stops anyone enumerating valid codes — but the
// database remains the authority on whether a ticket has already been used.
// ---------------------------------------------------------------------------

function sign(value: string): string {
  return crypto
    .createHmac('sha256', env.TICKET_SIGNING_SECRET)
    .update(value)
    .digest('base64url')
    .slice(0, 27); // 160 bits — ample, and keeps the QR small
}

export function buildQrPayload(code: string): string {
  return `${code}.${sign(code)}`;
}

export interface ParseQrOptions {
  /**
   * Accept a bare code carrying no signature.
   *
   * Only for a code a human typed at the gate when a scanner would not read the
   * badge. Never for a scanned payload: a scanner that produced no signature
   * produced something that did not come from us.
   */
  allowUnsigned?: boolean;
}

/**
 * Turns a scanned payload — or a manually typed code — into a ticket code.
 *
 * The signature is only a control if it cannot be declined. This used to return
 * the bare code whenever the payload contained no `.`, which meant an attacker
 * skipped verification by simply not supplying a signature: the check was
 * present, thorough, constant-time, and entirely optional. What actually kept
 * forged tickets out was the size of the code space, not the HMAC — and a
 * comment claiming otherwise is worse than no comment, because the next person
 * to shorten a code will read it and believe they are still covered.
 *
 * So the two ways a code arrives are now told apart by the caller rather than
 * inferred from the punctuation. A scan must verify. A typed code is accepted
 * on the operator's authority, which is a real and different thing, and is
 * recorded as such.
 */
export function parseQrPayload(
  payload: string,
  options: ParseQrOptions = {},
): string | null {
  const trimmed = String(payload ?? '').trim().toUpperCase();
  if (!trimmed) return null;

  const separator = trimmed.lastIndexOf('.');
  if (separator === -1) {
    // No signature present. Whether that is acceptable is the caller's to say.
    return options.allowUnsigned ? trimmed : null;
  }

  const code = trimmed.slice(0, separator);
  const signature = trimmed.slice(separator + 1);
  const expected = sign(code);

  // Base64url is case-sensitive, so compare against the untrimmed-case value.
  const provided = payload.trim().slice(separator + 1);

  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    return null;
  }

  return code;
}
