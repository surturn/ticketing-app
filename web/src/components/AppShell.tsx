/**
 * The frame every page sits in: brand, navigation, footer.
 *
 * Navigation stays in the same place on every screen, including deep inside
 * checkout — a buyer who loses their way mid-purchase and finds no way back to
 * the events list abandons the purchase rather than starting over.
 */
import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '@/auth/AuthProvider';
import { WelcomeModal } from '@/auth/WelcomeModal';
import { ThemeToggle, useTheme } from '@/lib/theme';
import { ButtonLink } from '@/components/ui';
import { ConsentBanner } from '@/components/ConsentBanner';

function Wordmark() {
  return (
    <Link
      to="/"
      className="group inline-flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary sm:gap-2.5"
      aria-label="Eventify Tickets — home"
    >
      {/* A ticket stub reduced to its one recognisable feature: the notch. Drawn
          rather than lettered, so it survives at favicon size. */}
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true">
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

      {/* Full label at every width. It used to drop "Tickets" below `sm` because
          four inline controls plus a wordmark had nowhere else to give up the
          room — now that those controls collapse into a menu on a phone, the
          wordmark can stay whole instead of standing in for the brand. */}
      <span className="font-display text-base leading-none font-extrabold tracking-tight whitespace-nowrap text-on-surface sm:text-lg">
        Eventify<span className="text-primary"> Tickets</span>
      </span>
    </Link>
  );
}

