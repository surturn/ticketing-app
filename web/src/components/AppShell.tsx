/**
 * The frame every page sits in: brand, navigation, footer.
 *
 * Navigation stays in the same place on every screen, including deep inside
 * checkout — a buyer who loses their way mid-purchase and finds no way back to
 * the events list abandons the purchase rather than starting over.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { WelcomeModal } from '@/auth/WelcomeModal';
import { useTheme } from '@/lib/theme';
import { ButtonLink } from '@/components/ui';
import { ConsentBanner } from '@/components/ConsentBanner';

function Wordmark() {
  return (
    <Link
      to="/"
      /* `shrink-0`, and no `overflow-hidden`. Letting it shrink is what produced
         "Eventify Tic" on a phone — a logotype sliced through a word looks more
         broken than anything it was making room for. It now keeps its width and
         the second word is dropped wholesale below `sm` instead. */
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

      {/* Never wraps and never truncates. Below `sm` the second word is hidden
          outright rather than sliced — "Eventify" alone is a wordmark, whereas
          "Eventify Tic" is a rendering bug. */}
      <span className="font-display text-base leading-none font-extrabold tracking-tight whitespace-nowrap text-on-surface sm:text-lg">
        Eventify
        <span className="hidden text-primary sm:inline"> Tickets</span>
      </span>
    </Link>
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

/** Shared frame for the two circular nav controls — the account door and the
    menu. An outline rather than a fill: neither is an action on its own, so
    neither should read with the weight of one. */
const NAV_ICON_BUTTON =
  'md-state relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-outline-variant text-on-surface-variant transition-colors hover:text-on-surface sm:size-10';

function PersonIcon() {
  return (
    <svg viewBox="0 0 20 20" className="relative size-4.5 sm:size-5" fill="none" aria-hidden="true">
      <circle cx="10" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3.5 17c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SocialFacebookIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <path
        d="M13 4h-2a3 3 0 0 0-3 3v2H6v3h2v6h3v-6h2.2l.5-3H11V7c0-.6.4-1 1-1h1V4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SocialInstagramIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="14" cy="6" r="0.9" fill="currentColor" />
    </svg>
  );
}

function SocialTwitterIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <path
        d="M17 5.3c-.6.3-1.2.5-1.9.6a3.2 3.2 0 0 0 1.4-1.8c-.6.4-1.4.7-2.1.8a3.3 3.3 0 0 0-5.6 3 9.4 9.4 0 0 1-6.8-3.5 3.3 3.3 0 0 0 1 4.4c-.5 0-1-.2-1.5-.4v.1c0 1.6 1.1 2.9 2.6 3.2a3.3 3.3 0 0 1-1.5.1 3.3 3.3 0 0 0 3.1 2.3A6.6 6.6 0 0 1 3 15.4a9.3 9.3 0 0 0 5.1 1.5c6.1 0 9.4-5.1 9.4-9.4v-.4c.6-.5 1.2-1.1 1.5-1.8Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SocialLinkedInIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.6" cy="6.8" r="1" fill="currentColor" />
      <path d="M6.6 9.5v4.2M9.6 13.7V9.9c0-1.6 2.6-1.6 2.6 0v3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" className="relative size-4.5 sm:size-5" fill="none" aria-hidden="true">
      <path
        d="M3 6h14M3 10h14M3 14h14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The hamburger.
 *
 * Everything inside it already existed somewhere — Help, Terms and Privacy in
 * the footer, the theme switch as its own icon — but reaching any of them from
 * the middle of a page meant either scrolling to the bottom or leaving for the
 * legal pages directly. This puts the same handful of things one tap away from
 * anywhere the bar is visible, which is the actual job a control like this
 * does; it does not gain a page of its own.
 *
 * A plain disclosure rather than `role="menu"`: that role commits to arrow-key
 * navigation between items, which this does not implement, and claiming it
 * without the behaviour is worse for a screen-reader user than not claiming it
 * at all. `aria-expanded` plus a real, tabbable button and link list is enough.
 */
