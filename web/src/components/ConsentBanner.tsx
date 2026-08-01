/**
 * The storage notice.
 *
 * This deliberately does not ask permission, because there is nothing here that
 * requires it. The service stores a theme preference and, for signed-in
 * visitors, a session — both strictly necessary, both exempt. There are no
 * advertising cookies, no analytics and no third-party trackers.
 *
 * A banner demanding consent for storage that needs none would be theatre, and
 * worse than useless: it teaches people to dismiss consent dialogs without
 * reading them, which is exactly the habit that makes the real ones fail. So
 * this informs, links to the detail, and goes away.
 *
 * The moment anything non-essential is added — analytics, a pixel, anything at
 * all — this must become a genuine choice with a working reject path, and
 * `hasOptionalConsent` below is the switch the new thing would be gated on. It
 * returns false today and will keep returning false until someone deliberately
 * changes it.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';

const STORAGE_KEY = 'eventify-storage-notice';
const OPTIONAL_KEY = 'eventify-optional-consent';

/** Whether the visitor has accepted anything beyond strictly-necessary storage. */
export function hasOptionalConsent(): boolean {
  try {
    return localStorage.getItem(OPTIONAL_KEY) === 'granted';
  } catch {
    return false;
  }
}

export function ConsentBanner() {
  // Starts hidden and is shown from an effect, so it never renders during the
  // first paint of a page that has already been acknowledged — a banner that
  // flashes on every load is its own kind of annoying.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== 'seen') setVisible(true);
    } catch {
      // Storage blocked: showing it every time would be worse than not at all,
      // since it could never be dismissed.
    }
  }, []);

  if (!visible) return null;

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, 'seen');
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  return (
    <div
      // `region` with a label rather than `dialog`: it does not trap focus and
      // nothing behind it is blocked, because there is no decision to force.
      role="region"
      aria-label="Storage notice"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-outline-variant bg-surface-container-low pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-6">
        <p className="md-body-medium flex-1 text-on-surface-variant">
          We store your theme preference and, if you sign in, your session.
          That is all — no advertising cookies, no analytics, no trackers.{' '}
          <Link to="/privacy" className="text-primary underline">
            Read the privacy notice
          </Link>
          .
        </p>

        <Button onClick={dismiss} className="shrink-0">
          Got it
        </Button>
      </div>
    </div>
  );
}
