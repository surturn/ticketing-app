/**
 * Light and dark.
 *
 * Three states, not two: `system` is the default and follows the operating
 * system, and the two explicit choices are overrides. A product that ignores
 * the OS setting and defaults to its own preference is one someone has to
 * correct on every device they own.
 *
 * The choice is written to <html data-theme>, which every colour token reads.
 * Nothing else in the app knows a theme exists.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'eventify-theme';

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function storedChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    // Private mode, or storage blocked. Following the system is the right
    // fallback, and it must not throw on the way to the first render.
    return 'system';
  }
}

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
  /** Flips to the opposite of what is currently on screen. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(systemTheme);

  // Track the OS setting while `system` is selected, so changing it at sunset
  // changes the page without a reload.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => setSystemResolved(query.matches ? 'light' : 'dark');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const resolved: ResolvedTheme = choice === 'system' ? systemResolved : choice;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference simply will not persist. Not worth failing the switch over.
    }
  }, []);

  const toggle = useCallback(
    () => setChoice(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setChoice],
  );

  const value = useMemo(
    () => ({ choice, resolved, setChoice, toggle }),
    [choice, resolved, setChoice, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  const goingTo = resolved === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      // The label names the destination, not the current state — "Dark mode" on
      // a button that is already dark reads as a status, and people click it
      // expecting nothing to happen.
      aria-label={`Switch to ${goingTo} mode`}
      title={`Switch to ${goingTo} mode`}
      // 36px on a phone so the bar has room for the wordmark and both actions,
      // 44 above it. An icon-only toggle is the one control here that can give
      // up width without becoming hard to hit — it has no label to crowd.
      className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-on-surface-variant transition hover:bg-tertiary/14 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:size-11"
    >
      {resolved === 'dark' ? (
        // Currently dark, so offer the sun.
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
          <path
            d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