function MoreMenu() {
  const [open, setOpen] = useState(false);
  const { resolved, toggle } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function handlePointer(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="More"
        title="More"
        className={NAV_ICON_BUTTON}
      >
        <span className="md-state-layer" aria-hidden="true" />
        <MenuIcon />
      </button>

      {open && (
        <div
          id={panelId}
          className="md-elevation-2 absolute right-0 z-50 mt-2 w-52 rounded-md p-2"
        >
          <button
            type="button"
            onClick={() => {
              toggle();
              setOpen(false);
            }}
            className="md-state md-body-medium flex w-full cursor-pointer items-center rounded-sm px-3 py-2.5 text-left text-on-surface transition-colors"
          >
            <span className="md-state-layer" aria-hidden="true" />
            <span className="relative">
              {resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            </span>
          </button>

          <div className="my-1 border-t border-outline-variant" />

          {[
            { to: '/help', label: 'Help' },
            { to: '/terms', label: 'Terms' },
            { to: '/privacy', label: 'Privacy' },
          ].map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="md-state md-body-medium flex cursor-pointer items-center rounded-sm px-3 py-2.5 text-on-surface transition-colors"
            >
              <span className="md-state-layer" aria-hidden="true" />
              <span className="relative">{item.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
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

function BackArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M12 4 5 10l7 6M5 10h11"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  // `user` is no longer read here: the account link names its destination
  // rather than the person signed into it.
  const { status, accountsAvailable } = useAuth();

  /**
   * A quieter masthead for the page a buyer is actually spending money on.
   *
   * Everywhere else the header sells the platform — discovery links, the
   * organiser door, an account icon. On the one screen where someone is
   * choosing tickets and typing a phone number, those are distractions from
   * the one thing that matters: getting back to the listing if this isn't the
   * right event, or continuing if it is. So the marketing links and the
   * account door step aside for a single "Back to events" and a quieter,
   * outlined route to hosting.
   */
  const location = useLocation();
  const isCheckoutFlow = /^\/events\/[^/]+\/?$/.test(location.pathname);

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
        {isCheckoutFlow ? (
          <div className="mx-auto grid h-14 max-w-[1440px] grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 sm:h-16 sm:px-6">
            <Link
              to="/"
              className="md-label-large flex items-center gap-1.5 text-on-surface-variant transition-colors hover:text-on-surface"
            >
              <BackArrowIcon />
              <span className="hidden sm:inline">Back to events</span>
            </Link>

            <div className="flex justify-center">
              <Wordmark />
            </div>

            <div className="flex items-center justify-end gap-2">
              <Link
                to="/host"
                className="md-state md-label-large trimmed hidden h-9 items-center border border-primary px-4 text-primary transition-colors sm:inline-flex sm:h-10 sm:px-5"
              >
                <span className="md-state-layer" aria-hidden="true" />
                <span className="relative">Host Event</span>
              </Link>
              <MoreMenu />
            </div>
          </div>
        ) : (
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-2 px-4 sm:h-16 sm:gap-4 sm:px-6">
          <Wordmark />

          {/* `shrink-0` so the nav keeps its size and the wordmark truncates
              instead — the controls are what people came to press. */}
          <nav className="flex shrink-0 items-center gap-1.5 sm:gap-2" aria-label="Main">
            {/* The four marketing links. There is no room for four extra words
                beside the wordmark and three controls until the bar has real
                width to spare, so they wait for `xl` rather than fighting for
                space on a laptop-width screen — the controls a transaction
                depends on (host, account, menu) never move to make room. */}
            <div className="mr-1 hidden items-center gap-1 xl:flex">
              <NavLink to="/" end className={navClass}>
                Discover
              </NavLink>
              {/* `end`, same reason `Discover` has it: without it, a NavLink
                  whose path is "/" matches every route by prefix and lights up
                  everywhere, not just on the page it actually points to. */}
              <NavLink to="/#whats-on" end className={navClass}>
                Categories
              </NavLink>
              <NavLink to="/help" className={navClass}>
                How it works
              </NavLink>
              <NavLink to="/host" className={navClass}>
                For Organisers
              </NavLink>
            </div>

            {/* Filled, not outlined. The masthead's one filled action is now
                the organiser door rather than a quiet outlined pill — it does
                sit beside a page's own filled buy button on an event page,
                which is a real trade against §7.5's "one filled action per
                view", and is accepted here rather than pretended away: the
                header now reads as its own region rather than one competing
                with the content beneath it.

                Narrow screens get the short label rather than losing the
                control outright — an organiser arriving from a phone is the
                customer, and burying the one thing they came for in an
                overflow menu would be the wrong economy. */}
            <ButtonLink
              to="/host"
              variant="filled"
              className="h-9 px-3 text-sm whitespace-nowrap sm:h-10 sm:px-5 sm:text-base"
            >
              <span className="sm:hidden">Host</span>
              <span className="hidden sm:inline">Host Event</span>
            </ButtonLink>

            {/* The account door, as an icon rather than the word "Sign in" or
                "My tickets". That costs the door its label, which is a real
                loss — the label used to do real work distinguishing "you have
                an account" from "you don't" at a glance — so the destination
                and the reason for it both still live in `aria-label`/`title`
                for anyone who can't read it from the glyph alone. */}
            {accountsAvailable && (
              <Link
                to={status === 'signed-in' ? '/account' : '/signin'}
                aria-label={status === 'signed-in' ? 'My tickets' : 'Sign in'}
                title={status === 'signed-in' ? 'My tickets' : 'Sign in'}
                className={NAV_ICON_BUTTON}
              >
                <span className="md-state-layer" aria-hidden="true" />
                <PersonIcon />
              </Link>
            )}

            <MoreMenu />
          </nav>
        </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-8 sm:px-6 sm:py-12">
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
        <div className="mx-auto max-w-[1440px] px-4 py-12 sm:px-6">
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

              {/* Placeholders — real handles go here once they exist. Left as
                  `#` rather than omitted so the row's spacing is already
                  correct when they are filled in. */}
              <div className="mt-5 flex items-center gap-4 text-on-surface-variant">
                <a href="#" aria-label="Facebook" className="transition-colors hover:text-on-surface">
                  <SocialFacebookIcon />
                </a>
                <a href="#" aria-label="Instagram" className="transition-colors hover:text-on-surface">
                  <SocialInstagramIcon />
                </a>
                <a href="#" aria-label="Twitter" className="transition-colors hover:text-on-surface">
                  <SocialTwitterIcon />
                </a>
                <a href="#" aria-label="LinkedIn" className="transition-colors hover:text-on-surface">
                  <SocialLinkedInIcon />
                </a>
              </div>
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

            {/* "About us" and "Careers" have no page yet — placeholders to
                `/help` until they do, rather than dead `#` links in a column
                whose whole job is to be trustworthy. */}
            <FooterColumn title="Company">
              <FooterLink to="/help">About us</FooterLink>
              <FooterLink to="/help">Careers</FooterLink>
              <FooterLink to="/terms">Terms</FooterLink>
              <FooterLink to="/privacy">Privacy</FooterLink>
            </FooterColumn>
          </div>

          {/* The trust row. A buyer about to type an M-Pesa PIN and an organiser
              about to hand over their payout details are both looking for the
              same thing here. */}
          <div className="mt-10 flex flex-wrap items-start justify-between gap-x-6 gap-y-6 border-t border-outline-variant/60 pt-6">
            <div className="max-w-sm">
              <h2 className="md-eyebrow text-tertiary-muted">At the door</h2>
              <p className="md-body-medium mt-2 text-on-surface-variant">
                Tickets arrive by email and scan at the gate. They work with no
                signal once opened.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Mark label="Pay with M-Pesa" />
              <Mark label="Encrypted checkout" />
              <Mark label="Scanned at the gate" />
            </div>
          </div>

          <p className="md-body-small mt-6 border-t border-outline-variant/60 pt-6 text-center text-on-surface-variant">
            © {new Date().getFullYear()} Eventify Tickets — built by Invonics
            Technologies
          </p>
        </div>
      </footer>
    </div>
  );
}
