/**
 * Contains a crash to the part of the page that crashed.
 *
 * React unmounts the whole tree when a render throws, so without a boundary a
 * bug in one panel takes the page with it. On a ticketing page that is the
 * difference between "the price panel is having a moment" and a buyer staring
 * at a blank screen with an event they can no longer buy — the second is a lost
 * sale caused by a component that was not on the purchase path.
 *
 * Deliberately small and local. `RouteError` already handles a whole route
 * failing; this is for wrapping one panel whose failure the rest of the page
 * can survive, and it offers a retry because most of what throws here is a
 * render over data that arrived in an unexpected shape — which the next fetch
 * usually fixes.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  /** Names the panel in the fallback, e.g. "the price summary". */
  label: string;
  /** Re-runs whatever produced the data, where the caller can offer that. */
  onRetry?: () => void;
}

interface State {
  failed: boolean;
}

export class LocalErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged rather than swallowed: the buyer gets a working page, and the
    // console still carries what actually broke for whoever looks later.
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        role="alert"
        className="rounded-sm border border-outline-variant bg-surface p-4"
      >
        <p className="md-body-medium text-on-surface">
          We could not show {this.props.label} just then.
        </p>
        <p className="md-body-small mt-1 text-on-surface-variant">
          Everything else on this page still works, and nothing has been charged.
        </p>
        <Button variant="text" onClick={this.retry} className="mt-2 -ml-3">
          Try again
        </Button>
      </div>
    );
  }
}
