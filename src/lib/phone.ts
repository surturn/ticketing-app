import { badRequest } from './errors.js';

// ---------------------------------------------------------------------------
// Kenyan MSISDN normalisation.
//
// Everything is stored and sent to Daraja as 2547XXXXXXXX / 2541XXXXXXXX.
// Normalising on the way in means a buyer who typed 0712… and one who typed
// +254712… resolve to the same order lookup.
// ---------------------------------------------------------------------------

const KENYAN_MSISDN = /^254(?:7|1)\d{8}$/;

export function normalizePhone(input: string): string {
  const digits = String(input ?? '').replace(/\D/g, '');

  let normalized = digits;

  if (normalized.startsWith('254')) {
    // already in international form
  } else if (normalized.startsWith('0')) {
    normalized = `254${normalized.slice(1)}`;
  } else if (normalized.length === 9) {
    // bare subscriber number, e.g. 712345678
    normalized = `254${normalized}`;
  }

  if (!KENYAN_MSISDN.test(normalized)) {
    throw badRequest(
      `"${input}" is not a valid Kenyan phone number. Use 07XXXXXXXX, 01XXXXXXXX or 2547XXXXXXXX.`,
    );
  }

  return normalized;
}

export function isValidPhone(input: string): boolean {
  try {
    normalizePhone(input);
    return true;
  } catch {
    return false;
  }
}

/** 254712345678 → 0712…5678. Used in admin views and receipts. */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 6)}***${phone.slice(-3)}`;
}
