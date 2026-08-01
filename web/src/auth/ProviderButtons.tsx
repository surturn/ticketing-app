/**
 * Google and Apple buttons.
 *
 * Both marks are inlined as SVG rather than loaded from a CDN — the brand
 * guidelines' reason for self-hosting fonts applies here too, and Google's and
 * Apple's terms both require their mark be shown exactly as supplied, which a
 * blocked or 404'd remote asset cannot guarantee.
 *
 * Presented side by side and equally weighted. Firebase's email-enumeration
 * protection means the app cannot ask "which provider does this address already
 * use?" — that lookup is deliberately disabled — so offering all the options at
 * once is the only design that works, and progressive disclosure based on the
 * address would be building on a call that always fails.
 */
import type { ProviderId } from '@/lib/auth';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.62 0 3.06.56 4.21 1.65l3.15-3.15C17.45 1.5 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.14 6.16-4.14Z"
      />
    </svg>
  );
}

/** Exported only so withdrawing the Apple button below does not make it unused. */
export function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" fill="currentColor">
      <path d="M17.05 12.53c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.78 2.29-1.61 2.79-.41 6.92 1.16 9.18.77 1.11 1.68 2.35 2.88 2.31 1.16-.05 1.6-.75 3-.75 1.4 0 1.79.75 3.01.72 1.24-.02 2.03-1.13 2.79-2.24.88-1.28 1.24-2.52 1.26-2.59-.03-.01-2.42-.93-2.44-3.7ZM14.79 5.4c.64-.77 1.07-1.85.95-2.92-.92.04-2.03.61-2.69 1.38-.59.68-1.11 1.78-.97 2.83 1.03.08 2.07-.52 2.71-1.29Z" />
    </svg>
  );
}

interface Props {
  onSelect: (id: ProviderId) => void;
  /** The provider currently in flight, if any. */
  busy: ProviderId | null;
  disabled: boolean;
}

export function ProviderButtons({ onSelect, busy, disabled }: Props) {
  const base =
    'flex w-full items-center justify-center gap-3 clipped border border-outline-variant ' +
    'bg-surface-container-high px-6 py-3 font-medium text-on-surface-variant transition ' +
    'hover:bg-outline-variant/40 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="space-y-3">
      <button
        type="button"
        className={base}
        disabled={disabled || busy !== null}
        onClick={() => onSelect('google.com')}
      >
        <GoogleMark />
        {busy === 'google.com' ? 'Opening Google…' : 'Continue with Google'}
      </button>

      {/* Apple is deferred, not removed.

          The client path — `appleProvider`, the first-sign-in name capture in
          `outcomeOf`, the error mapping — is intact and typechecked, so
          re-enabling is uncommenting this block.

          It stays withdrawn until the mail provider's sender domain is
          registered with Apple's private email relay, which is a prerequisite
          for reaching buyers who choose to hide their address. Consult the
          internal integration notes before turning it on.

      <button
        type="button"
        className={base}
        disabled={disabled || busy !== null}
        onClick={() => onSelect('apple.com')}
      >
        <AppleMark />
        {busy === 'apple.com' ? 'Opening Apple…' : 'Continue with Apple'}
      </button>
      */}
    </div>
  );
}
