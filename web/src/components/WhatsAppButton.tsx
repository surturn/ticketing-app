/**
 * The fastest way to reach us, on the pages where somebody is stuck.
 *
 * WhatsApp rather than email because of where this product is used: a buyer at
 * a gate whose ticket has not arrived, or an organiser deciding whether to
 * trust us with a sale, both want an answer in minutes. Email is the channel
 * people use when they have already decided to wait.
 *
 * The number lives here and nowhere else. It is on two pages and will end up on
 * more, and a phone number pasted per page is one that gets changed in three
 * places and missed in the fourth.
 */
import type { ReactNode } from 'react';

/** Invonics, in the form `wa.me` expects: digits only, no `+`, no spaces. */
const WHATSAPP_NUMBER = '254786669572';

/** The same number as a human reads it. */
export const WHATSAPP_DISPLAY = '+254 786 669 572';

/**
 * Builds the deep link, with the message pre-filled where the caller knows the
 * context. Someone arriving from the host page and someone whose ticket is
 * missing need different first sentences, and typing it yourself while
 * frustrated is friction we can remove.
 */
export function whatsAppLink(prefill?: string): string {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return prefill ? `${base}?text=${encodeURIComponent(prefill)}` : base;
}

/** The glyph on its own, for anywhere a WhatsApp shortcut needs just the mark. */
export function WhatsAppGlyph({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.53.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.12-.15.16-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.47c-.16 0-.43.06-.65.31-.22.25-.85.84-.85 2.04 0 1.2.87 2.36.99 2.53.12.16 1.71 2.61 4.14 3.66.58.25 1.03.4 1.38.51.58.19 1.11.16 1.53.1.47-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.11-.22-.17-.47-.29Z" />
    </svg>
  );
}

export function WhatsAppButton({
  prefill,
  children = 'Chat on WhatsApp',
  variant = 'filled',
  className,
}: {
  prefill?: string;
  children?: ReactNode;
  /** `filled` where this is the primary way to reach us; `outlined` beside another action. */
  variant?: 'filled' | 'outlined';
  className?: string;
}) {
  const base =
    'md-state md-label-large trimmed inline-flex h-12 items-center justify-center gap-2 px-6 transition-colors';

  const skin =
    variant === 'filled'
      ? 'bg-primary text-on-primary'
      : 'border border-outline text-on-surface';

  return (
    <a
      href={whatsAppLink(prefill)}
      target="_blank"
      // `noreferrer` alongside `noopener`: this leaves for a third party, and
      // the referrer would carry the page a buyer was stuck on.
      rel="noopener noreferrer"
      className={[base, skin, className].filter(Boolean).join(' ')}
    >
      <span className="md-state-layer" aria-hidden="true" />
      {/* The glyph, drawn rather than loaded: one more network request on a page
          someone reaches when something has already gone wrong is the wrong
          trade, and an icon font would be far heavier than this path. */}
      <WhatsAppGlyph className="relative size-5" />
      <span className="relative">{children}</span>
    </a>
  );
}
