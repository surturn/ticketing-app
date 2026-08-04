/**
 * Auth state for the whole app.
 *
 * Two sources of truth are reconciled here, and keeping them straight is the
 * whole job of this file:
 *
 *   Firebase owns *identity* — who is signed in, and whether their address is
 *   verified. It is authoritative and it changes without asking us.
 *
 *   The API owns *the buyer* — the local mirror row, the phone number, the
 *   orders. It only learns about identity when we tell it, which is what
 *   `postSession` does.
 *
 * So every identity change is followed by a session announcement, and the two
 * failure modes are handled differently: no Firebase user means signed out, but
 * a failed session call does not — the buyer is genuinely signed in, the API
 * just has not caught up, and signing them out over it would be a lie.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User } from 'firebase/auth';
import { completeRedirectSignIn, signOutOfApp } from '@/lib/auth';
import { postSession, type SessionResponse } from '@/lib/api';
import { isFirebaseConfigured } from '@/lib/firebase-config';
import { getFirebaseAuth } from '@/lib/firebase';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** The API's view of this buyer. Null until the session call succeeds. */
  session: SessionResponse | null;
  /** Set when the session call failed; identity is still valid. */
  sessionError: string | null;
  /** False in a build with no Firebase config — hide sign-in entirely. */
  accountsAvailable: boolean;
  signOut: () => Promise<void>;
  /**
   * Re-reads verification state from Firebase and re-announces the session.
   * This is what turns "verify your email" into linked orders without the buyer
   * having to sign out and back in.
   */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const accountsAvailable = isFirebaseConfigured();

  const [status, setStatus] = useState<AuthStatus>(
    accountsAvailable ? 'loading' : 'signed-out',
  );
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Keyed on uid *and* verification state so the session is announced again the
  // moment an address becomes verified — that is the call that claims a buyer's
  // past guest orders. Without the second half, someone who verifies mid-session
  // would keep an unlinked account until their next sign-in.
  const announced = useRef<string | null>(null);

  /**
   * `force` re-announces even when the key is unchanged.
   *
   * The key exists to stop the token listener re-announcing on every token
   * refresh, which is the right guard for the automatic path. It is the wrong
   * guard for a deliberate one: editing a display name changes neither the uid
   * nor the verification state, so a caller asking for fresh account data was
   * silently handed the copy fetched at sign-in. That is why saved profile
   * edits appeared to do nothing — the write landed, and nothing ever re-read
   * it.
   */
  const announce = useCallback(async (current: User, force = false) => {
    const key = `${current.uid}:${current.emailVerified}`;
    if (!force && announced.current === key) return;
    announced.current = key;

    try {
      setSession(await postSession());
      setSessionError(null);
    } catch (error) {
      // Allow a retry: this is usually a transient network failure, and pinning
      // the key would mean never trying again for the life of the session.
      announced.current = null;
      setSessionError(
        error instanceof Error ? error.message : 'Could not load your account.',
      );
    }
  }, []);

  useEffect(() => {
    if (!accountsAvailable) return;

    // This effect is the one place in the app that needs Firebase on every
    // load rather than on a deliberate action — it is how the app bar knows
    // whether to offer "Sign in" or "My tickets" at all. Everything below is
    // async because of that: `getFirebaseAuth()` and `onIdTokenChanged` itself
    // are both behind a dynamic `import('firebase/auth')`, so the SDK arrives
    // as its own chunk fetched after the entry chunk has already parsed and
    // painted, instead of being part of what a guest's browser must download
    // and execute before anything renders. Making this import eager again
    // would put the whole auth SDK back on the critical path for every visit,
    // which is the exact regression this file exists to avoid.
    //
    // Because subscribing is now async, unmounting mid-import needs its own
    // guard: `cancelled` stops a subscription from being created at all once
    // the component is gone, and the cleanup below also unsubscribes in the
    // ordinary case where the listener was already attached. Between the two,
    // no subscription outlives the component regardless of when the import
    // settles relative to unmount.
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      // Resolves a sign-in that went through a full page redirect. Runs before
      // the listener settles anything, so a redirect return does not flash the
      // signed-out screen on its way to being signed in.
      void completeRedirectSignIn().catch(() => {});

      const [auth, { onIdTokenChanged }] = await Promise.all([
        getFirebaseAuth(),
        import('firebase/auth'),
      ]);

      if (cancelled) return;

      // `onIdTokenChanged` rather than `onAuthStateChanged`: it also fires on
      // token refresh and on profile reloads, which is how a freshly verified
      // address reaches this component at all.
      unsubscribe = onIdTokenChanged(auth, (current) => {
        setUser(current);
        setStatus(current ? 'signed-in' : 'signed-out');

        if (current) {
          void announce(current);
        } else {
          announced.current = null;
          setSession(null);
          setSessionError(null);
        }
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [accountsAvailable, announce]);

  const refresh = useCallback(async () => {
    // Awaited rather than assumed already loaded: `refresh` can in principle
    // run before the subscribe effect's own import has settled, and there is
    // only one memoised promise behind `getFirebaseAuth()` either way — this
    // call shares it rather than starting a second load.
    const auth = await getFirebaseAuth();
    const current = auth.currentUser;
    if (!current) return;

    await current.reload();
    // The ID token carries `email_verified`, and the API reads it from there —
    // so a reload alone is not enough. Forcing a refresh is what makes the
    // server see the new state.
    await current.getIdToken(true);

    setUser(auth.currentUser);
    // Forced: `refresh` is only ever called deliberately — after saving a
    // profile, or while waiting on a verification — and in both cases the
    // caller wants the server's current answer, not a cached one.
    await announce(auth.currentUser!, true);
  }, [announce]);

  const signOut = useCallback(async () => {
    await signOutOfApp();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      session,
      sessionError,
      accountsAvailable,
      signOut,
      refresh,
    }),
    [status, user, session, sessionError, accountsAvailable, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
