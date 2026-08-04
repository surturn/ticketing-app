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
 *
 * `firebase/app` and `firebase/auth` are also dynamically imported rather than
 * imported at the top of this module. Most buyers arrive from a shared link,
 * pay as a guest, and never sign in — a static import here would still pull the
 * whole SDK into the entry chunk because this module sits in the app-root
 * import graph (`AuthProvider` mounts at the router root). Every caller below
 * awaits `getFirebaseAuth()` instead of a synchronous accessor, and that is the
 * one change that actually keeps Firebase out of first paint; deferring the
 * imports here while a call site still expects a synchronous `Auth` would just
 * move the static import back into this file's callers.
 */
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import { getFirebaseConfig } from './firebase-config';

let cachedApp: FirebaseApp | null = null;

/**
 * Resolves once, to the shared `Auth` instance, loading the SDK on first call.
 *
 * Memoised on the *promise*, not the resolved value. Several call sites can
 * legitimately race to be first — `AuthProvider` mounts and starts its
 * subscribe effect at the same moment a page's first `apiFetch({ optionalAuth:
 * true })` fires — and without this each caller would kick off its own
 * `import()` plus its own `getAuth`/`setPersistence` pair. Caching the pending
 * promise means every caller, however many arrive before the import settles,
 * awaits the same in-flight initialisation and gets back the same instance.
 * Caching only the resolved value would not prevent that race: two calls made
 * before the first resolves would both see `null` and both start loading.
 */
let authPromise: Promise<Auth> | null = null;

export function getFirebaseAuth(): Promise<Auth> {
  authPromise ??= (async () => {
    const [{ initializeApp }, { getAuth, browserLocalPersistence, setPersistence }] =
      await Promise.all([import('firebase/app'), import('firebase/auth')]);

    cachedApp ??= initializeApp(getFirebaseConfig());
    const auth = getAuth(cachedApp);

    // Buyers come back days later for their tickets, so the session outlives the
    // tab. This is the SDK default, set explicitly because it is a decision worth
    // seeing: the alternative, session-scoped persistence, would sign people out
    // every time they close the browser between buying and arriving at the gate.
    //
    // Fire-and-forget: persistence resolves before any sign-in call the user could
    // physically trigger, and if storage is unavailable (private mode, blocked
    // cookies) the SDK falls back to in-memory on its own. Failing loudly here
    // would break sign-in in exactly the browsers that still work fine without it.
    void setPersistence(auth, browserLocalPersistence).catch(() => {});

    // Localises Firebase's own emails — verification and password reset — to the
    // buyer's browser language rather than always English.
    auth.useDeviceLanguage();

    return auth;
  })().catch((error: unknown) => {
    // `??=` only skips re-running when `authPromise` is null or undefined — a
    // *rejected* promise is neither, so without this reset a single failed
    // `import()` (a transient network blip, or a tab left open across a deploy
    // asking for a chunk hash that no longer exists) would pin every future
    // call to the same rejection for the rest of the tab's life, with no way
    // back short of a full reload. Clearing the memo here means the next
    // caller — whenever that is, seconds or minutes later — gets a fresh
    // attempt instead of inheriting a stale failure.
    //
    // No reload-and-retry here, unlike `lazyRoute`'s recovery for a stale
    // route chunk. That pattern fits a navigation, where losing the in-flight
    // render and replaying it costs nothing the visitor would notice. This
    // accessor is awaited from the middle of arbitrary flows — a checkout in
    // progress, a form half-filled on the settings page — where forcing a
    // reload would destroy work a reload-once-per-route never risks. Every
    // caller here already has, or is being given, a degrade-to-guest path for
    // exactly this failure (see `api.ts`'s `optionalAuth` branch), so the
    // safe recovery is "let the next attempt try again," not "reload the
    // page out from under whatever the buyer was doing."
    authPromise = null;
    throw error;
  });

  return authPromise;
}
