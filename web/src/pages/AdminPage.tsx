/**
 * The organiser dashboard.
 *
 * Everything an operator needs to get an event on sale, and nothing else. The
 * list answers "what have I got and is it live", and the form answers "put this
 * one up". Sales figures live on the event itself, because that is where the
 * question is actually asked.
 *
 * Gold for primary actions, blue for links and navigation — the organiser side
 * of the product is a tint shift, not a different app.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { AdminGate, AdminSignOut } from '@/admin/AdminGate';
import { EventForm } from '@/admin/EventForm';
import {
  createEvent,
  listEvents,
  updateEvent,
  type AdminEvent,
  type EventInput,
  type EventStatus,
} from '@/admin/adminApi';

const STATUS_TONE: Record<EventStatus, 'neutral' | 'gold' | 'gone'> = {
  draft: 'gone',
  published: 'gold',
  closed: 'neutral',
  cancelled: 'gone',
};

function when(event: AdminEvent): string {
  return new Intl.DateTimeFormat('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: event.timezone,
  }).format(new Date(event.startsAt));
}

function EventRow({ event, onEdit }: { event: AdminEvent; onEdit: () => void }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="md-title-medium text-on-surface">{event.name}</h3>
            <Badge tone={STATUS_TONE[event.status]}>{event.status}</Badge>
            {event.archivedAt && <Badge tone="gone">archived</Badge>}
          </div>

          <p className="md-data-medium mt-1.5 text-on-surface-variant">{when(event)}</p>
          {event.venue && (
            <p className="md-body-medium text-on-surface-variant">{event.venue}</p>
          )}
          <p className="md-data-small mt-1 text-on-surface-variant">/events/{event.slug}</p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outlined" onClick={onEdit} className="h-10 px-4">
            Edit
          </Button>
          <Link
            to={`/admin/events/${event.id}`}
            className="md-state md-label-large inline-flex h-10 items-center justify-center rounded-full bg-tertiary-container px-4 text-on-tertiary-container"
          >
            <span className="md-state-layer" aria-hidden="true" />
            <span className="relative">Tickets &amp; sales</span>
          </Link>
        </div>
      </div>
    </Card>
  );
}

function Dashboard() {
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminEvent | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoadError(null);
    listEvents()
      .then((r) => setEvents(r.events))
      .catch((caught: unknown) =>
        setLoadError(
          caught instanceof ApiError ? caught.message : 'Could not load your events.',
        ),
      );
  }, []);

  useEffect(load, [load]);

  async function handleSubmit(body: EventInput) {
    setSaving(true);
    setSaveError(null);
    try {
      if (editing && editing !== 'new') {
        await updateEvent(editing.id, body);
      } else {
        await createEvent(body);
      }
      setEditing(null);
      load();
    } catch (caught) {
      setSaveError(caught);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="md-eyebrow text-tertiary">Organiser</p>
        <h1 className="md-headline-medium mt-3 mb-8">
          {editing === 'new' ? 'New event' : `Edit ${editing.name}`}
        </h1>

        <EventForm
          existing={editing === 'new' ? undefined : editing}
          onSubmit={handleSubmit}
          onCancel={() => {
            setEditing(null);
            setSaveError(null);
          }}
          submitting={saving}
          error={saveError}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="md-eyebrow text-tertiary">Organiser</p>
          <h1 className="md-headline-medium mt-3">Your events</h1>
        </div>

        <div className="flex items-center gap-2">
          <AdminSignOut />
          <Button variant="gold" onClick={() => setEditing('new')}>
            New event
          </Button>
        </div>
      </div>

      {!events && !loadError && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full rounded-md" />
          <Skeleton className="h-28 w-full rounded-md" />
        </div>
      )}

      {loadError && (
        <ErrorState title="We could not load your events" body={loadError} onRetry={load} />
      )}

      {events && events.length === 0 && (
        <EmptyState
          title="No events yet"
          body="Create your first one and it will appear here. Drafts stay hidden from buyers until you publish."
          action={
            <Button variant="gold" onClick={() => setEditing('new')}>
              Create an event
            </Button>
          }
        />
      )}

      {events && events.length > 0 && (
        <div className="space-y-3">
          {events.map((event) => (
            <EventRow key={event.id} event={event} onEdit={() => setEditing(event)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminPage() {
  return (
    <AdminGate>
      <Dashboard />
    </AdminGate>
  );
}
