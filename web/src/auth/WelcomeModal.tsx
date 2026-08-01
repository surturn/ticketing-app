/**
 * The welcome, shown once.
 *
 * Fires on the sign-in that created the account — the same `created` flag the
 * welcome email is sent on — and never again. A modal on every sign-in would be
 * an obstacle between someone and the tickets they came for, which is the
 * opposite of a welcome.
 *
 * Rendered as a native `<dialog>` so the browser supplies the things a
 * hand-rolled modal usually gets wrong: focus is trapped inside it, the page
 * behind is inert, and Escape closes it without any key handling of our own.
 */
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';

export function WelcomeModal({
  name,
  linkedOrders,
  onClose,
}: {
  name: string | null;
  linkedOrders: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // `showModal` rather than the `open` attribute: only the method gives the
    // top layer, the backdrop and the focus trap.
    ref.current?.showModal();
  }, []);

  const firstName = name?.trim().split(/\s+/)[0];

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      /* `backdrop:` styles the browser's own backdrop pseudo-element. */
      className="clipped m-auto w-[min(28rem,calc(100vw-2rem))] bg-surface-container p-0 text-on-surface backdrop:bg-scrim/50"
    >
      <div className="p-6 sm:p-8">
        {/* The tear line, and the only one on this viewport. */}
        <div className="stub-edge -mx-6 mb-6 sm:-mx-8" aria-hidden="true" />

        <p className="md-eyebrow text-primary">You&rsquo;re in</p>

        <h2 className="md-headline-small mt-3">
          {firstName ? `Welcome, ${firstName}` : 'Welcome to Eventify Tickets'}
        </h2>

        <p className="md-body-large mt-3 text-on-surface-variant">
          Your account is ready. Everything you buy now lives in one place — on
          this phone, on the next one, and at the gate whether or not you have
          signal.
        </p>

        {linkedOrders > 0 && (
          // Worth saying out loud: a buyer who bought as a guest months ago has
          // no reason to expect those tickets to appear here.
          <p className="md-body-medium mt-4 bg-primary-container px-4 py-3 text-on-primary-container">
            We found {linkedOrders === 1 ? 'a ticket' : `${linkedOrders} orders`}{' '}
            you bought as a guest with this address, and added{' '}
            {linkedOrders === 1 ? 'it' : 'them'} to your account.
          </p>
        )}

        <ul className="md-body-medium mt-5 space-y-2 text-on-surface-variant">
          <li>Your tickets are always under My tickets.</li>
          <li>Every ticket still arrives by email as well.</li>
          <li>
            We only email you about new events if you asked us to — change that
            any time in{' '}
            <Link to="/account/settings" className="text-primary underline">
              settings
            </Link>
            .
          </li>
        </ul>

        <div className="mt-7 flex flex-wrap gap-3">
          <Button onClick={() => ref.current?.close()}>See my tickets</Button>
        </div>
      </div>
    </dialog>
  );
}
