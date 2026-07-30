import { describe, expect, it } from 'vitest';
import { isValidPhone, maskPhone, normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['0712 345 678', '254712345678'],
    ['+254 712-345-678', '254712345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['0812345678'], // 8 is not a valid Kenyan mobile prefix
    ['071234567'], // too short
    ['07123456789'], // too long
    ['not a phone'],
    [''],
  ])('rejects %s', (input) => {
    expect(() => normalizePhone(input)).toThrow();
    expect(isValidPhone(input)).toBe(false);
  });
});

describe('maskPhone', () => {
  it('hides the middle digits', () => {
    expect(maskPhone('254712345678')).toBe('254712***678');
  });
});
