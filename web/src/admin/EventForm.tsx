/**
 * Create or edit an event.
 *
 * The field set mirrors `eventFields` in admin.routes.ts exactly, including the
 * constraints, so the common mistakes are caught while the operator is still
 * looking at the form rather than coming back as a 400 they have to decode.
 *
 * Two things this form does that the API cannot do for it: it derives the slug
 * from the name, because nobody wants to invent URL-safe strings by hand; and
 * it works in local wall-clock time, converting to and from ISO only at the
 * boundary. An organiser thinks "doors at 7pm", not "16:00 UTC".
 */
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui';
import type { AdminEvent, EventInput, EventStatus } from './adminApi';

/** Lowercase, hyphenated, no runs — matches the API's `^[a-z0-9-]+$`. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * An ISO instant as the value a `datetime-local` input expects.
 *
 * The input has no concept of a time zone: it shows whatever wall-clock string
 * it is given. Rendering the event's own zone rather than the browser's is what
 * makes an organiser in Nairobi editing a Nairobi event see the time they
 * typed, even when they are travelling.
 */
function toLocalInput(iso: string | null, timezone: string): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * The inverse: a wall-clock string in `timezone`, as a real instant.
 *
 * Done by measuring the zone's offset at that moment rather than assuming a
 * fixed one, so a date on the far side of a DST change converts correctly.
 * Kenya does not observe DST, but an event listed in another zone would.
 */
function fromLocalInput(local: string, timezone: string): string | undefined {
  if (!local) return undefined;

  const naive = new Date(`${local}:00Z`);
  if (Number.isNaN(naive.getTime())) return undefined;

  const shown = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(naive);
  const get = (t: string) => Number(shown.find((p) => p.type === t)?.value ?? '0');

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  const offset = asUtc - naive.getTime();
  return new Date(naive.getTime() - offset).toISOString();
}

/** Pulls per-field messages out of the API's Zod issue list. */
function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const issues = error.details;
  if (!Array.isArray(issues)) return {};

  const out: Record<string, string> = {};
  for (const issue of issues as { path?: unknown[]; message?: string }[]) {
    const key = Array.isArray(issue.path) ? String(issue.path[0] ?? '') : '';
    if (key && issue.message && !out[key]) out[key] = issue.message;
  }
  return out;
}

const STATUSES: { value: EventStatus; label: string; hint: string }[] = [
  { value: 'draft', label: 'Draft', hint: 'Hidden from buyers. Safe to work on.' },
  { value: 'published', label: 'Published', hint: 'Live, and announced to subscribers.' },
  { value: 'closed', label: 'Closed', hint: 'Visible, but no longer selling.' },
  { value: 'cancelled', label: 'Cancelled', hint: 'Called off.' },
];

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="md-label-large text-on-surface-variant">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p role="alert" className="md-body-small mt-1 text-error">
          {error}
        </p>
      ) : hint ? (
        <p className="md-body-small mt-1 text-on-surface-variant">{hint}</p>
      ) : null}
    </label>
  );
}

const inputClass = (invalid?: boolean) =>
  `md-body-large h-12 w-full rounded-sm border bg-transparent px-3 text-on-surface transition-colors focus:border-2 focus:outline-none ${
    invalid ? 'border-error focus:border-error' : 'border-outline focus:border-primary'
  }`;

