import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, readLimited, sniffImageType } from './storage.js';

// ---------------------------------------------------------------------------
// The type check is the security boundary of the upload endpoint, so the cases
// that matter are the hostile ones: a file whose name and declared type say
// "image" while its bytes say something else entirely.
// ---------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
]);

describe('sniffImageType', () => {
  it('recognises the three accepted formats', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses SVG, whatever it is called', () => {
    // The whole reason SVG is excluded: this is a document that can carry
    // script, and serving it from our own origin would run that script with our
    // origin's privileges. A `.png` filename does not change what it is.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffImageType(svg)).toBeNull();
  });

  it('refuses HTML dressed as an image', () => {
    expect(sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
  });

  it('refuses a file that merely starts plausibly', () => {
    // RIFF is also the container for WAV and AVI. Checking only the first tag
    // would accept both, so the WEBP tag at offset 8 has to be checked too.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it('refuses anything too short to identify', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('readLimited', () => {
  it('returns the whole body when it is within the limit', async () => {
    const body = await readLimited(Readable.from([Buffer.from('abc'), Buffer.from('de')]));
    expect(body.toString()).toBe('abcde');
  });

  it('rejects as soon as the limit is passed, not after buffering it all', async () => {
    // The point of the check: an oversized upload must not be held in memory in
    // its entirety before being refused, or a declared Content-Length nobody
    // verified becomes a way to exhaust it.
    let consumed = 0;
    const chunks = Readable.from(
      (function* () {
        for (let i = 0; i < 100; i++) {
          consumed += 1;
          yield Buffer.alloc(64 * 1024);
        }
      })(),
    );

    await expect(readLimited(chunks, 128 * 1024)).rejects.toThrow(/larger than/);
    // 128KB at 64KB per chunk: refused on the third, not after all hundred.
    expect(consumed).toBeLessThan(5);
  });

  it('caps at 2MB by default', () => {
    expect(MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024);
  });
});
