/**
 * What a visitor sees when a route fails to load or a screen throws.
 *
 * Without an `errorElement`, React Router renders its own developer page —
 * a stack trace, a module URL, and a note addressed to "Hey developer". That is
 * the right default in development and precisely the wrong thing on a live
 * storefront: it tells a buyer nothing they can act on, and it leaks build
 * internals to anyone who trips over it.
 *
 * Two failures reach here and they deserve different words:
 *
 *   - A chunk that would not load. Almost always a deploy that happened while
 *     the tab was open, which a reload fixes. `lazyRoute` already attempts that
 *     once automatically; arriving here means the retry did not help, so the
 *     button is offered rather than another silent attempt.
 *   - Anything else a screen threw. Genuinely unexpected, and honest about it.
 */
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button, ButtonLink } from '@/components/ui';

function isChunkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
}

export function RouteError() {
  const error = useRouteError();

  // A 404 from the router itself — a URL that matches no route.
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="md-headline-medium">That page does not exist</h1>
        <p className="md-body-large mt-3 text-on-surface-variant">
          The link may be out of date, or the event may have finished.
        </p>
        <div className="mt-8 flex justify-center">
          <ButtonLink to="/">Browse events</ButtonLink>
        </div>
      </div>
    );
  }

  const stale = isChunkFailure(error);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="md-headline-medium">
        {stale ? 'This page needs a refresh' : 'Something went wrong'}
      </h1>

      <p className="md-body-large mt-3 text-on-surface-variant">
        {stale
          ? 'We updated the site while this tab was open, so part of it is out of date. Reloading will fix it — nothing you were doing has been lost.'
          : 'That screen failed to load. Reloading usually clears it.'}
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button onClick={() => window.location.reload()}>Reload the page</Button>
        <ButtonLink to="/" variant="outlined">
          Back to events
        </ButtonLink>
      </div>

      {/* The technical detail stays in the console, where it is useful, rather
          than on screen where it is not. */}
      <p className="md-body-small mt-6 text-on-surface-variant">
        If this keeps happening, your tickets are still safe — they are in your
        email, and at the link in your confirmation.
      </p>
    </div>
  );
}
