import { EmptyState, ButtonLink } from '@/components/ui';

/**
 * The client-side 404.
 *
 * Reached when the server's SPA fallback served the app for a path the router
 * does not know — usually a mistyped or expired link. It offers the events list
 * rather than an apology, since that is where the person was trying to get.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg py-12">
      <EmptyState
        title="That page does not exist"
        body="The link may be out of date. If you were looking for a ticket, it is in your confirmation email — or sign in to see everything you have bought."
        action={<ButtonLink to="/">Browse events</ButtonLink>}
      />
    </div>
  );
}