/** The hamburger / close glyph, morphing between the two rather than swapping icons. */
function MenuGlyph({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
      <path
        d={open ? 'M6 6l12 12' : 'M4 7h16'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M4 12h16"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        className="transition-opacity"
        opacity={open ? 0 : 1}
      />
      <path
        d={open ? 'M6 18L18 6' : 'M4 17h16'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Everything below `sm` that used to sit inline: Events, the account link,
 * and the theme switch. Named in the menu rather than left as an icon —
 * there is room for a word here that there never was in the bar itself.
 *
 * Host keeps its own button outside this menu (see `AppShell`) rather than
 * joining it, for the same reason the bar always gave it a place of its own:
 * an organiser on a phone is the customer, and burying the one thing they
 * came for behind a tap into a menu would be the wrong economy.
 */
function MobileMenu({ onNavigate }: { onNavigate: () => void }) {
  const { accountsAvailable, status } = useAuth();
  const { resolved, toggle } = useTheme();
  const goingTo = resolved === 'dark' ? 'light' : 'dark';

  const itemClass =
    'md-label-large trimmed flex items-center rounded-md px-4 py-3 transition-colors text-on-surface-variant hover:bg-tertiary/14 hover:text-on-surface';

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
      className="absolute inset-x-4 top-full z-40 mt-2 overflow-hidden rounded-md border border-outline-variant bg-surface-container-high shadow-xl sm:hidden"
      role="menu"
    >
      <NavLink
        to="/"
        end
        onClick={onNavigate}
        className={({ isActive }) =>
          `${itemClass} ${isActive ? 'bg-primary-container text-on-primary-container' : ''}`
        }
        role="menuitem"
      >
        Events
      </NavLink>

      {accountsAvailable &&
        (status === 'signed-in' ? (
          <NavLink to="/account" onClick={onNavigate} className={itemClass} role="menuitem">
            My tickets
          </NavLink>
        ) : (
          <Link to="/signin" onClick={onNavigate} className={itemClass} role="menuitem">
            Sign in
          </Link>
        ))}

      <button
        type="button"
        onClick={() => {
          toggle();
          onNavigate();
        }}
        className={`${itemClass} w-full justify-between text-left`}
        role="menuitem"
      >
        <span>{resolved === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        <span className="md-body-small text-on-surface-variant">Switch to {goingTo}</span>
      </button>
    </motion.div>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'md-label-large trimmed px-4 py-2 transition-colors',
    // The current location is stated, not left to be inferred — and stated in
    // blue, the colour this half of the product navigates in. A neutral grey
    // fill said "something is selected" without saying it was a place.
    // Hovering an inactive item washes it warm; the active one keeps its blue
    // and does not respond, because it is already where you are.
    isActive
      ? 'bg-primary-container text-on-primary-container'
      : 'text-on-surface-variant hover:bg-tertiary/14 hover:text-on-surface',
  ].join(' ');
}

// ─── Footer ────────────────────────────────────────────────────────────────

function FooterColumn({
  title,
  className,
  children,
}: {
  title: string;
  /** For the blocks that need to span both columns on a phone. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {/* Muted gold rather than grey. It warms the footer without any of these
          headings reading as something to press — full-strength tertiary is the
          organiser signal, and a column label is not asking for anything. */}
      <h2 className="md-eyebrow text-tertiary-muted">{title}</h2>
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

/** For destinations outside the router — a mailto, or another site. */
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

/**
 * Shows the welcome once, on the sign-in that created the account.
 *
 * Lives in the shell rather than on a page so it appears wherever the buyer
 * happened to sign in from — the account screen, or mid-checkout on an event
 * page. `created` is only ever true on the session call that made the row, so
 * no additional flag is needed to stop it recurring.
 */
function FirstSignInWelcome() {
  const { session, user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (!session?.created || dismissed) return null;

  return (
    <WelcomeModal
      name={session.user.displayName ?? user?.displayName ?? null}
      linkedOrders={session.linkedOrders}
      onClose={() => setDismissed(true)}
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  // `user` is no longer read here: the account link names its destination
  // rather than the person signed into it.
  const { status, accountsAvailable } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

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
        {/* `relative`, so the mobile menu below can anchor to this bar rather
            than to the page — `top-full` needs a positioned ancestor to mean
            anything. */}
        <div className="relative mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:h-16 sm:gap-4 sm:px-6">
          <Wordmark />

          {/* `shrink-0` so the nav keeps its size and the wordmark truncates
              instead — the controls are what people came to press. */}
          <nav className="flex shrink-0 items-center gap-1" aria-label="Main">
            {/* Theme and Events move into the mobile menu below `sm` — see
                `MobileMenu`. Kept inline above it, where the width for them
                already exists. */}
            <span className="hidden sm:contents">
              <ThemeToggle />

              <NavLink
                to="/"
                end
                className={({ isActive }) => `${navClass({ isActive })} hidden sm:inline-flex`}
              >
                Events
              </NavLink>
            </span>

            {accountsAvailable && (
              <span className="hidden sm:contents">
                {status === 'signed-in' ? (
                  <NavLink to="/account" className={navClass}>
                    {/* Names the destination, not the person.

                        The first name was the more personal label and the less
                        useful one: it told a buyer who they were, which they
                        knew, while leaving what sits behind the link to be
                        guessed. Someone who has just paid is looking for their
                        tickets, and "Events / My tickets / Host an event" reads
                        as three places to go rather than two places and a
                        greeting. It also stops the bar changing width with the
                        length of whoever is signed in. */}
                    My tickets
                  </NavLink>
                ) : (
                  // A button, not a text link. Signing in is one of the two things
                  // anyone comes to this bar to do, and rendering it as prose
                  // beside a pill made it read as a caption for the pill.
                  // Tonal rather than filled: it must not out-shout the buy action
                  // on an event page, and §7.5 allows only one filled per view.
                  <ButtonLink
                    to="/signin"
                    variant="tonal"
                    className="h-10 px-4 text-base whitespace-nowrap"
                  >
                    Sign in
                  </ButtonLink>
                )}
              </span>
            )}

            {/* The organiser door, and the only gold on a consumer surface: it
                does not accent anything, it means "this leads to the side of
                the product where you sell". Outlined rather than filled so it
                never competes with the buy action on an event page.

                Narrow screens get the short label rather than losing the
                control — an organiser arriving from a phone is the customer,
                and burying the one thing they came for in an overflow menu
                would be the wrong economy. Unlike Events, Sign in and the
                theme switch, Host stays outside the mobile menu for exactly
                that reason. */}
            <ButtonLink
              to="/host"
              variant="outlined-gold"
              className="h-9 px-3 text-sm whitespace-nowrap sm:ml-1 sm:h-10 sm:px-5 sm:text-base"
            >
              <span className="sm:hidden">Host</span>
              <span className="hidden sm:inline">Host an event</span>
            </ButtonLink>

            {/* The menu button itself, and everything it opens. Below `sm`
                only — above it, every control it would otherwise hold is
                already inline. */}
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-on-surface-variant transition hover:bg-tertiary/14 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:hidden"
            >
              <MenuGlyph open={menuOpen} />
            </button>
          </nav>

          <AnimatePresence>
            {menuOpen && <MobileMenu onNavigate={() => setMenuOpen(false)} />}
          </AnimatePresence>

          {/* A tap anywhere outside the menu closes it. Transparent and
              beneath the menu itself, above the page — the same job a
              backdrop does for a dialog, without dimming the page behind a
              control this casual. */}
          {menuOpen && (
            <button
              type="button"
              aria-label="Close menu"
              tabIndex={-1}
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-30 cursor-default sm:hidden"
            />
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>

      <ConsentBanner />
      <FirstSignInWelcome />

      {/* The footer does real work rather than holding a copyright line: it is
          the second place an organiser looks for the listing pitch, and the
          first place a buyer looks when something has gone wrong. Payment and
          gate marks sit here as reassurance, not decoration.

          Deliberately not a wall of links — §12 rules out footer link-soup, and
          four short columns of things that exist beats forty that do not. */}
      <footer className="mt-16 border-t border-outline-variant/60 bg-surface-container-low">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          {/* Two columns on a phone rather than four stacked blocks.
              Single-column made the footer about as tall as some of the pages
              above it, which on a phone is a long scroll past nothing to reach
              the legal links people actually come down here for.

              Not everything halves, though. The two link lists pair naturally —
              short labels, similar length — while the brand paragraph and the
              door notes are prose, and prose in a ~150px column on a small
              handset wraps to one or two words a line and reads worse than it
              did stacked. So those two span the full width and only the links
              sit side by side. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-9 sm:gap-10 lg:grid-cols-4">
            <div className="col-span-2 lg:col-span-1">
              <Wordmark />
              <p className="md-body-medium mt-4 max-w-xs text-on-surface-variant">
                Ticketing for Kenyan events. M-Pesa in, tickets out, money in
                your account within days rather than weeks.
              </p>
            </div>

            {/* No dashboard link. /admin is reachable by typing it, and the
                API authorises every request there regardless — but advertising
                it in the footer of a consumer site invites people to try a door
                that is not for them, and answers nothing they were asking. */}
            <FooterColumn title="For organisers">
              <FooterLink to="/host">List an event</FooterLink>
              <FooterLink to="/host">Fees and payouts</FooterLink>
              <FooterAnchor href="mailto:hello@invonicstechnologies.com">
                Talk to us
              </FooterAnchor>
            </FooterColumn>

            <FooterColumn title="For buyers">
              <FooterLink to="/">Browse events</FooterLink>
              <FooterLink to="/account">Find my tickets</FooterLink>
              <FooterLink to="/help">Get help</FooterLink>
              <FooterAnchor href="mailto:hello@invonicstechnologies.com">
                Email us
              </FooterAnchor>
            </FooterColumn>

            <FooterColumn title="At the door" className="col-span-2 lg:col-span-1">
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

            {/* Required reading, so it sits in the trust row rather than in a
                column someone has to go looking for. */}
            <Link
              to="/privacy"
              className="md-body-small text-on-surface-variant transition-colors hover:text-on-surface"
            >
              Privacy
            </Link>
            <Link
              to="/terms"
              className="md-body-small text-on-surface-variant transition-colors hover:text-on-surface"
            >
              Terms
            </Link>

            <p className="md-body-small ml-auto text-on-surface-variant">
              © {new Date().getFullYear()} Eventify Tickets — built by Invonics
              Technologies
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
