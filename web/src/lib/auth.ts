/**
 * Every sign-in and sign-up operation the storefront can perform.
 *
 * The three providers enabled on this project are Google, Apple and
 * email/password. They are not equivalent, and the differences drive real
 * behaviour elsewhere:
 *
 *   Google and Apple arrive with a verified email. The API links a buyer's past
 *   guest orders only when `email_verified` is true, so these two recover an
 *   existing ticket history immediately.
 *
 *   Email/password does not. The account exists but the address is unproven
 *   until the buyer clicks the verification mail, and until then past orders
 *   stay unclaimed. That is why `signUpWithPassword` sends the verification mail
 *   as part of signing up rather than leaving it to a later prompt.
 *
 * React state lives in `AuthProvider`; this module is deliberately plain
 * functions so the flows can be reasoned about — and later tested — without a
 * renderer.
 */
import {
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  getRedirectResult,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
  type AuthProvider as FirebaseAuthProvider,
  type User,
  type UserCredential,
} from 'firebase/auth';
import { firebaseAuth } from './firebase';

export type ProviderId = 'google.com' | 'apple.com';

export interface SignInOutcome {
  user: User;
  /** True when this sign-in created the account, for "welcome" vs "welcome back". */
  isNewUser: boolean;
}

// ─── Federated providers ───────────────────────────────────────────────────

function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Always show the chooser. Without it a shared machine silently reuses
  // whichever Google account signed in last, which at a ticket desk or on a
  // family laptop means buying tickets onto somebody else's account.
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

function appleProvider(): OAuthProvider {
  const provider = new OAuthProvider('apple.com');
  // Apple returns neither unless asked. `email` is required — the API refuses a
  // token with no email, since receipts, ticket delivery and order lookup are
  // all keyed on it.
  provider.addScope('email');
  provider.addScope('name');
  return provider;
}

function providerFor(id: ProviderId): FirebaseAuthProvider {
  return id === 'google.com' ? googleProvider() : appleProvider();
}

/**
 * Signs in with Google or Apple.
 *
 * Popup first, redirect only as a fallback. The usual advice prefers redirect on
 * mobile, but redirect carries state across a full page load through storage
 * that Safari and Firefox partition by default — and the auth handler lives on
 * `*.firebaseapp.com`, a different origin to the storefront, which is exactly
 * the case those browsers restrict. Popup keeps the flow on one origin and one
 * page, so it is the reliable path here and redirect is what we fall back to
 * when the browser refuses to open a popup at all.
 */
export async function signInWithProvider(id: ProviderId): Promise<SignInOutcome> {
  const auth = firebaseAuth();

  try {
    const credential = await signInWithPopup(auth, providerFor(id));
    return outcomeOf(credential, id);
  } catch (error) {
    const code = errorCode(error);

    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      // Navigates away. `completeRedirectSignIn` picks the result up on return,
      // so nothing after this line runs.
      await signInWithRedirect(auth, providerFor(id));
      return await new Promise<never>(() => {});
    }

    throw error;
  }
}

/**
 * Collects the result of a redirect sign-in, if that is how we got here.
 *
 * Safe and cheap to call on every load: it resolves to null on an ordinary page
 * view. Errors are surfaced rather than swallowed, because a failed redirect is
 * otherwise completely silent — the buyer lands back on the sign-in screen with
 * no explanation for why they are still signed out.
 */
export async function completeRedirectSignIn(): Promise<SignInOutcome | null> {
  const credential = await getRedirectResult(firebaseAuth());
  if (!credential) return null;

  const id = credential.providerId;
  return outcomeOf(
    credential,
    id === 'google.com' || id === 'apple.com' ? id : undefined,
  );
}

/**
 * Normalises a credential, and rescues the name from an Apple sign-up.
 *
 * Apple sends the buyer's name exactly once — on the very first authorisation —
 * and never again. If it is not captured here it is gone for good, and the
 * account is left permanently nameless. Google has no such restriction.
 */
