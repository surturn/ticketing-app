import { AwsClient } from 'aws4fetch';
import { randomUUID } from 'node:crypto';
import { env, r2Configured } from '../config/env.js';
import { badRequest, serviceUnavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Object storage for posters, on Cloudflare R2.
//
// R2 speaks the S3 API, so this needs a request signer and nothing else —
// `aws4fetch` is a few kilobytes against the AWS SDK's several megabytes, and
// the only S3 operation here is PutObject.
//
// Images are served from R2's public URL rather than proxied through this
// service. A poster is the largest thing on any page and the API has no
// business spending a request handler on bytes a CDN serves better.
// ---------------------------------------------------------------------------

/**
 * What may be uploaded.
 *
 * SVG is deliberately absent. An SVG is a document, not a picture: it can carry
 * `<script>`, and a browser opening one from our own origin runs that script
 * with our origin's privileges — stored cross-site scripting, delivered by the
 * poster upload. Raster formats have no such capability, so excluding one
 * format removes the entire class of attack.
 */
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

export type AllowedMime = keyof typeof ALLOWED;

/** 2MB. Enforced while streaming, not after — see `readLimited`. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Identifies the format from the bytes themselves.
 *
 * The browser's `Content-Type` and the filename are both supplied by the
 * client and both trivially forged, so neither decides anything here. A file
 * claiming to be a PNG while beginning with `<?xml` would otherwise be stored
 * and later served as an image — which is exactly how an SVG, or an HTML
 * document, gets past a filter that trusts the label.
 */
export function sniffImageType(buffer: Buffer): AllowedMime | null {
  if (buffer.length < 12) return null;

  // 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // FF D8 FF — every JPEG variant starts with this SOI marker.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // RIFF....WEBP — the size sits between the two tags, so both are checked.
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Drains a stream, refusing anything over the limit.
 *
 * Counted as chunks arrive rather than checked at the end. A declared
 * `Content-Length` is a claim, and buffering a whole upload before deciding it
 * was too large hands anyone who lies about it a way to exhaust memory. This
 * abandons the read the moment the cap is passed.
 */
export async function readLimited(
  stream: AsyncIterable<Buffer>,
  limit = MAX_UPLOAD_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      throw badRequest(
        `That image is larger than ${Math.round(limit / 1024 / 1024)}MB. Please use a smaller file.`,
      );
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

let client: AwsClient | null = null;

function r2(): AwsClient {
  if (!r2Configured) {
    throw serviceUnavailable(
      'storage_not_configured',
      'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must all be set to upload images',
    );
  }

  client ??= new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    // R2 ignores the region but the signature does not: it is part of the
    // string being signed, and `auto` is the value R2 expects.
    region: 'auto',
    service: 's3',
  });

  return client;
}

export interface StoredImage {
  url: string;
  key: string;
  bytes: number;
  contentType: AllowedMime;
}

/**
 * Stores a poster and returns the URL to put in `events.poster_url`.
 *
 * The key is a fresh UUID rather than anything derived from the uploaded
 * filename. A user-supplied name would need escaping, could collide with an
 * existing object and silently replace it, and would leak whatever the
 * organiser happened to call the file on their laptop.
 */
export async function storePoster(
  body: Buffer,
  contentType: AllowedMime,
): Promise<StoredImage> {
  const key = `posters/${randomUUID()}.${ALLOWED[contentType]}`;
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;

  const response = await r2().fetch(endpoint, {
    method: 'PUT',
    body,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      // Immutable: the key is unique per upload, so a poster at a given URL can
      // never change and a year is safe. Replacing artwork mints a new key.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error({ status: response.status, text }, 'R2 upload failed');
    throw serviceUnavailable(
      'storage_error',
      `Could not store that image (${response.status})`,
    );
  }

  return {
    url: `${env.R2_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${key}`,
    key,
    bytes: body.length,
    contentType,
  };
}
