import { describe, expect, it } from 'vitest';
import { centsToMpesaAmount, majorToCents, mpesaAmountToCents } from './money.js';

describe('centsToMpesaAmount', () => {
  it('converts whole shillings', () => {
    expect(centsToMpesaAmount(250_000)).toBe(2_500);
  });

  it('refuses fractional shillings rather than silently truncating', () => {
    // Daraja would drop the 50 cents and settle the order short.
    expect(() => centsToMpesaAmount(250_050)).toThrow(/whole shillings/);
  });

  it('refuses amounts below the M-Pesa minimum', () => {
    expect(() => centsToMpesaAmount(0)).toThrow(/minimum/);
  });

  it('refuses negative amounts', () => {
    expect(() => centsToMpesaAmount(-100)).toThrow();
  });
});

describe('round-tripping', () => {
  it('survives major → cents → mpesa', () => {
    expect(centsToMpesaAmount(majorToCents(1_500))).toBe(1_500);
  });

  it('converts a gateway amount back to cents', () => {
    expect(mpesaAmountToCents(2_500)).toBe(250_000);
  });
});
