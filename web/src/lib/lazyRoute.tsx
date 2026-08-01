/**
 * Lazy route loading that survives a deploy.
 *
 * Code splitting has one failure mode, and it is guaranteed rather than
 * unlikely: assets are content-hashed, so every deploy publishes new filenames
 * and retires the old ones. A browser holding the previous `index.html` still
 * references the retired names, and the moment that visitor navigates to a
 * split route the import 404s. React Router reports it as
 * "Failed to fetch dynamically imported module", which is accurate and useless
 * to the person reading it.
 *
 * The cure is not a nicer message. The old document is stale, and the only way
 * to obtain the current chunk names is to fetch the document again — so a
 * failed import reloads the page once, which lands the visitor on the route
 * they asked for, running the new build.
 *
 * Once, though. A reload loop is far worse than an error screen: it is
 * unrecoverable without clearing storage, and it would fire for a genuine
 * network failure too. The attempt is recorded in `sessionStorage`, so a second
 * failure for the same route falls through to the error boundary and says so
 * plainly.
 */
const RELOAD_FLAG = 'eventify-chunk-reload';

function alreadyRetried(key: string): boolean {
  try {
    return sessionStorage.getItem(`${RELOAD_FLAG}:${key}`) === '1';
  } catch {
    // Storage blocked. Treat as "already retried" so a private-mode visitor
    // gets the error screen rather than an endless reload.
    return true;
  }
}

function markRetried(key: string): void {
  try {
    sessionStorage.setItem(`${RELOAD_FLAG}:${key}`, '1');
  } catch {
    /* ignore */
  }
}

/** Clears the retry marks. Called once the app has successfully mounted. */
export function clearChunkRetries(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(RELOAD_FLAG)) sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Wraps a route's dynamic import with the reload-once recovery above.
 *
 * `name` identifies the route for the retry mark, so a stale chunk on one route
 * does not consume the single retry belonging to another.
 */
export function lazyRoute<T>(
  name: string,
  load: () => Promise<T>,
  // Deliberately not constrained to a module of components: a page module may
  // legitimately export a type or a helper alongside its component, and a
  // constraint on the whole module would reject it for a reason that has
  // nothing to do with routing. The picker is what has to return a component.
  pick: (module: T) => React.ComponentType,
) {
  return async () => {
    try {
      const module = await load();
      return { Component: pick(module) };
    } catch (error) {
      if (!alreadyRetried(name)) {
        markRetried(name);
        // `reload()` re-requests the document, which brings the current asset
        // names with it. The router replays the navigation afterwards because
        // the URL is unchanged.
        window.location.reload();
        // Never resolves — the reload is already in flight, and returning a
        // component here would flash a broken route first.
        return await new Promise<never>(() => undefined);
      }
      throw error;
    }
  };
}
