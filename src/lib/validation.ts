import { z } from 'zod';
import { normalizePhone } from './phone.js';

// ---------------------------------------------------------------------------
// Shared input primitives.
//
// Every one of these trims and normalises as part of parsing, so a service
// never receives a value it still has to clean. The alternative — validate at
// the edge, sanitise in the service — means two places to forget.
//
// Queries are parameterised by Drizzle throughout, so these guards exist for a
// different class of problem: control characters in a buyer's name reaching an
// email header, oversized metadata blobs, invisible characters producing
// lookalike duplicates, and unbounded strings reaching the log pipeline.
// ---------------------------------------------------------------------------

// C0/C1 control ranges and DEL. These arrive through copy-paste far more often
// than through malice, but a bare CR or LF in a name becomes a header injection
// the moment it is interpolated into an email.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

// Zero-width and bidi-override characters: invisible, and used to make two
// different strings render identically.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

/** Strips control and invisible characters, then collapses whitespace runs. */
function cleanText(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A human-facing free-text field: cleaned, then bounded.
 *
 * Length is checked *after* cleaning, so a value made entirely of control
 * characters is rejected rather than silently becoming an empty string.
 */
export const boundedText = (min: number, max: number) =>
  z
    .string()
    .max(max * 4, 'unreasonably long') // cheap guard before doing any work
    .transform(cleanText)
    .refine((value) => value.length >= min, `must be at least ${min} character(s)`)
    .refine((value) => value.length <= max, `must be at most ${max} characters`);

/**
 * Everything `cleanText` removes, except the line breaks.
 *
 * `cleanText` is right for a name or a venue: those are one line, and a bare CR
 * or LF in one becomes a header injection the moment it is interpolated into an
 * email. It is wrong for a description, where the breaks *are* the content —
 * running it over an event blurb deleted every paragraph boundary the organiser
 * typed and glued the last word of one line to the first of the next.
 *
 * So line breaks survive here, and nothing else does. A description is only
 * ever rendered into a page body, never into a header, which is what makes the
 * distinction safe rather than merely convenient.
 */
function cleanMultilineText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // The same control range as `CONTROL_CHARS`, with \n carved out.
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
      .replace(INVISIBLE_CHARS, '')
      // Spaces and tabs collapse; newlines do not.
      .replace(/[^\S\n]+/g, ' ')
      // Trailing spaces before a break, which paste leaves behind constantly.
      .replace(/ *\n */g, '\n')
      // Three or more blank lines is someone's formatting accident, not intent.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * A multi-line free-text field: cleaned, but with its paragraphs intact.
 *
 * Length is checked after cleaning, as above, so a value made entirely of
 * whitespace is rejected rather than becoming an empty string.
 */
export const boundedMultilineText = (min: number, max: number) =>
  z
    .string()
    .max(max * 4, 'unreasonably long')
    .transform(cleanMultilineText)
    .refine((value) => value.length >= min, `must be at least ${min} character(s)`)
    .refine((value) => value.length <= max, `must be at most ${max} characters`);

/**
 * Buyer name. Rejects strings containing no letter at all — "...", "123", a
 * lone emoji — which is the usual shape of a junk submission.
 */
export const personName = boundedText(2, 120).refine(
  (value) => /\p{L}/u.test(value),
  'must contain at least one letter',
);

/**
 * Email, lowercased. Zod's `.email()` is deliberately permissive; the refinements
 * below reject shapes that pass it but can never receive mail.
 */
export const emailAddress = z
  .string()
  .max(254, 'must be at most 254 characters') // RFC 5321 limit
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().email('must be a valid email address'))
  .refine((value) => !value.includes('..'), 'must not contain consecutive dots')
  .refine((value) => {
    const domain = value.split('@')[1] ?? '';
    // A domain with no dot is either a local alias or a typo; neither is
    // reachable from the public internet.
    return domain.includes('.') && !domain.startsWith('-') && !domain.endsWith('-');
  }, 'must have a valid domain');

/**
 * Kenyan M-Pesa number, normalised to 2547XXXXXXXX / 2541XXXXXXXX.
 *
 * Normalising here rather than in the service means the value stored in the
 * database and the value sent to Daraja are the same string by construction.
 */
export const mpesaPhone = z
  .string()
  .min(9, 'must be at least 9 digits')
  .max(20, 'must be at most 20 characters')
  .transform((value, ctx) => {
    try {
      return normalizePhone(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error
            ? error.message
            : 'must be a valid Kenyan mobile number',
      });
      return z.NEVER;
    }
  });

/**
 * Caller-supplied metadata. Bounded in breadth, depth and serialised size —
 * this lands in a jsonb column and in logs, and an unbounded object is a cheap
 * way to bloat both.
 */
export const boundedMetadata = z
  .record(z.unknown())
  .refine((value) => Object.keys(value).length <= 20, 'must have at most 20 keys')
  .refine(
    (value) => JSON.stringify(value).length <= 4096,
    'must serialise to at most 4096 bytes',
  )
  .refine((value) => {
    // Deep structures have no legitimate use here and make the jsonb expensive
    // to scan. The recursion is bounded by the early return at level 4, so a
    // maliciously deep object cannot blow the stack before being rejected.
    const depth = (node: unknown, level = 0): number => {
      if (level > 4 || node === null || typeof node !== 'object') return level;
      const children = Object.values(node as Record<string, unknown>);
      if (children.length === 0) return level;
      return Math.max(...children.map((child) => depth(child, level + 1)));
    };
    return depth(value) <= 3;
  }, 'must not nest more than 3 levels deep');

/** An Idempotency-Key header: opaque, but bounded and printable. */
export const idempotencyKey = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(200, 'must be at most 200 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'may contain only letters, digits and . _ : -');
