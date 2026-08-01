/**
 * One event, from the organiser's side: what it is selling and how that is going.
 *
 * An event with no tiers cannot take a shilling, so the tier editor is the
 * primary thing on this page and the numbers sit above it as context. Sold and
 * reserved are shown separately on purpose — reserved is money that has not
 * arrived yet, and treating the two as one number is how an organiser ends up
 * believing they sold out when a batch of holds is about to lapse.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { Badge, Button, Card, ErrorState, Skeleton } from '@/components/ui';
import { AdminGate } from '@/admin/AdminGate';
import {
  createTier,
  getStats,
  listEvents,
  listTiers,
  updateTier,
  type AdminEvent,
  type AdminTier,
  type EventStats,
  type TierInput,
  type TierStatus,
} from '@/admin/adminApi';

const TIER_STATUSES: TierStatus[] = ['active', 'paused', 'hidden', 'closed'];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="md-eyebrow text-on-surface-variant">{label}</p>
      <p className="md-data-large mt-2 text-2xl text-on-surface">{value}</p>
      {hint && <p className="md-body-small mt-1 text-on-surface-variant">{hint}</p>}
    </div>
  );
}

const inputClass =
  'md-body-large h-12 w-full rounded-sm border border-outline bg-transparent px-3 text-on-surface transition-colors focus:border-2 focus:border-primary focus:outline-none';

/**
 * Add or edit a tier.
 *
 * Prices are entered in shillings and converted to cents at the boundary. The
 * API takes cents, but nobody prices a ticket in cents, and asking an operator
 * to multiply by a hundred is how a ticket ends up costing 15 shillings instead
 * of 1,500.
 */
