import { describe, expect, it } from 'vitest';
import {
  buildQrPayload,
  generateOrderReference,
  generateTicketCode,
  parseQrPayload,
} from './codes.js';

describe('generated codes', () => {
  it('produces a prefixed order reference', () => {
    expect(generateOrderReference()).toMatch(/^TKT-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('produces a grouped ticket code with no ambiguous characters', () => {
    const code = generateTicketCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // I, L, O and U are excluded so codes can't be misread at the gate.
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('does not repeat across many draws', () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => generateTicketCode()));
    expect(codes.size).toBe(2_000);
  });
});

describe('QR signing', () => {
  it('round-trips a signed payload', () => {
    const code = generateTicketCode();
    expect(parseQrPayload(buildQrPayload(code))).toBe(code);
  });

  it('rejects a payload whose code was tampered with', () => {
    const code = generateTicketCode();
    const payload = buildQrPayload(code);
    const forged = `ZZZZ-ZZZZ-ZZZZ.${payload.split('.')[1]}`;
    expect(parseQrPayload(forged)).toBeNull();
  });

  it('rejects a payload with a forged signature', () => {
    const code = generateTicketCode();
    expect(parseQrPayload(`${code}.aaaaaaaaaaaaaaaaaaaaaaaaaaa`)).toBeNull();
  });

  it('rejects a bare code on the scan path', () => {
    // The regression that matters. An unsigned payload used to be returned as
    // valid, which meant the signature check was skipped by anyone who simply
    // did not supply a signature.
    const code = generateTicketCode();
    expect(parseQrPayload(code)).toBeNull();
    expect(parseQrPayload(code, { allowUnsigned: false })).toBeNull();
  });

  it('accepts a bare code typed in manually at the gate', () => {
    const code = generateTicketCode();
    expect(parseQrPayload(code, { allowUnsigned: true })).toBe(code);
  });

  it('still verifies a signature that is present, even on the manual path', () => {
    // `allowUnsigned` permits an absent signature; it does not excuse a wrong
    // one. Otherwise a forged payload would pass by claiming to be typed.
    const code = generateTicketCode();
    expect(
      parseQrPayload(`${code}.aaaaaaaaaaaaaaaaaaaaaaaaaaa`, { allowUnsigned: true }),
    ).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseQrPayload('')).toBeNull();
  });
});
