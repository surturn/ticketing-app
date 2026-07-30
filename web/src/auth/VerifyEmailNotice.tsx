/**
 * Shown while a buyer's address is unproven.
 *
 * This is not housekeeping — it is the difference between a buyer seeing the
 * tickets they already paid for and not. The API attaches past guest orders to
 * an account only when the address is verified, so an unverified buyer who
 * bought before registering sees an empty order history and reasonably concludes
 * the tickets are gone.
 *
 * Only email/password accounts land here. Google and Apple supply a verified
 * address, so for them this never renders.
 */
import { useState } from 'react';
import { authErrorMessage, resendVerificationEmail } from '@/lib/auth';
import { useAuth } from './AuthProvider';

export function VerifyEmailNotice() {
  const { user, session, refresh } = useAuth();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'checking'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!user || !session?.verificationRequiredToLinkOrders) return null;

  async function resend() {
    setError(null);
    setState('sending');
    try {
      await resendVerificationEmail();
      setState('sent');
    } catch (caught) {
      setState('idle');
      setError(authErrorMessage(caught));
    }
  }

  async function check() {
    setError(null);
    setState('checking');
    try {
      // Firebase does not push verification back to an open tab, so this is the
      // only way the page learns about it short of a reload.
      await refresh();
    } catch {
      setError('Could not check just now. Try again in a moment.');
    } finally {
      setState('idle');
    }
  }

  return (
    <div className="rounded-xl border border-gold/30 bg-surface p-5">
      <p className="font-medium text-gold">Verify your email</p>
      <p className="mt-1.5 text-sm text-muted">
        We sent a link to <span className="text-slate-300">{user.email}</span>. Until
        you open it, any tickets you bought as a guest with this address stay
        unlinked from your account.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={check}
          disabled={state === 'checking'}
          className="rounded-full border border-line px-5 py-2 text-sm font-medium text-slate-200 transition hover:bg-elevated disabled:opacity-50"
        >
          {state === 'checking' ? 'Checking…' : "I've verified"}
        </button>

        <button
          type="button"
          onClick={resend}
          disabled={state === 'sending' || state === 'sent'}
          className="px-2 py-2 text-sm text-slate-500 transition hover:text-slate-300 disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Email sent' : 'Resend email'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
