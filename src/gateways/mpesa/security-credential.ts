import { X509Certificate, constants, publicEncrypt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { serviceUnavailable } from '../../lib/errors.js';

// ---------------------------------------------------------------------------
// SecurityCredential.
//
// Every Daraja product that moves money *out* of the shortcode — B2C, Reversal,
// TransactionStatus, AccountBalance — authenticates the initiator with an
// RSA-encrypted password rather than the password itself. Safaricom publishes a
// public certificate per environment; the initiator's plaintext password is
// encrypted against it and base64-encoded, and the result is the
// `SecurityCredential` field.
//
// This exists as its own module because getting it wrong fails in a way that
// names nothing useful. A credential built with the sandbox certificate and
// sent to production comes back as a generic initiator-information error, with
// no indication that a certificate is involved at all.
// ---------------------------------------------------------------------------

/**
 * Where the certificate lives when `MPESA_INITIATOR_CERT_PATH` is not set.
 *
 * Per environment, because the two certificates are different and are not
 * interchangeable. Under `certs/`, which is gitignored — these are downloaded
 * from the Daraja portal, not committed.
 */
function defaultCertPath(): string {
  return path.resolve(
    process.cwd(),
    'certs',
    env.MPESA_ENVIRONMENT === 'production'
      ? 'ProductionCertificate.cer'
      : 'SandboxCertificate.cer',
  );
}

/**
 * Cached across calls.
 *
 * The encryption itself is cheap, but reading the certificate off disk on every
 * payout is not, and a payout run settles many organisers in a row. Keyed by
 * the resolved path so a changed configuration is not served a stale key.
 */
let cached: { certPath: string; publicKey: ReturnType<typeof loadPublicKey> } | null =
  null;

function loadPublicKey(certPath: string) {
  if (!existsSync(certPath)) {
    throw serviceUnavailable(
      'gateway_not_configured',
      `M-Pesa initiator certificate not found at ${certPath}. ` +
        'Download it from the Daraja portal for this environment and set ' +
        'MPESA_INITIATOR_CERT_PATH, or place it at the default path.',
    );
  }

  const raw = readFileSync(certPath);

  try {
    // `X509Certificate` accepts both PEM and DER, which matters because the
    // portal serves `.cer` files in either encoding depending on the product.
    // Extracting the public key from the certificate is also what makes this
    // work at all — `publicEncrypt` cannot use a certificate directly.
    return new X509Certificate(raw).publicKey;
  } catch (error) {
    throw serviceUnavailable(
      'gateway_not_configured',
      `Could not read the M-Pesa initiator certificate at ${certPath}: ${
        (error as Error).message
      }`,
    );
  }
}

/**
 * The encrypted initiator password, ready to send as `SecurityCredential`.
 *
 * Note the padding. Safaricom specifies PKCS#1 v1.5, and Node defaults
 * `publicEncrypt` to OAEP — leaving the default produces a perfectly valid
 * ciphertext that Daraja cannot decrypt, and the resulting error says nothing
 * about padding. This single argument is the most common way this integration
 * fails silently.
 */
export function buildSecurityCredential(): string {
  const password = env.MPESA_INITIATOR_PASSWORD;
  if (!password) {
    throw serviceUnavailable(
      'gateway_not_configured',
      'MPESA_INITIATOR_PASSWORD is not set — B2C and Reversal cannot be used',
    );
  }

  const certPath = env.MPESA_INITIATOR_CERT_PATH
    ? path.resolve(process.cwd(), env.MPESA_INITIATOR_CERT_PATH)
    : defaultCertPath();

  if (!cached || cached.certPath !== certPath) {
    cached = { certPath, publicKey: loadPublicKey(certPath) };
  }

  return publicEncrypt(
    { key: cached.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, 'utf8'),
  ).toString('base64');
}

/** Drops the cached certificate. Exists so tests can swap it between cases. */
export function resetSecurityCredentialCache(): void {
  cached = null;
}
