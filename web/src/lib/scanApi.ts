/**
 * The gate's one call: turn a code into an admission decision.
 *
 * Deliberately not routed through `adminApi.ts` — that module authenticates
 * with the organiser's shared key, and a scanner link must never carry that.
 * This carries only the narrow, event-scoped, expiring token the organiser
 * handed door staff, as a Bearer token rather than `x-api-key`.
 */
import { ApiError } from './api';

export interface CheckInResult {
  admitted: boolean;
  reason?: 'already_checked_in' | 'void' | 'order_not_paid';
  ticket: {
    code: string;
    holderName: string | null;
    tierName: string;
    eventId: string;
    status: string;
    checkedInAt: string | null;
    checkedInBy: string | null;
  };
}

export async function checkIn(
  token: string,
  body: { code: string; entry: 'scan' | 'manual' },
): Promise<CheckInResult> {
  let response: Response;
  try {
    response = await fetch('/api/checkin', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'network_unreachable',
      'Could not reach the server. Check your connection and try again.',
      true,
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error;
    throw new ApiError(
      response.status,
      String(error?.code ?? 'unknown'),
      String(error?.message ?? `Request failed (${response.status})`),
      error?.retryable === true,
    );
  }

  return payload as CheckInResult;
}

interface ScannerTokenClaims {
  eventId: string;
  gate: string;
  exp: number;
}

/**
 * Reads the gate name and expiry out of the token for display only.
 *
 * Not a verification — the signature is never checked here, because this
 * page has no secret to check it with. The server re-verifies on every
 * single call, which is the only check that actually gates anything; this
 * is purely so a device showing the wrong gate's name gets noticed before
 * the first ticket does.
 */
export function readScannerTokenClaims(token: string): ScannerTokenClaims | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
    const claims = JSON.parse(json) as Partial<ScannerTokenClaims>;
    if (typeof claims.eventId !== 'string' || typeof claims.gate !== 'string') return null;
    if (typeof claims.exp !== 'number') return null;
    return { eventId: claims.eventId, gate: claims.gate, exp: claims.exp };
  } catch {
    return null;
  }
}
