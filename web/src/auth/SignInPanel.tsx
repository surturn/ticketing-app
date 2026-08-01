/**
 * The sign-in screen: Google, Apple, or email and password.
 *
 * One panel handles signing in, creating an account and resetting a password,
 * because they are the same three fields in different arrangements and a buyer
 * who guesses wrong should be one link away from the right one — not on a
 * different page having lost what they typed.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  authErrorMessage,
  isCancellation,
  sendPasswordReset,
  signInWithPassword,
  signInWithProvider,
  signUpWithPassword,
  type ProviderId,
} from '@/lib/auth';
import { subscribeToAnnouncements, updateMyProfile } from '@/lib/api';
import { Button, ConsentCheckbox } from '@/components/ui';
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
  'w-full rounded-xl border border-outline-variant bg-surface px-4 py-3 text-on-surface placeholder:text-on-surface-variant ' +
  'transition focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/20';

export function SignInPanel({ onSignedIn }: { onSignedIn?: () => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  // Neither pre-ticked. Only asked for on sign-up — signing back in is not a
  // fresh consent, and re-asking every time would train people to tick without
  // reading, which is exactly what makes a consent worthless.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
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
        if (!acceptedTerms) {
          setError('Please accept the terms and privacy notice to create an account.');
          setSubmitting(false);
          return;
        }
        await signUpWithPassword(email, password, displayName);
        // Recorded after the account exists, because it is written against the
        // account. Not awaited into the sign-up path and not allowed to fail
        // it: the consent was given, and a failed write is ours to retry, not
        // a reason to refuse someone the account they just created.
        void updateMyProfile({ acceptTerms: true }).catch(() => undefined);
        if (marketingOptIn) {
          void subscribeToAnnouncements(email.trim()).catch(() => undefined);
        }
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
      <h1 className="md-headline-large text-on-surface">{copy.title}</h1>
      <p className="md-body-medium mt-2 text-on-surface-variant">{copy.blurb}</p>

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
            <span className="h-px flex-1 bg-outline-variant" />
            <span className="md-eyebrow text-on-surface-variant">or</span>
            <span className="h-px flex-1 bg-outline-variant" />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'signup' && (
          <div>
            <label htmlFor="name" className="md-label-large mb-1.5 block text-on-surface-variant">
              Name <span className="text-on-surface-variant">(optional)</span>
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
          <label htmlFor="email" className="md-label-large mb-1.5 block text-on-surface-variant">
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
              <label htmlFor="password" className="md-label-large block text-on-surface-variant">
                Password
              </label>
              {mode === 'signin' && (
                <button
                  type="button"
                  className="md-label-large text-on-surface-variant transition hover:text-on-surface"
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
          <p role="alert" className="md-body-medium text-error">
            {error}
          </p>
        )}
        {notice && <p className="md-body-medium text-primary">{notice}</p>}

        {/* Asked once, at the point the account is created. Two boxes because
            they are two consents: the first is required, the second changes
            nothing about whether the account can be made. */}
        {mode === 'signup' && (
          <div className="space-y-3 border-t border-outline-variant pt-4">
            <ConsentCheckbox checked={acceptedTerms} onChange={setAcceptedTerms} required>
              I agree to the{' '}
              <Link to="/terms" className="text-primary underline">
                terms of service
              </Link>{' '}
              and the{' '}
              <Link to="/privacy" className="text-primary underline">
                privacy notice
              </Link>
              .
            </ConsentCheckbox>

            <ConsentCheckbox checked={marketingOptIn} onChange={setMarketingOptIn}>
              Email me about upcoming events and flash sales. Optional.
            </ConsentCheckbox>
          </div>
        )}

        <Button type="submit" full busy={busy} busyLabel="Working…">
          {copy.submit}
        </Button>
      </form>

      <div className="md-body-medium mt-6 text-center text-on-surface-variant">
        {mode === 'signin' && (
          <>
            New here?{' '}
            <button
              type="button"
              className="text-primary transition hover:text-primary"
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
              className="text-primary transition hover:text-primary"
              onClick={() => switchTo('signin')}
            >
              Sign in
            </button>
          </>
        )}
        {mode === 'reset' && (
          <button
            type="button"
            className="text-primary transition hover:text-primary"
            onClick={() => switchTo('signin')}
          >
            Back to sign in
          </button>
        )}
      </div>
    </section>
  );
}