async function outcomeOf(
  credential: UserCredential,
  id?: ProviderId,
): Promise<SignInOutcome> {
  const isNewUser = getAdditionalUserInfo(credential)?.isNewUser ?? false;

  if (id === 'apple.com' && isNewUser && !credential.user.displayName) {
    const profile = getAdditionalUserInfo(credential)?.profile as
      | { name?: { firstName?: string; lastName?: string } }
      | undefined;

    const name = [profile?.name?.firstName, profile?.name?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (name) {
      // Best effort. A buyer with no display name is a cosmetic problem, not a
      // broken sign-in, so this must never fail the flow it sits inside.
      await updateProfile(credential.user, { displayName: name }).catch(() => {});
      await credential.user.reload().catch(() => {});
    }
  }

  return { user: credential.user, isNewUser };
}

// ─── Email and password ────────────────────────────────────────────────────

export async function signUpWithPassword(
  email: string,
  password: string,
  displayName?: string,
): Promise<SignInOutcome> {
  const credential = await createUserWithEmailAndPassword(
    firebaseAuth(),
    email.trim(),
    password,
  );

  const name = displayName?.trim();
  if (name) {
    await updateProfile(credential.user, { displayName: name }).catch(() => {});
  }

  // Sent here rather than from a later prompt: an unverified address cannot
  // claim past guest orders, so delaying this delays the buyer finding tickets
  // they have already paid for.
  await sendEmailVerification(credential.user).catch(() => {});

  return { user: credential.user, isNewUser: true };
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInOutcome> {
  const credential = await signInWithEmailAndPassword(
    firebaseAuth(),
    email.trim(),
    password,
  );
  return { user: credential.user, isNewUser: false };
}

export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(firebaseAuth(), email.trim());
}

/** Re-sends the verification mail for the signed-in buyer. */
export async function resendVerificationEmail(): Promise<void> {
  const user = firebaseAuth().currentUser;
  if (!user) throw new Error('Sign in first.');
  await sendEmailVerification(user);
}

export async function signOutOfApp(): Promise<void> {
  await signOut(firebaseAuth());
}

// ─── Errors ────────────────────────────────────────────────────────────────

export function errorCode(error: unknown): string {
  return (error as { code?: string })?.code ?? '';
}

/** True for the two codes that mean "the buyer changed their mind", not a fault. */
export function isCancellation(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'auth/popup-closed-by-user' ||
    code === 'auth/cancelled-popup-request' ||
    code === 'auth/user-cancelled'
  );
}

/**
 * A message safe and useful to show a buyer.
 *
 * Sign-in and sign-up failures are collapsed to one wording on purpose. Firebase
 * distinguishes "no such account" from "wrong password", but repeating that
 * distinction on screen turns the form into a way to test whether a given person
 * has an account here — which, for a service that knows who is attending which
 * event, is worth more care than the small usability gain.
 */
export function authErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match. Check both and try again.';

    case 'auth/invalid-email':
      return 'That does not look like a valid email address.';

    case 'auth/email-already-in-use':
      return 'There is already an account with that email. Try signing in instead.';

    case 'auth/weak-password':
      return 'Choose a longer password — at least 6 characters.';

    case 'auth/user-disabled':
      return 'This account has been disabled. Contact support if that is unexpected.';

    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';

    case 'auth/network-request-failed':
      return 'Could not reach the network. Check your connection and try again.';

    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow popups for this site and try again.';

    case 'auth/account-exists-with-different-credential':
      return 'You have already signed in with a different method using that email. Use that one instead.';

    case 'auth/requires-recent-login':
      return 'For security, sign in again before making that change.';

    // Configuration rather than user error, but a buyer still needs to be told
    // something true. The specifics belong in the logs, not on screen.
    case 'auth/operation-not-allowed':
    case 'auth/unauthorized-domain':
    case 'auth/invalid-api-key':
      return 'Sign-in is unavailable right now. Please try again later.';

    default:
      return 'Something went wrong signing you in. Please try again.';
  }
}
