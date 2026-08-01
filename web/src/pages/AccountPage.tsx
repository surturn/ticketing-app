/**
 * My tickets.
 *
 * The reason an account exists at all: one place that survives a lost email and
 * a new phone. Guest buyers still get everything by email, so this is a
 * convenience rather than a gate.
 */
import { Link } from 'react-router-dom';
import { fetchMyOrders } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/auth/AuthProvider';
import { AccountPanel } from '@/auth/AccountPanel';
import { SignInPanel } from '@/auth/SignInPanel';
import {
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@/components/ui';

const STATUS_TONE: Record<string, 'neutral' | 'gold' | 'gone'> = {
  paid: 'gold',
  awaiting_payment: 'neutral',
  pending: 'neutral',
  failed: 'gone',
  expired: 'gone',
  cancelled: 'gone',
};

const STATUS_LABEL: Record<string, string> = {
  paid: 'Confirmed',
  awaiting_payment: 'Awaiting payment',
  pending: 'Pending',
  failed: 'Payment failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

function OrderList() {
  const { data, loading, error, reload } = useAsync(fetchMyOrders);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return <ErrorState body={error} onRetry={reload} />;
  }

  if (!data || data.orders.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        body="Once you buy a ticket it will appear here — including anything you bought as a guest with this email address."
        action={<ButtonLink to="/">Browse events</ButtonLink>}
      />
    );
  }

  return (
    <div className="space-y-3">
      {data.orders.map((order) => (
        <Link
          key={order.reference}
          to={`/orders/${order.reference}`}
          className="block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Card interactive className="flex items-center justify-between gap-4 p-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="md-data-medium text-on-surface-variant">
                  {order.reference}
                </span>
                <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>
                  {STATUS_LABEL[order.status] ?? order.status}
                </Badge>
              </div>
              <p className="md-body-medium mt-1.5 text-on-surface-variant">
                {new Date(order.createdAt).toLocaleDateString('en-KE', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </div>

            <span className="shrink-0 font-bold text-on-surface tabular-nums">
              {formatMoney(order.totalCents, order.currency)}
            </span>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export function AccountPage() {
  const { status, accountsAvailable } = useAuth();

  if (!accountsAvailable) {
    return (
      <EmptyState
        title="Accounts are unavailable"
        body="You can still buy tickets as a guest — they are emailed to you and work exactly the same at the gate."
        action={<ButtonLink to="/">Browse events</ButtonLink>}
      />
    );
  }

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md">
        <SignInPanel />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <AccountPanel />

      <section>
        <h2 className="md-eyebrow mb-4 text-on-surface-variant">
          Your orders
        </h2>
        <OrderList />
      </section>
    </div>
  );
}
