/**
 * The share button that sits on a poster, and the sheet it opens.
 *
 * Discovery here runs on forwarded links, not on this site's own listing page
 * — someone decides to go because a friend sent them a poster in a WhatsApp
 * group, not because they browsed to eventify.app. This is what makes that
 * the deliberate, one-tap thing it already is by accident: the same platforms
 * a buyer already shares into, the poster itself to drop straight into a
 * story, and the raw link for everywhere else.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useToast } from './Toasts';
import { WhatsAppGlyph } from './WhatsAppButton';

export interface ShareableEvent {
  name: string;
  slug: string;
  posterUrl: string | null;
}

function eventUrl(slug: string): string {
  return `${window.location.origin}/events/${slug}`;
}

// ─── Glyphs ────────────────────────────────────────────────────────────────
// Drawn rather than loaded, like every other icon in this app — simplified
// marks that read as their platform without shipping an icon font or an
// exact reproduction of anyone's logo.

function FacebookGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="currentColor" aria-hidden="true">
      <path d="M13.5 21v-8.5H16l.4-3H13.5V7.5c0-.87.24-1.46 1.48-1.46H16.5V3.35C16.2 3.31 15.19 3.22 14 3.22c-2.44 0-4.11 1.49-4.11 4.22v2.28H7.4v3h2.49V21h3.61Z" />
    </svg>
  );
}

function InstagramGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function TelegramGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="currentColor" aria-hidden="true">
      <path d="M21.05 3.76 2.9 10.86c-1.24.5-1.23 1.19-.22 1.5l4.65 1.45 10.78-6.8c.5-.32.97-.15.59.2l-8.73 7.4-.34 3.6c.5 0 .72-.23.99-.5l2.37-2.3 4.93 3.62c.9.5 1.55.24 1.78-.83l3.22-15.16c.32-1.32-.5-1.92-1.65-1.47Z" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
      <path
        d="M12 4v10m0 0-3.5-3.5M12 14l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The trigger itself: three nodes and two lines, the shape a "share" icon
 *  takes everywhere except iOS. */
function ShareGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
      <circle cx="18" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="6" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="19" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8.2 10.7l7.6-4.4M8.2 13.3l7.6 4.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── The sheet ─────────────────────────────────────────────────────────────

function ShareSheet({ event, onClose }: { event: ShareableEvent; onClose: () => void }) {
  const { notify } = useToast();

  const url = eventUrl(event.slug);
  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(event.name);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied', 'info');
    } catch {
      notify('Could not copy the link — try selecting it instead.');
    }
  }

  async function shareToInstagram() {
    // Instagram has no public web intent for an arbitrary link the way
    // WhatsApp, Facebook and Telegram do — the closest a browser can get is
    // putting the link on the clipboard for the buyer to paste into their
    // own story or post.
    await copyLink();
    notify('Link copied — paste it into your Instagram story or post.', 'info');
  }

  async function savePoster() {
    if (!event.posterUrl) {
      notify('This event has no poster to save yet.');
      return;
    }

    try {
      const response = await fetch(event.posterUrl);
      if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${event.name.trim().replace(/\s+/g, '-').toLowerCase()}-poster.jpg`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Most likely the poster host does not answer a cross-origin fetch with
      // the headers that would allow this. Opening it directly still gets a
      // buyer to a save option — a failed download must not be a dead end.
      window.open(event.posterUrl, '_blank', 'noopener,noreferrer');
      notify('Opened the poster in a new tab — save it from there.', 'info');
    }
  }

  const platforms: Array<{
    key: string;
    label: string;
    background: string;
    light?: boolean;
    icon: ReactNode;
    action: () => void;
  }> = [
    {
      key: 'whatsapp',
      label: 'Whatsapp',
      background: '#25D366',
      icon: <WhatsAppGlyph className="size-6" />,
      action: () =>
        window.open(
          `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
          '_blank',
          'noopener,noreferrer',
        ),
    },
    {
      key: 'facebook',
      label: 'Facebook',
      background: '#1877F2',
      icon: <FacebookGlyph />,
      action: () =>
        window.open(
          `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
          '_blank',
          'noopener,noreferrer',
        ),
    },
    {
      key: 'instagram',
      label: 'Instagram',
      background: 'linear-gradient(45deg, #f9ce34, #ee2a7b, #6228d7)',
      icon: <InstagramGlyph />,
      action: () => void shareToInstagram(),
    },
    {
      key: 'telegram',
      label: 'Telegram',
      background: '#29A9EA',
      icon: <TelegramGlyph />,
      action: () =>
        window.open(
          `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
          '_blank',
          'noopener,noreferrer',
        ),
    },
    {
      key: 'save',
      label: 'Save',
      background: 'var(--md-surface-container-highest)',
      light: true,
      icon: <DownloadGlyph />,
      action: () => void savePoster(),
    },
  ];

  // Portalled to `document.body` rather than rendered where the trigger
  // lives. Every caller so far is a poster card with `content-visibility:
  // auto` for off-screen rendering cost, and CSS containment makes an
  // element like that the containing block for its `position: fixed`
  // descendants — without the portal this sheet was clipping to the card's
  // own box instead of covering the screen.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-end bg-scrim/60 sm:place-items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-sheet-title"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-t-2xl bg-surface-container-high p-6 pb-8 shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="share-sheet-title" className="md-title-large text-on-surface">
            Share
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-10 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant transition hover:text-on-surface"
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="mt-6 grid grid-cols-5 gap-2">
          {platforms.map((platform) => (
            <button
              key={platform.key}
              type="button"
              // Closed first, uniformly, whichever platform was tapped — the
              // sheet's job ended the moment a choice was made, and each
              // action's own work (a new tab, a clipboard write, a download)
              // keeps running after it is gone rather than holding it open.
              onClick={() => {
                onClose();
                platform.action();
              }}
              className="flex flex-col items-center gap-2"
            >
              <span
                className={`flex size-14 items-center justify-center rounded-full shadow ${
                  platform.light ? 'text-on-surface' : 'text-white'
                }`}
                style={{ background: platform.background }}
              >
                {platform.icon}
              </span>
              <span className="md-body-small text-on-surface-variant">{platform.label}</span>
            </button>
          ))}
        </div>

        <p className="md-label-large mt-7 text-on-surface-variant">Copy Link</p>
        <div className="mt-2 flex items-center gap-2 rounded-md border border-outline-variant px-3">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Event link"
            className="md-body-medium h-11 flex-1 truncate bg-transparent text-on-surface-variant outline-none"
          />
          <button
            type="button"
            onClick={copyLink}
            aria-label="Copy link"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition hover:bg-tertiary/14 hover:text-on-surface"
          >
            <CopyGlyph />
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

// ─── The trigger ───────────────────────────────────────────────────────────

/**
 * A circular badge meant to sit over the corner of a poster.
 *
 * Stops the click reaching whatever the poster itself is wrapped in — every
 * caller so far is a card that is also a link to the event, and opening the
 * share sheet must not also navigate away from it.
 */
export function ShareButton({
  event,
  className,
}: {
  event: ShareableEvent;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Share ${event.name}`}
        title="Share"
        className={`flex items-center justify-center rounded-full bg-surface-container-lowest/92 text-on-surface transition hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${className ?? ''}`}
      >
        <ShareGlyph />
      </button>

      <AnimatePresence>
        {open && <ShareSheet event={event} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}
