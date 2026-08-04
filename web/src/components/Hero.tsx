/**
 * A photograph with the page's type laid over it.
 *
 * The one component that owns the relationship between an image and the words
 * on top of it. Screens pass content and never touch the scrim, because the
 * scrim is the contrast guarantee: an organiser can replace the photograph with
 * anything, and the type has to stay legible over whatever arrives.
 *
 * `blurred` is for a poster standing in for a hero. A 4:5 poster stretched
 * across 16:9 is the wrong crop of the wrong composition, so it becomes a
 * backdrop — scaled up past the frame, blurred, and darkened — rather than
 * being displayed as though it were the photograph it is not.
 */
import type { ReactNode } from 'react';

export function Hero({
  src,
  alt,
  eager = false,
  blurred = false,
  className,
  children,
}: {
  src: string;
  alt: string;
  /** The homepage and event-page heroes are the LCP element. Everything else waits. */
  eager?: boolean;
  blurred?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`relative isolate overflow-hidden ${className ?? ''}`}>
      <img
        src={src}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : undefined}
        decoding="async"
        className={`absolute inset-0 size-full object-cover ${
          blurred ? 'scale-110 blur-2xl brightness-[0.55]' : ''
        }`}
      />
      <div className="hero-scrim" aria-hidden="true" />
      <div className="relative">{children}</div>
    </section>
  );
}
