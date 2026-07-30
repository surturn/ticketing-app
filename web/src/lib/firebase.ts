/**
 * The Firebase app and Auth instance.
 *
 * Separate from `firebase-config.ts` on purpose: that module knows the values,
 * this one knows the SDK. Keeping the split means a build with no config reports
 * a readable message from the config module instead of an SDK error thrown from
 * somewhere inside `initializeApp`.
 *
 * Initialisation is lazy and memoised. Nothing here runs at import time, so a
 * page that never offers sign-in never loads the auth machinery, and a build
 * without config still renders — accounts are optional, and a missing key must
 * not stop anyone buying a ticket.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from 'firebase/auth';
import { getFirebaseConfig } from './firebase-config';

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;

export function firebaseApp(): FirebaseApp {
  cachedApp ??= initializeApp(getFirebaseConfig());
  return cachedApp;
}

export function firebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;

  cachedAuth = getAuth(firebaseApp());

  // Buyers come back days later for their tickets, so the session outlives the
  // tab. This is the SDK default, set explicitly because it is a decision worth
  // seeing: the alternative, session-scoped persistence, would sign people out
  // every time they close the browser between buying and arriving at the gate.
  //
  // Fire-and-forget: persistence resolves before any sign-in call the user could
  // physically trigger, and if storage is unavailable (private mode, blocked
  // cookies) the SDK falls back to in-memory on its own. Failing loudly here
  // would break sign-in in exactly the browsers that still work fine without it.
  void setPersistence(cachedAuth, browserLocalPersistence).catch(() => {});

  // Localises Firebase's own emails — verification and password reset — to the
  // buyer's browser language rather than always English.
  cachedAuth.useDeviceLanguage();

  return cachedAuth;
}
