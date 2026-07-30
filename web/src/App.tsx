/**
 * Accounts are optional, and this component is where that promise is kept.
 *
 * Three states, and none of them blocks buying a ticket: still resolving a
 * stored session, signed out, or signed in. A build with no Firebase config
 * falls into a fourth — sign-in simply is not offered — rather than crashing,
 * because a missing key must never take the storefront down with it.
 */
import { AccountPanel } from './auth/AccountPanel';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { SignInPanel } from './auth/SignInPanel';

function Screen() {
  const { status, accountsAvailable } = useAuth();

  if (!accountsAvailable) {
    return (
      <p className="mx-auto max-w-sm text-center text-sm text-muted">
        Accounts are not available in this build. You can still buy tickets as a
        guest — they will be emailed to you.
      </p>
    );
  }

  // Shown while Firebase restores a stored session. Brief, but without it a
  // returning buyer sees the sign-in form flash before being signed in, which
  // reads as having been signed out.
  if (status === 'loading') {
    return (
      <div className="mx-auto w-full max-w-sm space-y-3">
        <div className="skeleton h-8 w-2/3 rounded" />
        <div className="skeleton h-4 w-1/2 rounded" />
        <div className="skeleton mt-6 h-12 w-full rounded-full" />
        <div className="skeleton h-12 w-full rounded-full" />
      </div>
    );
  }

  return status === 'signed-in' ? <AccountPanel /> : <SignInPanel />;
}

export default function App() {
  return (
    <AuthProvider>
      <main className="mx-auto max-w-2xl px-6 py-16">
        <Screen />
      </main>
    </AuthProvider>
  );
}
