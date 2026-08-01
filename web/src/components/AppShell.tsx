/**
 * The frame every page sits in: brand, navigation, footer.
 *
 * Navigation stays in the same place on every screen, including deep inside
 * checkout — a buyer who loses their way mid-purchase and finds no way back to
 * the events list abandons the purchase rather than starting over.
 */
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { ThemeToggle } from '@/lib/theme';
import { ButtonAnchor } from '@/components/ui';

function Wordmark() {
  return (
    <Link
      to="/"
      className="group inline-flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      aria-label="Eventify Tickets — home"
    >
      {/* A ticket stub reduced to its one recognisable feature: the notch. Drawn
          rather than lettered, so it survives at favicon size. */}
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
        <defs>
          <linearGradient id="wordmark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--blue-60)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--blue-40)' }} />
          </linearGradient>
          <mask id="notch">
            <rect width="32" height="32" fill="white" />
            <circle cx="0" cy="16" r="5" fill="black" />
            <circle cx="32" cy="16" r="5" fill="black" />
          </mask>
        </defs>
        <rect
          width="32"
          height="32"
          rx="9"
          fill="url(#wordmark)"
          mask="url(#notch)"
          className="transition group-hover:brightness-110"
        />
        <circle cx="16" cy="11" r="1.6" style={{ fill: 'var(--blue-10)' }} opacity="0.85" />
        <circle cx="16" cy="16" r="1.6" style={{ fill: 'var(--blue-10)' }} opacity="0.85" />
        <circle cx="16" cy="21" r="1.6" style={{ fill: 'var(--blue-10)' }} opacity="0.85" />
      </svg>

      <span className="font-display text-lg leading-none font-extrabold tracking-tight text-on-surface">
        Eventify<span className="text-primary"> Tickets</span>
      </span>
    </Link>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'md-label-large rounded-full px-4 py-2 transition',
    // The current location is stated, not left to be inferred.
    isActive ? 'bg-surface-container-high text-on-surface' : 'text-on-surface-variant hover:text-on-surface-variant',
  ].join(' ');
}

// ─── Footer ────────────────────────────────────────────────────────────────

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="md-eyebrow text-on-surface-variant">{title}</h2>
      <ul className="mt-4 space-y-2.5">{children}</ul>
    </div>
  );
}

const FOOTER_LINK =
  'md-body-medium text-on-surface-variant transition-colors hover:text-on-surface';

function FooterLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <li>
      <Link to={to} className={FOOTER_LINK}>
        {children}
      </Link>
    </li>
  );
}

function FooterAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <a href={href} className={FOOTER_LINK}>
        {children}
      </a>
    </li>
  );
}

/**
 * A trust mark.
 *
 * Set in the data face and preceded by a tick: these are claims about how the
 * product behaves, and the ticket-stub register is where the product states
 * facts rather than opinions.
 */
function Mark({ label }: { label: string }) {
  return (
    <span className="md-data-small flex items-center gap-2 text-on-surface-variant">
      <svg viewBox="0 0 16 16" className="size-3.5 text-primary" fill="none" aria-hidden="true">
        <path
          d="m3 8.5 3 3 7-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status, user, accountsAvailable } = useAuth();

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Sticky so "Events" and the account are reachable from anywhere.
          Solid ink rather than a translucent blur: posters scrolling underneath
          a frosted bar turn it into a smear of whatever colour happens to be
          passing, and the masthead should be a fixed thing the page moves
          beneath — printed, not glazed. */}
      {/* Sticky, and flat until the page has actually moved beneath it. The lift
          is a scroll-driven animation rather than a scroll listener, so it runs
          off the main thread — a per-frame layout read is the last thing a
          mid-range Android needs while a poster grid is decoding. */}
      <header className="header-lift sticky top-0 z-40 border-b border-outline-variant/60 bg-surface-container-low">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:h-16 sm:px-6">
          <Wordmark />

          <nav className="flex items-center gap-1" aria-label="Main">
            <ThemeToggle />

            <NavLink to="/" end className={navClass}>
              Events
            </NavLink>

            {accountsAvailable &&
              (status === 'signed-in' ? (
                <NavLink to="/account" className={navClass}>
                  {/* The buyer's own name is the most recognisable label there
                      is; the email is the fallback, truncated rather than
                      allowed to push the nav around. */}
                  <span className="max-w-[10rem] truncate">
                    {user?.displayName?.split(' ')[0] ?? 'My tickets'}
                  </span>
                </NavLink>
              ) : (
                <NavLink to="/signin" className={navClass}>
                  Sign in
                </NavLink>
              ))}

            {/* The organiser door, and the only gold on a consumer surface: it
                does not accent anything, it means "this leads to the side of
                the product where you sell". Outlined rather than filled so it
                never competes with the buy action on an event page.

                Narrow screens get the short label rather than losing the
                control — an organiser arriving from a phone is the customer,
                and burying the one thing they came for in an overflow menu
                would be the wrong economy. */}
            <ButtonAnchor
              href="/#host"
              variant="outlined-gold"
              className="ml-1 h-10 px-3 sm:px-5"
            >
              <span className="sm:hidden">Host</span>
              <span className="hidden sm:inline">Host an event</span>
            </ButtonAnchor>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>

      {/* The footer does real work rather than holding a copyright line: it is
          the second place an organiser looks for the listing pitch, and the
          first place a buyer looks when something has gone wrong. Payment and
          gate marks sit here as reassurance, not decoration.

          Deliberately not a wall of links — §12 rules out footer link-soup, and
          four short columns of things that exist beats forty that do not. */}
      <footer className="mt-16 border-t border-outline-variant/60 bg-surface-container-low">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Wordmark />
              <p className="md-body-medium mt-4 max-w-xs text-on-surface-variant">
                Ticketing for Kenyan events. M-Pesa in, tickets out, money in
                your account within days rather than weeks.
              </p>
            </div>

            <FooterColumn title="For organisers">
              <FooterAnchor href="/#host">List an event</FooterAnchor>
              <FooterAnchor href="/#pricing">Fees and payouts</FooterAnchor>
              <FooterLink to="/account">Your dashboard</FooterLink>
            </FooterColumn>

            <FooterColumn title="For buyers">
              <FooterLink to="/">Browse events</FooterLink>
              <FooterLink to="/account">Find my tickets</FooterLink>
              <FooterAnchor href="mailto:support@eventify.co.ke">
                Get help
              </FooterAnchor>
            </FooterColumn>

            <FooterColumn title="At the door">
              <li className="md-body-medium text-on-surface-variant">
                Tickets arrive by email and scan at the gate.
              </li>
              <li className="md-body-medium text-on-surface-variant">
                They work with no signal once opened.
              </li>
            </FooterColumn>
          </div>

          {/* The trust row. A buyer about to type an M-Pesa PIN and an organiser
              about to hand over their payout details are both looking for the
              same thing here. */}
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-outline-variant/60 pt-6">
            <Mark label="Pay with M-Pesa" />
            <Mark label="Encrypted checkout" />
            <Mark label="Scanned at the gate" />

            <p className="md-body-small ml-auto text-on-surface-variant">
              © {new Date().getFullYear()} Eventify Tickets
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