function TierEditor({
  eventId,
  currency,
  existing,
  onDone,
  onCancel,
}: {
  eventId: string;
  currency: string;
  existing?: AdminTier;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [price, setPrice] = useState(
    existing ? String(existing.priceCents / 100) : '',
  );
  const [capacity, setCapacity] = useState(
    existing?.quantityTotal === null || existing?.quantityTotal === undefined
      ? ''
      : String(existing.quantityTotal),
  );
  const [maxPerOrder, setMaxPerOrder] = useState(String(existing?.maxPerOrder ?? 10));
  const [status, setStatus] = useState<TierStatus>(existing?.status ?? 'active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (busy) return;

    const shillings = Number(price);
    if (!Number.isFinite(shillings) || shillings < 0) {
      setError('Enter a price in shillings, like 1500.');
      return;
    }
    // Rounded, not truncated: 1500.005 from a float should not silently become
    // 1500.00 and leave the organiser a cent short on every sale.
    const priceCents = Math.round(shillings * 100);

    const body: TierInput = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      priceCents,
      // Empty means uncapped, which the API models as null rather than zero.
      quantityTotal: capacity.trim() === '' ? null : Number(capacity),
      minPerOrder: 1,
      maxPerOrder: Number(maxPerOrder) || 10,
      status,
      sortOrder: existing?.sortOrder ?? 0,
    };

    setBusy(true);
    setError(null);
    try {
      if (existing) await updateTier(existing.id, body);
      else await createTier(eventId, body);
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that tier.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card variant="outlined" className="p-5">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="md-label-large text-on-surface-variant">Tier name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder="Regular"
              className={`${inputClass} mt-1.5`}
            />
          </label>

          <label className="block">
            <span className="md-label-large text-on-surface-variant">
              Price ({currency})
            </span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
              inputMode="decimal"
              placeholder="1500"
              className={`${inputClass} mt-1.5 font-data`}
            />
          </label>

          <label className="block">
            <span className="md-label-large text-on-surface-variant">Capacity</span>
            <input
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              inputMode="numeric"
              placeholder="Leave blank for unlimited"
              className={`${inputClass} mt-1.5 font-data`}
            />
            <span className="md-body-small mt-1 block text-on-surface-variant">
              Blank sells without a limit.
            </span>
          </label>

          <label className="block">
            <span className="md-label-large text-on-surface-variant">Max per order</span>
            <input
              value={maxPerOrder}
              onChange={(e) => setMaxPerOrder(e.target.value)}
              inputMode="numeric"
              className={`${inputClass} mt-1.5 font-data`}
            />
          </label>
        </div>

        <label className="block">
          <span className="md-label-large text-on-surface-variant">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            placeholder="Limited release — cheapest tier"
            className={`${inputClass} mt-1.5`}
          />
        </label>

        <label className="block">
          <span className="md-label-large text-on-surface-variant">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TierStatus)}
            className={`${inputClass} mt-1.5`}
          >
            {TIER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p role="alert" className="md-body-medium text-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="gold" busy={busy} busyLabel="Saving…">
            {existing ? 'Save tier' : 'Add tier'}
          </Button>
          <Button type="button" variant="outlined" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Detail({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<AdminEvent | null>(null);
  const [tiers, setTiers] = useState<AdminTier[] | null>(null);
  const [stats, setStats] = useState<EventStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminTier | 'new' | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([listEvents(), listTiers(eventId), getStats(eventId)])
      .then(([e, t, s]) => {
        setEvent(e.events.find((x) => x.id === eventId) ?? null);
        setTiers(t.tiers);
        setStats(s);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load this event.'),
      );
  }, [eventId]);

  useEffect(load, [load]);

  if (error) return <ErrorState title="We could not load this event" body={error} onRetry={load} />;

  if (!event || !tiers || !stats) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-32 w-full rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    );
  }

  const currency = event.currency;

  return (
    <div>
      <Link to="/admin" className="md-label-large text-primary">
        ← All events
      </Link>

      <div className="mt-4 mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="md-eyebrow text-tertiary">Organiser</p>
          <h1 className="md-headline-medium mt-3">{event.name}</h1>
        </div>
        <Badge tone={event.status === 'published' ? 'gold' : 'gone'}>{event.status}</Badge>
      </div>

      {/* The four numbers that matter, per the dashboard shell in the brand
          guidelines: sold against capacity, revenue, and admissions. */}
      <Card className="mb-8 p-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Tickets sold"
            value={String(stats.inventory.sold)}
            hint={
              stats.inventory.hasUncappedTiers
                ? 'Some tiers are uncapped'
                : `of ${stats.inventory.cappedCapacity} capacity`
            }
          />
          <Stat
            label="Revenue"
            value={formatMoney(stats.revenue.grossCents, currency)}
            hint={`${stats.revenue.paidOrders} paid orders`}
          />
          <Stat
            label="On hold"
            value={String(stats.inventory.reserved)}
            hint="Reserved, not yet paid"
          />
          <Stat
            label="Checked in"
            value={String(stats.admissions.checkedIn)}
            hint={`of ${stats.admissions.issued} issued`}
          />
        </div>

        {stats.attention.refundRequired > 0 && (
          <p className="md-body-medium mt-6 rounded-sm bg-error-container px-4 py-3 text-on-error-container">
            {stats.attention.refundRequired} order
            {stats.attention.refundRequired === 1 ? '' : 's'} need attention — paid but
            not fulfilled.
          </p>
        )}
      </Card>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="md-title-large">Ticket tiers</h2>
        {!editing && (
          <Button variant="gold" onClick={() => setEditing('new')}>
            Add tier
          </Button>
        )}
      </div>

      {editing && (
        <div className="mb-4">
          <TierEditor
            eventId={eventId}
            currency={currency}
            existing={editing === 'new' ? undefined : editing}
            onDone={() => {
              setEditing(null);
              load();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {tiers.length === 0 && !editing ? (
        <Card className="p-8 text-center">
          <p className="md-title-medium">No tiers yet</p>
          <p className="md-body-medium mx-auto mt-2 max-w-sm text-on-surface-variant">
            An event with no tiers cannot sell anything. Add at least one — most
            events only ever need a single tier called Regular.
          </p>
          <div className="mt-6">
            <Button variant="gold" onClick={() => setEditing('new')}>
              Add the first tier
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {tiers.map((tier) => {
            const breakdown = stats.tiers.find((t) => t.tierId === tier.id);
            return (
              <Card key={tier.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="md-title-medium">{tier.name}</h3>
                      <Badge tone={tier.status === 'active' ? 'neutral' : 'gone'}>
                        {tier.status}
                      </Badge>
                    </div>
                    <p className="md-data-large mt-2">
                      {formatMoney(tier.priceCents, currency)}
                    </p>
                    <p className="md-data-small mt-1 text-on-surface-variant">
                      {breakdown?.sold ?? tier.quantitySold} sold
                      {tier.quantityTotal === null
                        ? ' · uncapped'
                        : ` of ${tier.quantityTotal}`}
                      {(breakdown?.reserved ?? tier.quantityReserved) > 0 &&
                        ` · ${breakdown?.reserved ?? tier.quantityReserved} on hold`}
                    </p>
                  </div>

                  <Button
                    variant="outlined"
                    className="h-10 px-4"
                    onClick={() => setEditing(tier)}
                  >
                    Edit
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AdminEventPage() {
  const { id = '' } = useParams();
  return (
    <AdminGate>
      <Detail eventId={id} />
    </AdminGate>
  );
}
