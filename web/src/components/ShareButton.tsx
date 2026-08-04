/**
 * A share affordance for an event.
 *
 * The Web Share API first — on a phone this hands off to whatever the buyer
 * already sends a friend a link with, WhatsApp chief among them in this
 * market, which is worth more than any share sheet this app could draw
 * itself. Where the API does not exist — most desktop browsers, still — it
 * falls back to copying the link, the same action with one extra step, and
 * says so with a toast rather than leaving the buyer to guess whether the tap
 * did anything.
 *
 * Both call sites place this beside or inside a card that is itself a link to
 * the event, so the click is stopped from reaching that ancestor — a share tap
 * must not also navigate away from the page the buyer meant to share.
 */
import type { MouseEvent } from 'react';
import { useToast } from './Toasts';

export function ShareButton({
  url,
  title,
  className = '',
}: {
  /** The absolute URL to share — a relative path means nothing outside this tab. */
  url: string;
  title: string;
  className?: string;
}) {
  const { notify } = useToast();

  async function handleShare(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // Rejects when the buyer cancels the share sheet, same as backing out
        // of any other picker — not a failure worth reporting.
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied', 'info');
    } catch {
      // Clipboard access can be blocked outright (permissions, insecure
      // context). The address bar still has the link, so this is a nudge
      // rather than a dead end.
      notify('Could not copy the link — copy it from the address bar instead.');
    }
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label={`Share ${title}`}
      title="Share"
      className={`md-state relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-on-surface-variant transition-colors hover:text-on-surface ${className}`}
    >
      <span className="md-state-layer" aria-hidden="true" />
      <svg viewBox="0 0 20 20" className="relative size-4" fill="none" aria-hidden="true">
        <circle cx="15" cy="5" r="2.3" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="15" cy="15" r="2.3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 8.8 13 5.6M7 11.2l6 3.2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  );
}
