/**
 * Transient notices for failures that belong to no particular field.
 *
 * The rule this implements: match an error's treatment to its blast radius. A
 * bad phone number belongs under the phone input. A panel that threw belongs in
 * that panel. But "your connection dropped" belongs to the whole page, and
 * putting it inline means a buyer who has scrolled past that spot never sees
 * it — they just watch a button do nothing and conclude the site is broken.
 *
 * Top-centre and fixed, so it is found without scrolling on a phone held in one
 * hand. It never blocks: nothing here is a modal, because a network blip must
 * not take the page hostage.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'info';
}

interface ToastApi {
  /** Shows a notice. Returns nothing — callers must not depend on dismissal. */
  notify: (message: string, tone?: Toast['tone']) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Falls back to a no-op rather than throwing when no provider is mounted.
 *
 * A missing provider is a wiring mistake, and turning that into a crash inside
 * an error handler means the failure that was being reported is replaced by a
 * worse one. The console line is enough to find it.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api) return api;

  return {
    notify: (message) => console.warn('[toast: no provider mounted]', message),
  };
}

const DISMISS_AFTER_MS = 6_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'error') => {
    const id = Date.now() + Math.random();

    setToasts((current) => {
      // Repeating the same message is how a retry loop turns into a wall of
      // identical boxes. One is the information; five is noise.
      if (current.some((toast) => toast.message === message)) return current;
      return [...current, { id, message, tone }];
    });

    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      DISMISS_AFTER_MS,
    );
  }, []);

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 p-4"
        // Announced without stealing focus — a buyer mid-form must not be
        // interrupted, only told.
        role="status"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ type: 'spring', stiffness: 300, damping: 26 }}
              className={
                toast.tone === 'error'
                  ? 'pointer-events-auto max-w-md rounded-sm bg-error-container px-4 py-3 text-on-error-container shadow-lg'
                  : 'pointer-events-auto max-w-md rounded-sm bg-surface-container-highest px-4 py-3 text-on-surface shadow-lg'
              }
            >
              <p className="md-body-medium">{toast.message}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
