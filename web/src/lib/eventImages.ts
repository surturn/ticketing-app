/**
 * Which image stands in for an event, and how to treat it.
 *
 * One definition, because the alternative is each surface inventing its own —
 * and the failure mode of that is a page that renders a blank banner for the
 * majority of events, which is exactly the state of the listing today. Every
 * event has *something*: its hero, or its poster, or the house photograph.
 *
 * `blurred` is the instruction to the caller: a poster standing in for a hero
 * is the wrong crop and the wrong composition, so it is blurred and darkened
 * to become a backdrop rather than being stretched across 16:9 and left to look
 * like a mistake. A real hero is shown sharp.
 */
import type { EventCategory, EventSummary } from './api';

/** The house photograph. Shipped, optimised, and the last resort. */
export const DEFAULT_HERO = '/hero/default-hero.webp';

export function heroFor(
  event: Pick<EventSummary, 'heroUrl' | 'posterUrl'>,
): { src: string; blurred: boolean } {
  if (event.heroUrl) return { src: event.heroUrl, blurred: false };
  if (event.posterUrl) return { src: event.posterUrl, blurred: true };
  return { src: DEFAULT_HERO, blurred: false };
}

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  music: 'Music',
  comedy: 'Comedy',
  business: 'Business',
  sports: 'Sports',
  festival: 'Festivals',
  arts: 'Arts',
  other: 'More',
};

/** Display order for the homepage's category sections and the filter row. */
export const CATEGORY_ORDER: EventCategory[] = [
  'music',
  'comedy',
  'festival',
  'business',
  'sports',
  'arts',
  'other',
];
