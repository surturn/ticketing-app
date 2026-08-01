/**
 * The door to the dashboard.
 *
 * Nothing behind this component renders until a key has been accepted by the
 * API. That ordering matters: the gate is a convenience for the operator, not
 * the security boundary — every admin route re-checks the key server-side, so a
 * determined visitor who bypassed this UI would still get 401s. Rendering the
 * dashboard optimistically and letting it fill with errors would be worse for
 * the operator and no safer.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button, Card, Spinner } from '@/components/ui';
import { clearAdminKey, getAdminKey, setAdminKey, verifyAdminKey } from './adminApi';

type Phase = 'checking' | 'locked' | 'open';

export function AdminGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A key already in this tab's storage is re-verified rather than trusted.
  // It may have been rotated since it was stored, and discovering that at the
  // gate is better than discovering it half-way through creating an event.
  useEffect(() => {
    const stored = getAdminKey();
    if (!stored) {
      setPhase('locked');
      return;
    }

    let cancelled = false;
    verifyAdminKey(stored)
      .then(() => !cancelled && setPhase('open'))
      .catch(() => {
        if (cancelled) return;
        clearAdminKey();
        setPhase('locked');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      await verifyAdminKey(key.trim());
      setAdminKey(key.trim());
      setKey('');
      setPhase('open');
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That key was not accepted.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not check that key. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'checking') {
    return (
      <div className="flex min-h-[50dvh] items-center justify-center text-on-surface-variant">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (phase === 'open') return <>{children}</>;

  return (
    <div className="mx-auto max-w-md py-10">
      <Card className="p-8">
        <p className="md-eyebrow text-tertiary">Organiser</p>
        <h1 className="md-headline-small mt-3">Dashboard sign in</h1>
        <p className="md-body-medium mt-2 text-on-surface-variant">
          Enter your admin key to manage events and ticket tiers.
        </p>

        <form onSubmit={handleSubmit} className="mt-6">
          <label htmlFor="admin-key" className="md-label-large text-on-surface-variant">
            Admin key
          </label>
          <input
            id="admin-key"
            // `password` so it is masked on screen and browsers offer to store
            // it in a password manager rather than in form autofill history.
            type="password"
            autoComplete="current-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'admin-key-error' : undefined}
            className={`md-body-large mt-1.5 h-14 w-full rounded-sm border bg-transparent px-4 text-on-surface transition-colors focus:border-2 focus:outline-none ${
              error ? 'border-error focus:border-error' : 'border-outline focus:border-primary'
            }`}
          />

          {error && (
            <p id="admin-key-error" role="alert" className="md-body-small mt-2 text-error">
              {error}
            </p>
          )}

          {/* Gold: this is the organiser side of the product. */}
          <Button
            type="submit"
            variant="gold"
            full
            busy={busy}
            busyLabel="Checking…"
            className="mt-6"
            disabled={key.trim().length === 0}
          >
            Sign in
          </Button>
        </form>

        <p className="md-body-small mt-4 text-on-surface-variant">
          The key is kept for this browser tab only, and is forgotten when you
          close it.
        </p>
      </Card>
    </div>
  );
}

/** Signs the operator out. Rendered in the dashboard header. */
export function AdminSignOut() {
  return (
    <Button
      variant="danger"
      onClick={() => {
        clearAdminKey();
        // A full reload rather than router state: it guarantees nothing fetched
        // under the old key is still sitting in a component somewhere.
        window.location.assign('/admin');
      }}
    >
      Sign out
    </Button>
  );
}
