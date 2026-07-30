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
        <p className="text-sm font-medium text-muted">
          {session?.created ? 'Welcome' : 'Welcome back'}
        </p>
        <h1 className="mt-2 text-3xl text-white">{name ?? user.email}</h1>
        <p className="mt-2 text-sm text-muted">
          Signed in with {PROVIDER_LABEL[provider] ?? provider}
          {user.emailVerified && ' · email verified'}
        </p>
      </div>

      <VerifyEmailNotice />

      {/* Worth saying out loud. A buyer who bought as a guest months ago has no
          reason to expect those orders to appear, so silently attaching them is
          a missed reassurance at exactly the moment they were worried. */}
      {session && session.linkedOrders > 0 && (
        <div className="relative overflow-hidden rounded-xl border border-gold/30 bg-surface p-6">
          <div className="gold-glow pointer-events-none absolute -inset-8" />
          <p className="relative font-display text-xl font-extrabold text-gold">
            {session.linkedOrders === 1
              ? 'We found an earlier order'
              : `We found ${session.linkedOrders} earlier orders`}
          </p>
          <p className="relative mt-1.5 text-sm text-muted">
            Tickets you bought as a guest with this address are now in your account.
          </p>
        </div>
      )}

      {/* The buyer is genuinely signed in; only the API round-trip failed. Said
          plainly so it does not read as a broken sign-in. */}
      {sessionError && (
        <p role="alert" className="text-sm text-red-400">
          You are signed in, but we could not load your account details.{' '}
          {sessionError}
        </p>
      )}

      <button
        type="button"
        onClick={() => void signOut()}
        className="px-2 py-3 text-slate-500 transition hover:text-slate-400"
      >
        Sign out
      </button>
    </section>
  );
}
