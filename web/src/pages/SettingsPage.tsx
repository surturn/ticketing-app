/**
 * Account settings.
 *
 * Three things, in descending order of how often they are used: change your
 * details, choose whether we email you, and close the account.
 *
 * Email is shown but not editable. It is the key orders are matched against
 * when a guest purchase is adopted into an account, so letting it be edited
 * here would silently detach a buyer from tickets they had already bought. It
 * belongs to the sign-in provider, and that is where it should change.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiFetch, updateMyProfile } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { Button, ButtonLink, Card, Field } from '@/components/ui';

/** Same permissive shape the checkout uses — the API remains the authority. */
const PHONE = /^(?:\+?254|0)?[17]\d{8}$/;

function DeleteAccount() {
  const { signOut } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/account/me', { method: 'DELETE', auth: true });
      // The Firebase identity is gone server-side; clearing the local session
      // stops the app holding a token that can no longer be refreshed.
      await signOut();
      window.location.assign('/');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'We could not close the account. Please try again.',
      );
      setBusy(false);
    }
  }

  return (
    <Card variant="outlined" className="p-6">
      <h2 className="md-title-large">Close your account</h2>
      <p className="md-body-medium mt-2 text-on-surface-variant">
        Your name, phone number and email are deleted. Tickets you have already
        bought keep working — they stay valid at the gate, and the links in your
        confirmation emails keep opening.
      </p>

      {!confirming ? (
        <div className="mt-5">
          {/* Outlined, not filled. This is destructive and irreversible, and
              §2 keeps that off the emphatic treatment: nothing on this page
              should invite a mis-tap into it. */}
          <Button variant="outlined" onClick={() => setConfirming(true)}>
            Close my account
          </Button>
        </div>
      ) : (
        <div className="mt-5">
          <p className="md-body-medium text-on-surface">
            Type <span className="md-data-medium text-error">DELETE</span> to
            confirm. This cannot be undone.
          </p>

          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type DELETE to confirm"
            autoComplete="off"
            className="md-body-large mt-3 h-12 w-full max-w-xs rounded-sm border border-outline bg-transparent px-3 font-data text-on-surface focus:border-2 focus:border-error focus:outline-none"
          />

          {error && (
            <p role="alert" className="md-body-medium mt-3 text-error">
              {error}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="outlined"
              className="border-error text-error"
              disabled={typed !== 'DELETE'}
              busy={busy}
              busyLabel="Closing…"
              onClick={() => void handleDelete()}
            >
              Permanently close
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setConfirming(false);
                setTyped('');
                setError(null);
              }}
              disabled={busy}
            >
              Keep my account
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const { status, user, session, accountsAvailable, refresh } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [optIn, setOptIn] = useState(true);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Seed the form from the session once, the first time it arrives.
   *
   * Not on every change. The session is re-announced after a save and on
   * verification changes, and an effect that reseeded each time would wipe
   * whatever the person had half-typed the moment any of those fired. After a
   * save the fields already hold what was sent, so there is nothing to reseed.
   */
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || !session) return;
    seeded.current = true;
    setName(session.user.displayName ?? user?.displayName ?? '');
    setPhone(session.user.phone ?? '');
    // Defaults to false, matching the column: announcements are opt-in, and a
    // form that arrived pre-ticked would misreport someone's actual setting.
    setOptIn(session.user.announcementsOptIn ?? false);
  }, [session, user]);

  useEffect(() => {
    if (accountsAvailable && status === 'signed-out') navigate('/signin', { replace: true });
  }, [accountsAvailable, status, navigate]);

  if (status !== 'signed-in') return null;

  const phoneError =
    touched.phone && phone.trim() !== '' && !PHONE.test(phone.replace(/[\s-]/g, ''))
      ? 'Use the number your M-Pesa is on, like 0712 345 678.'
      : null;

  const nameError =
    touched.name && name.trim().length > 0 && name.trim().length < 2
      ? 'Please enter your full name.'
      : null;

  async function handleSave(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (saving || phoneError || nameError) return;

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateMyProfile({
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(phone.trim() ? { phone: phone.replace(/[\s-]/g, '') } : {}),
      });
      await apiFetch('/api/account/announcements', {
        method: 'PUT',
        auth: true,
        body: { optIn },
      });

      /**
       * Re-announce the session so the rest of the app sees the change.
       *
       * Without this the write lands but nothing re-reads it: the provider is
       * still holding the session fetched at sign-in, so the header keeps the
       * old first name, the account panel keeps the old details, and coming
       * back to this page repopulates the fields from the stale copy. From the
       * outside that is indistinguishable from the save having failed —
       * which is exactly how it was reported.
       */
      await refresh();
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'We could not save those changes.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <p className="md-eyebrow text-on-surface-variant">Your account</p>
        <h1 className="md-headline-large mt-2">Settings</h1>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSave} className="space-y-5">
          <div>
            <p className="md-label-large text-on-surface-variant">Email</p>
            <p className="md-data-medium mt-1 text-on-surface">{user?.email}</p>
            <p className="md-body-small mt-1 text-on-surface-variant">
              Your tickets are sent here, and it is how past guest orders find
              your account. It cannot be changed.
            </p>
          </div>

          <Field
            label="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            error={nameError}
            valid={!nameError && name.trim().length >= 2}
            autoComplete="name"
          />

          <Field
            label="M-Pesa number"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
            error={phoneError}
            valid={!phoneError && PHONE.test(phone.replace(/[\s-]/g, ''))}
            autoComplete="tel"
            hint="Used to fill in checkout faster."
          />

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={optIn}
              onChange={(e) => setOptIn(e.target.checked)}
              className="mt-1 size-5 shrink-0 accent-[var(--md-primary)]"
            />
            <span>
              <span className="md-body-large text-on-surface">
                Email me when new events go on sale
              </span>
              <span className="md-body-small mt-0.5 block text-on-surface-variant">
                Ticket confirmations are always sent, whatever you choose here.
              </span>
            </span>
          </label>

          {error && (
            <p role="alert" className="md-body-medium text-error">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" busy={saving} busyLabel="Saving…">
              Save changes
            </Button>
            <ButtonLink to="/account" variant="text">
              Back
            </ButtonLink>
            {saved && (
              <span className="md-body-medium text-success" role="status">
                Saved
              </span>
            )}
          </div>
        </form>
      </Card>

      <DeleteAccount />
    </div>
  );
}
