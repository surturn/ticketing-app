import { badRequest } from './errors.js';

// Money is integer minor units everywhere in this codebase. These helpers are
// the only place conversion happens, so rounding can't drift between modules.

export function centsToMajor(cents: number): number {
  return cents / 100;
}

export function majorToCents(major: number): number {
  return Math.round(major * 100);
}

export function formatMoney(cents: number, currency = 'KES'): string {
  const major = centsToMajor(cents);
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(major);
}

/**
 * Daraja only accepts whole shillings — it silently truncates decimals, which
 * would settle an order for less than it is owed. Reject that at the boundary
 * instead of discovering the shortfall during reconciliation.
 */
export function centsToMpesaAmount(cents: number): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw badRequest('Amount must be a non-negative integer in cents');
  }
  if (cents % 100 !== 0) {
    throw badRequest(
      'M-Pesa can only charge whole shillings; order total must be a multiple of 100 cents',
    );
  }
  const shillings = cents / 100;
  if (shillings < 1) {
    throw badRequest('M-Pesa requires a minimum charge of KES 1');
  }
  return shillings;
}

export function mpesaAmountToCents(amount: number): number {
  return Math.round(amount * 100);
}