export function EventForm({
  existing,
  onSubmit,
  onCancel,
  submitting,
  error,
}: {
  existing?: AdminEvent;
  onSubmit: (body: EventInput) => void | Promise<void>;
  onCancel: () => void;
  submitting: boolean;
  error: unknown;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  // Once an event is live its slug is a URL people have shared. Editing it
  // silently breaks every one of those links, so it is only auto-derived while
  // the operator has not taken control of it, and never on an existing event.
  const [slugTouched, setSlugTouched] = useState(Boolean(existing));
  const [description, setDescription] = useState(existing?.description ?? '');
  const [venue, setVenue] = useState(existing?.venue ?? '');
  const [posterUrl, setPosterUrl] = useState(existing?.posterUrl ?? '');
  const [timezone, setTimezone] = useState(existing?.timezone ?? 'Africa/Nairobi');
  const [currency, setCurrency] = useState(existing?.currency ?? 'KES');
  const [status, setStatus] = useState<EventStatus>(existing?.status ?? 'draft');
  const [startsAt, setStartsAt] = useState(
    toLocalInput(existing?.startsAt ?? null, existing?.timezone ?? 'Africa/Nairobi'),
  );
  const [endsAt, setEndsAt] = useState(
    toLocalInput(existing?.endsAt ?? null, existing?.timezone ?? 'Africa/Nairobi'),
  );

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  const remote = fieldErrors(error);
  const generalError =
    error instanceof ApiError && Object.keys(remote).length === 0 ? error.message : null;

  const posterLooksInsecure = posterUrl.trim() !== '' && !posterUrl.trim().startsWith('https://');

  function handleSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (submitting) return;

    const start = fromLocalInput(startsAt, timezone);
    if (!start) return;

    void onSubmit({
      slug: slug.trim(),
      name: name.trim(),
      // Empty optional strings are omitted rather than sent as "": the schema
      // requires at least one character when the key is present.
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(venue.trim() ? { venue: venue.trim() } : {}),
      ...(posterUrl.trim() ? { posterUrl: posterUrl.trim() } : {}),
      timezone,
      currency: currency.trim().toUpperCase(),
      startsAt: start,
      ...(endsAt ? { endsAt: fromLocalInput(endsAt, timezone) } : {}),
      status,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field label="Event name" error={remote.name}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          placeholder="Sample Summit 2026"
          className={inputClass(Boolean(remote.name))}
        />
      </Field>

      <Field
        label="Link"
        hint={`Buyers will see /events/${slug || 'your-event'}`}
        error={remote.slug}
      >
        <input
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
          required
          maxLength={120}
          className={`${inputClass(Boolean(remote.slug))} font-data`}
        />
      </Field>

      <Field label="Venue" error={remote.venue}>
        <input
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          maxLength={200}
          placeholder="KICC, Nairobi"
          className={inputClass(Boolean(remote.venue))}
        />
      </Field>

      <Field
        label="Poster URL"
        hint="Must start with https:// — browsers block insecure images on a secure page."
        error={remote.posterUrl ?? (posterLooksInsecure ? 'Must be an https:// URL.' : undefined)}
      >
        <input
          value={posterUrl}
          onChange={(e) => setPosterUrl(e.target.value)}
          inputMode="url"
          maxLength={2000}
          placeholder="https://…"
          className={inputClass(Boolean(remote.posterUrl) || posterLooksInsecure)}
        />
      </Field>

      {/* Shown at the ratio the storefront actually crops to, so a poster that
          will lose its title to the crop is obvious now rather than after
          publishing. */}
      {posterUrl.trim() && !posterLooksInsecure && (
        <div>
          <p className="md-label-large text-on-surface-variant">Preview</p>
          <img
            src={posterUrl.trim()}
            alt=""
            className="mt-1.5 aspect-4/5 w-36 rounded-md border border-outline-variant object-cover object-top"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      )}

      <Field label="Description" error={remote.description}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={5000}
          className="md-body-large w-full rounded-sm border border-outline bg-transparent px-3 py-2 text-on-surface transition-colors focus:border-2 focus:border-primary focus:outline-none"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Starts" hint={`Local time in ${timezone}`} error={remote.startsAt}>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            required
            className={inputClass(Boolean(remote.startsAt))}
          />
        </Field>

        <Field label="Ends" hint="Optional" error={remote.endsAt}>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={inputClass(Boolean(remote.endsAt))}
          />
        </Field>

        <Field label="Time zone" error={remote.timezone}>
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            required
            className={`${inputClass(Boolean(remote.timezone))} font-data`}
          />
        </Field>

        <Field label="Currency" error={remote.currency}>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            required
            maxLength={3}
            className={`${inputClass(Boolean(remote.currency))} font-data`}
          />
        </Field>
      </div>

      <Field
        label="Status"
        hint={STATUSES.find((s) => s.value === status)?.hint}
        error={remote.status}
      >
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as EventStatus)}
          className={inputClass(Boolean(remote.status))}
        >
          {STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {status === 'published' && existing?.status !== 'published' && (
        // Publishing enqueues an announcement to every subscriber. That is not
        // reversible by editing the event afterwards, so it is said plainly
        // before the button rather than discovered from the outbox.
        <p className="md-body-medium rounded-sm bg-tertiary-container px-4 py-3 text-on-tertiary-container">
          Publishing emails your subscriber list. Save as a draft first if you
          are still working on it.
        </p>
      )}

      {generalError && (
        <p role="alert" className="md-body-medium text-error">
          {generalError}
        </p>
      )}

      <div className="flex flex-wrap gap-3 pt-2">
        <Button type="submit" variant="gold" busy={submitting} busyLabel="Saving…">
          {existing ? 'Save changes' : 'Create event'}
        </Button>
        <Button type="button" variant="outlined" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
