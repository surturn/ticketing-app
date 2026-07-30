/**
 * Firebase web config, read from the environment.
 *
 * Values are never inlined in source — they come from `web/.env` via Vite, so the
 * same bundle can be pointed at a staging project by changing the build
 * environment rather than editing code.
 *
 * These values are public. They are compiled into the browser bundle and visible
 * in devtools, which is how the Firebase web SDK is designed: what protects the
 * project is the authorised-domains list, which sign-in providers are enabled,
 * and App Check — not concealing the config. The genuine secret is the
 * service-account key, which lives only in the API's environment.
 *
 * This module deliberately does not import the Firebase SDK. It validates and
 * exposes configuration; initialising the app belongs with the auth code, so a
 * missing variable is reported here as a clear message instead of surfacing much
 * later as an unexplained SDK error.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
}

const REQUIRED = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

/** Names of any required variables that are missing or empty. */
export function missingFirebaseConfig(): string[] {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return REQUIRED.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === '';
  });
}

/**
 * True when accounts can work in this build.
 *
 * Accounts are optional, so callers check this rather than assuming: a build made
 * without the config should still sell tickets as a guest, with sign-in hidden,
 * instead of crashing on load.
 */
export function isFirebaseConfigured(): boolean {
  return missingFirebaseConfig().length === 0;
}

/**
 * The config, or throws naming exactly what is absent.
 *
 * Guard with `isFirebaseConfigured()` where accounts are optional.
 */
export function getFirebaseConfig(): FirebaseWebConfig {
  const missing = missingFirebaseConfig();
  if (missing.length > 0) {
    throw new Error(
      `Firebase is not configured. Missing: ${missing.join(', ')}. ` +
        'Copy web/.env.example to web/.env and fill it in. Note these are read at ' +
        'build time, so rebuild after changing them.',
    );
  }

  const env = import.meta.env;
  const measurementId = env.VITE_FIREBASE_MEASUREMENT_ID?.trim();

  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    // Omitted entirely when unset, so analytics stays off rather than
    // initialising against an empty id.
    ...(measurementId ? { measurementId } : {}),
  };
}

/**
 * Analytics is opt-in.
 *
 * Separate from the auth path on purpose: analytics sets identifiers that most
 * privacy regimes treat as requiring consent, and it must not be a prerequisite
 * for signing in. Leave the measurement id unset until consent handling exists.
 */
export function isAnalyticsEnabled(): boolean {
  return Boolean(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID?.trim());
}
