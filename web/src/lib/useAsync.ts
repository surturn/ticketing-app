import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/**
 * Loads something, once, with the three states every screen actually needs.
 *
 * `idle` is deliberately absent: a screen that fetches on mount is loading from
 * the first frame, and an extra state only invites a blank render before the
 * skeleton appears.
 */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Guards against the out-of-order response: navigate between two events
  // quickly and the slower request can land last, painting the wrong one.
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    load()
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
      })
      .catch((caught: unknown) => {
        if (id !== requestId.current) return;
        /**
         * Only an `ApiError` carries a message meant for a buyer to read.
         *
         * Anything else is an internal failure whose message was written for a
         * developer — "Failed to fetch", "Unexpected token < in JSON", a stack
         * from a library. Rendering those verbatim puts debug output on a
         * customer's screen and tells them nothing they can act on, so the
         * generic line stands in and the real error goes to the console where
         * it belongs.
         */
        if (caught instanceof ApiError) {
          setError(caught.message);
        } else {
          console.error('Unhandled load failure', caught);
          setError('Something went wrong at our end. Please try again.');
        }
      })
      .finally(() => {
        if (id !== requestId.current) return;
        setLoading(false);
      });
    // `load` is intentionally not a dependency: it is almost always an inline
    // closure, and including it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
