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
 * throws outside one. Nothing else about the routing changes.
 */
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/AuthProvider';
import { ThemeProvider } from './lib/theme';
import { EventsPage } from './pages/EventsPage';

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
 * account screens — off the critical path for someone who arrived to look at
 * one event on metered 4G.
 *
 * The router resolves these before rendering the route, so there is no
 * intermediate Suspense flash to design around.
 */
const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/', element: <EventsPage /> },
      {
        path: '/events/:slug',
        lazy: async () => ({ Component: (await import('./pages/EventPage')).EventPage }),
      },
      {
        path: '/orders/:reference',
        lazy: async () => ({ Component: (await import('./pages/OrderPage')).OrderPage }),
      },
      {
        path: '/account',
        lazy: async () => ({ Component: (await import('./pages/AccountPage')).AccountPage }),
      },
      {
        path: '/signin',
        lazy: async () => ({ Component: (await import('./pages/SignInPage')).SignInPage }),
      },
      {
        path: '*',
        lazy: async () => ({
          Component: (await import('./pages/NotFoundPage')).NotFoundPage,
        }),
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
