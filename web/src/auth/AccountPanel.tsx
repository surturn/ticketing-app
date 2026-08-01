/**
 * What a signed-in buyer sees.
 *
 * Kept deliberately thin — it reports identity, the state of verification, and
 * how many past orders were adopted by this sign-in. The order list itself
 * belongs with the storefront's own screens; this is the account surface the
 * auth flow needs in order to be complete and demonstrably working.
 */
import { useAuth } from './AuthProvider';
import { VerifyEmailNotice } from './VerifyEmailNotice';

const PROVIDER_LABEL: Record<string, string> = {
  'google.com': 'Google',
  'apple.com': 'Apple',
  password: 'Email and password',
};

export function AccountPanel() {
  const { user, session, sessionError, signOut } = useAuth();
  if (!user) return null;

  const provider = user.providerData[0]?.providerId ?? 'password';
  const name = user.displayName ?? session?.user.displayName;

  return (
    <section className="mx-auto w-full max-w-md space-y-6">
      <div>
        <p className="md-eyebrow text-on-surface-variant">
          {session?.created ? 'Welcome' : 'Welcome back'}
        </p>
        <h1 className="md-headline-large mt-2 text-on-surface">{name ?? user.email}</h1>
        <p className="md-body-medium mt-2 text-on-surface-variant">
          Signed in with {PROVIDER_LABEL[provider] ?? provider}
          {user.emailVerified && ' · email verified'}
        </p>
      </div>

      <VerifyEmailNotice />

      {/* Worth saying out loud. A buyer who bought as a guest months ago has no
          reason to expect those orders to appear, so silently attaching them is
          a missed reassurance at exactly the moment they were worried.

          Blue, not gold: this is a buyer being reassured about their own
          tickets. Gold on a consumer surface means "this leads to the organiser
          side", and spending it on good news here would blunt the one signal
          that distinguishes the two halves of the product. */}
      {session && session.linkedOrders > 0 && (
        <div className="relative overflow-hidden rounded-md border border-primary/30 bg-surface-container p-6">
          <p className="md-title-large relative text-on-surface">
            {session.linkedOrders === 1
              ? 'We found an earlier order'
              : `We found ${session.linkedOrders} earlier orders`}
          </p>
          <p className="md-body-medium relative mt-1.5 text-on-surface-variant">
            Tickets you bought as a guest with this address are now in your account.
          </p>
        </div>
      )}

      {/* The buyer is genuinely signed in; only the API round-trip failed. Said
          plainly so it does not read as a broken sign-in. */}
      {sessionError && (
        <p role="alert" className="md-body-medium text-error">
          You are signed in, but we could not load your account details.{' '}
          {sessionError}
        </p>
      )}

      <button
        type="button"
        onClick={() => void signOut()}
        className="px-2 py-3 text-on-surface-variant transition hover:text-on-surface-variant"
      >
        Sign out
      </button>
    </section>
  );
}
