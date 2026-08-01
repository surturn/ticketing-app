/**
 * Routes.
 *
 * Every screen a buyer might want to return to has its own URL — an event, an
 * order, their tickets. That is not tidiness: the order page is the link people
 * bookmark, forward to whoever is coming with them, and open again at the gate,
 * so it has to survive being shared and reloaded.
 *
 * Built on a data router rather than `<BrowserRouter>`. The View Transitions
 * work in §10.1 needs one: only the data router owns enough of the navigation
 * to hand it to `document.startViewTransition`, and `useViewTransitionState` —
 * which is how a single card claims the shared poster name on its way out —
 * throws outside one.
 */
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/AuthProvider';
import { ThemeProvider } from './lib/theme';
import { lazyRoute } from './lib/lazyRoute';
import { EventsPage } from './pages/EventsPage';
import { RouteError } from './pages/RouteError';

/**
 * The providers and the frame, as the route every screen renders inside.
 *
 * Kept as one layout route so theme and auth are established once and survive
 * navigation — remounting the auth provider per route would re-run the Firebase
 * handshake on every click.
 */
function Root() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </AuthProvider>
    </ThemeProvider>
  );
}

/**
 * Routes past the landing page are split out of the initial bundle.
 *
 * The homepage stays eager because it is the entry point and lazy-loading it
 * would only add a waterfall in front of the first paint. Everything else is
 * fetched when its route is first visited, which keeps the things only some
 * visitors ever touch — the confetti and QR renderer on the order page, the
 * admin dashboard — off the critical path for someone who arrived on 4G to
 * look at one event.
 *
 * Each is wrapped in `lazyRoute`, which recovers from the one failure that
 * splitting guarantees: a deploy retires the hashed chunk names an already-open
 * tab is still asking for. See that module for why the fix is a reload rather
 * than a message.
 */
const router = createBrowserRouter([
  {
    element: <Root />,
    // Catches a chunk that will not load and anything a screen throws, in place
    // of React Router's developer error page.
    errorElement: (
      <ThemeProvider>
        <AuthProvider>
          <AppShell>
            <RouteError />
          </AppShell>
        </AuthProvider>
      </ThemeProvider>
    ),
    children: [
      { path: '/', element: <EventsPage /> },
      {
        path: '/events/:slug',
        lazy: lazyRoute('event', () => import('./pages/EventPage'), (m) => m.EventPage),
      },
      {
        path: '/orders/:reference',
        lazy: lazyRoute('order', () => import('./pages/OrderPage'), (m) => m.OrderPage),
      },
      {
        path: '/account',
        lazy: lazyRoute('account', () => import('./pages/AccountPage'), (m) => m.AccountPage),
      },
      {
        path: '/account/settings',
        lazy: lazyRoute(
          'settings',
          () => import('./pages/SettingsPage'),
          (m) => m.SettingsPage,
        ),
      },
      {
        path: '/host',
        lazy: lazyRoute('host', () => import('./pages/HostPage'), (m) => m.HostPage),
      },
      {
        path: '/help',
        lazy: lazyRoute('help', () => import('./pages/HelpPage'), (m) => m.HelpPage),
      },
      {
        path: '/privacy',
        lazy: lazyRoute('privacy', () => import('./pages/PrivacyPage'), (m) => m.PrivacyPage),
      },
      {
        path: '/terms',
        lazy: lazyRoute('terms', () => import('./pages/TermsPage'), (m) => m.TermsPage),
      },
      {
        path: '/signin',
        lazy: lazyRoute('signin', () => import('./pages/SignInPage'), (m) => m.SignInPage),
      },
      {
        path: '/admin',
        lazy: lazyRoute('admin', () => import('./pages/AdminPage'), (m) => m.AdminPage),
      },
      {
        path: '/admin/events/:id',
        lazy: lazyRoute(
          'admin-event',
          () => import('./pages/AdminEventPage'),
          (m) => m.AdminEventPage,
        ),
      },
      {
        path: '*',
        lazy: lazyRoute(
          'not-found',
          () => import('./pages/NotFoundPage'),
          (m) => m.NotFoundPage,
        ),
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
