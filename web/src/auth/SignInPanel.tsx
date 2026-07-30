/**
 * The sign-in screen: Google, Apple, or email and password.
 *
 * One panel handles signing in, creating an account and resetting a password,
 * because they are the same three fields in different arrangements and a buyer
 * who guesses wrong should be one link away from the right one — not on a
 * different page having lost what they typed.
 */
import { useState, type FormEvent } from 'react';
import {
  authErrorMessage,
  isCancellation,
  sendPasswordReset,
  signInWithPassword,
  signInWithProvider,
  signUpWithPassword,
  type ProviderId,
} from '@/lib/auth';
import { ProviderButtons } from './ProviderButtons';

type Mode = 'signin' | 'signup' | 'reset';

const COPY: Record<Mode, { title: string; blurb: string; submit: string }> = {
  signin: {
    title: 'Sign in',
    blurb: 'Find your tickets, and keep every order in one place.',
    submit: 'Sign in',
  },
  signup: {
    title: 'Create an account',
    blurb: 'Optional — you can always buy as a guest and sign up later.',
    submit: 'Create account',
  },
  reset: {
    title: 'Reset your password',
    blurb: 'We will email you a link to choose a new one.',
    submit: 'Send reset link',
  },
};

const field =
  'w-full rounded-xl border border-line bg-bg px-4 py-3 text-white placeholder:text-slate-500 ' +
  'transition focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary-ring';

export function SignInPanel({ onSignedIn }: { onSignedIn?: () => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = submitting || busyProvider !== null;

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    // The address survives the switch — retyping it is the single most annoying
    // part of guessing wrong between signing in and signing up.
    setPassword('');
  }

  async function handleProvider(id: ProviderId) {
    setError(null);
    setNotice(null);
    setBusyProvider(id);

    try {
      await signInWithProvider(id);
      onSignedIn?.();
    } catch (caught) {
      // Closing the popup is a decision, not a failure. Showing an error for it
      // reads as though something broke.
      if (!isCancellation(caught)) setError(authErrorMessage(caught));
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      if (mode === 'reset') {
        await sendPasswordReset(email);
        // Worded so it says the same thing whether or not an account exists —
        // otherwise this form becomes a way to check who has one.
        setNotice(
          `If there is an account for ${email.trim()}, a reset link is on its way.`,
        );
        setMode('signin');
      } else if (mode === 'signup') {
        await signUpWithPassword(email, password, displayName);
        onSignedIn?.();
      } else {
        await signInWithPassword(email, password);
        onSignedIn?.();
      }
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const copy = COPY[mode];

  return (
    <section className="mx-auto w-full max-w-sm">
      <h1 className="text-3xl text-white">{copy.title}</h1>
      <p className="mt-2 text-sm text-muted">{copy.blurb}</p>

      {mode !== 'reset' && (
        <>
          <div className="mt-8">
            <ProviderButtons
              onSelect={handleProvider}
              busy={busyProvider}
              disabled={submitting}
            />
          </div>

          <div className="my-6 flex items-center gap-4">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs tracking-widest text-slate-500 uppercase">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'signup' && (
          <div>
            <label htmlFor="name" className="mb-1.5 block text-sm text-slate-300">
              Name <span className="text-slate-500">(optional)</span>
            </label>
            <input
              id="name"
              className={field}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              placeholder="Wanjiku Kamau"
              disabled={busy}
            />
          </div>
        )}

        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm text-slate-300">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            className={field}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            disabled={busy}
          />
        </div>

        {mode !== 'reset' && (
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor="password" className="block text-sm text-slate-300">
                Password
              </label>
              {mode === 'signin' && (
                <button
                  type="button"
                  className="text-sm text-slate-500 transition hover:text-slate-300"
                  onClick={() => switchTo('reset')}
                >
                  Forgot?
                </button>
              )}
            </div>
            <input
              id="password"
              type="password"
              required
              // Firebase's own floor. Stated up front rather than as an error
              // after the fact.
              minLength={6}
              className={field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder={mode === 'signup' ? 'At least 6 characters' : '••••••••'}
              disabled={busy}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {notice && <p className="text-sm text-valid">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-full bg-primary px-6 py-3 font-medium text-white transition hover:bg-primary-hover hover:shadow-lg hover:shadow-primary-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Working…' : copy.submit}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-muted">
        {mode === 'signin' && (
          <>
            New here?{' '}
            <button
              type="button"
              className="text-primary transition hover:text-primary-hover"
              onClick={() => switchTo('signup')}
            >
              Create an account
            </button>
          </>
        )}
        {mode === 'signup' && (
          <>
            Already have one?{' '}
            <button
              type="button"
              className="text-primary transition hover:text-primary-hover"
              onClick={() => switchTo('signin')}
            >
              Sign in
            </button>
          </>
        )}
        {mode === 'reset' && (
          <button
            type="button"
            className="text-primary transition hover:text-primary-hover"
            onClick={() => switchTo('signin')}
          >
            Back to sign in
          </button>
        )}
      </div>
    </section>
  );
}
