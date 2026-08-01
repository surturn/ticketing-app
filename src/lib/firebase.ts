import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { env, firebaseConfigured } from '../config/env.js';
import { forbidden, serviceUnavailable, unauthorized } from './errors.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Firebase ID token verification.
//
// The client SDK owns sign-up, sign-in, password reset and email verification.
// This module does one thing: turn a bearer token into a subject we are willing
// to trust, or refuse.
//
// `checkRevoked: true` is the reason the Admin SDK is here at all. Verifying a
// token's signature only proves Google issued it; it says nothing about whether
// the account was disabled or its sessions revoked in the meantime. Since ID
// tokens live for an hour, signature-only verification means a compromised
// account stays usable for up to an hour after you try to shut it out. The
// revocation check costs a lookup and removes that window.
// ---------------------------------------------------------------------------

const APP_NAME = 'ticketing';

let cachedApp: App | null = null;

function app(): App {
  if (cachedApp) return cachedApp;

  if (!firebaseConfigured) {
    throw serviceUnavailable(
      'accounts_not_configured',
      'Buyer accounts are not configured on this server',
    );
  }

  const existing = getApps().find((candidate) => candidate.name === APP_NAME);
  cachedApp =
    existing ??
    initializeApp(
      {
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID!,
          clientEmail: env.FIREBASE_CLIENT_EMAIL!,
          privateKey: env.FIREBASE_PRIVATE_KEY!,
        }),
        projectId: env.FIREBASE_PROJECT_ID!,
      },
      APP_NAME,
    );

  return cachedApp;
}

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  /** How the buyer signed in: `password`, `google.com`, `emailLink`, … */
  signInProvider: string;
  /** Seconds since epoch at which the buyer last actually authenticated. */
  authTime: number;
}

/**
 * Verifies a bearer token and returns the subject.
 *
 * Everything downstream reads identity from the return value of this function.
 * A uid or email taken from a request body would be an assertion by the caller;
 * these come from a signature Google produced.
 */
export async function verifyIdToken(token: string): Promise<AuthenticatedUser> {
  let decoded: DecodedIdToken;

  try {
    // The SDK already enforces signature, `exp`, `iat`, and that `aud` and `iss`
    // match this project — a token minted for a different Firebase project will
    // not pass, which is what stops a token from some unrelated app being
    // replayed here.
    decoded = await getAuth(app()).verifyIdToken(token, true);
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';

    // Distinguish "sign in again" from "you are shut out", because the client
    // should silently refresh in the first case and stop trying in the second.
    if (code === 'auth/id-token-expired' || code === 'auth/id-token-revoked') {
      throw unauthorized('Your session has expired. Please sign in again.');
    }
    if (code === 'auth/user-disabled') {
      throw forbidden('This account has been disabled.');
    }

    // Anything else is a malformed or forged token. Logged at debug because a
    // public endpoint will see these routinely from scanners.
    logger.debug({ code }, 'rejected an ID token');
    throw unauthorized('That sign-in token is not valid.');
  }

  // Firebase permits an account with no email — phone-only sign-in, for one.
  // Every buyer-facing feature here is keyed on email (receipts, ticket
  // delivery, announcements, linking guest orders), so an account without one
  // cannot be used and is refused with an explanation rather than failing later
  // on a null.
  if (!decoded.email) {
    throw forbidden(
      'This account has no email address. Add one in your account settings to continue.',
    );
  }

  return {
    uid: decoded.uid,
    email: decoded.email.toLowerCase(),
    emailVerified: decoded.email_verified === true,
    displayName: (decoded.name as string | undefined) ?? null,
    signInProvider: decoded.firebase?.sign_in_provider ?? 'unknown',
    authTime: decoded.auth_time,
  };
}

/**
 * Revokes every refresh token for a user, so all their sessions end.
 *
 * Paired with `checkRevoked` above this is a real "sign out everywhere": the
 * next verification of any outstanding ID token fails. This is the break-glass
 * action for a compromised account.
 */
export async function revokeUserSessions(uid: string): Promise<void> {
  await getAuth(app()).revokeRefreshTokens(uid);
  logger.warn({ uid }, 'revoked all sessions for user');
}

/**
 * Removes the identity itself, so the account cannot be signed back into.
 *
 * Tolerates the user already being absent. Deletion is the one operation a
 * buyer may well retry after a timeout, and a second attempt failing with
 * "user not found" would report an error for work that had in fact succeeded.
 */
export async function deleteFirebaseUser(uid: string): Promise<void> {
  try {
    await getAuth(app()).deleteUser(uid);
    logger.warn({ uid }, 'deleted Firebase user');
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') {
      logger.info({ uid }, 'Firebase user already absent; nothing to delete');
      return;
    }
    throw error;
  }
}

/** Blocks sign-in entirely until re-enabled. */
export async function setUserDisabled(uid: string, disabled: boolean): Promise<void> {
  await getAuth(app()).updateUser(uid, { disabled });
  if (disabled) await getAuth(app()).revokeRefreshTokens(uid);
  logger.warn({ uid, disabled }, 'changed account disabled state');
}

/** Extracts a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}
