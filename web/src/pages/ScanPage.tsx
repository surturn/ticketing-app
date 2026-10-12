/**
 * The gate, on a phone.
 *
 * Deliberately outside the storefront's shell — no navbar, no footer, nothing
 * between door staff and the camera. This is handed to someone standing in a
 * queue, not browsing; every control here exists because a scan just
 * happened or is about to.
 *
 * The token arrives once, in the URL an organiser shared, and is then kept in
 * this browser so reopening the link (or losing signal mid-queue and coming
 * back) does not mean asking for it again. It is never sent anywhere but
 * `/api/checkin` — see `scanApi.ts`.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QrScanner from 'qr-scanner';
import { ApiError } from '@/lib/api';
import { checkIn, readScannerTokenClaims, type CheckInResult } from '@/lib/scanApi';
import { ThemeProvider } from '@/lib/theme';
import { ToastProvider, useToast } from '@/components/Toasts';
import { Button } from '@/components/ui';

const STORAGE_KEY = 'eventify-scanner-token';

type Outcome =
  | { tone: 'admitted'; headline: string; detail: string }
  | { tone: 'blocked'; headline: string; detail: string };

/** Turns a check-in response, or the error it threw, into one line each of
 *  headline and detail — the two things a glance at the gate needs. */
function describeOutcome(result: CheckInResult): Outcome {
  const who = result.ticket.holderName ?? 'This ticket';

  if (result.admitted) {
    return { tone: 'admitted', headline: 'Admit', detail: `${who} — ${result.ticket.tierName}` };
  }

  switch (result.reason) {
    case 'already_checked_in':
      return {
        tone: 'blocked',
        headline: 'Already checked in',
        detail: result.ticket.checkedInAt
          ? `${who} — scanned at ${new Date(result.ticket.checkedInAt).toLocaleTimeString()}`
          : who,
      };
    case 'void':
      return { tone: 'blocked', headline: 'Voided ticket', detail: who };
    case 'order_not_paid':
      return { tone: 'blocked', headline: 'Order not paid', detail: who };
    default:
      return { tone: 'blocked', headline: 'Not admitted', detail: who };
  }
}

function OutcomeBanner({ outcome }: { outcome: Outcome }) {
  const admitted = outcome.tone === 'admitted';
  return (
    <div
      role="status"
      aria-live="assertive"
      className={`rounded-md p-6 text-center ${
        admitted ? 'bg-success-container text-on-success-container' : 'bg-error-container text-on-error-container'
      }`}
    >
      <p className="font-display text-3xl font-extrabold tracking-tight">{outcome.headline}</p>
      <p className="md-body-large mt-2">{outcome.detail}</p>
    </div>
  );
}

function ManualEntry({
  onSubmit,
  busy,
}: {
  onSubmit: (code: string) => void;
  busy: boolean;
}) {
  const [code, setCode] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) onSubmit(code.trim());
      }}
      className="flex flex-col gap-3"
    >
      <label className="block">
        <span className="md-label-large text-on-surface-variant">Ticket code</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoCapitalize="characters"
          placeholder="XXXX-XXXX-XXXX"
          className="md-data-large mt-1.5 h-14 w-full rounded-sm border border-outline bg-transparent px-4 text-center tracking-widest text-on-surface uppercase focus:border-2 focus:border-primary focus:outline-none"
        />
      </label>
      {/* A typed code is accepted on the gate's own authority, not a scanner's
          signature — `checkIn` sends `entry: 'manual'` for exactly that
          reason, and it is recorded server-side as such. */}
      <Button type="submit" variant="gold" disabled={!code.trim()} busy={busy} busyLabel="Checking…">
        Check in
      </Button>
    </form>
  );
}

function Scanner() {
  const { notify } = useToast();
  const [params] = useSearchParams();

  const [token, setToken] = useState<string | null>(null);
  const [resolvedToken, setResolvedToken] = useState(false);
  const [claims, setClaims] = useState<ReturnType<typeof readScannerTokenClaims>>(null);
  const [tokenDead, setTokenDead] = useState<string | null>(null);

  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const processingRef = useRef(false);
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);

  // The token: a fresh one in the URL always wins and is saved for next
  // time; otherwise whatever this device already had. Stripped from the
  // address bar once read, the same reasoning `adminApi.ts` gives for
  // keeping a credential out of browser chrome that lingers.
  useEffect(() => {
    const fromUrl = params.get('token');
    let value = fromUrl;

    if (fromUrl) {
      try {
        localStorage.setItem(STORAGE_KEY, fromUrl);
      } catch {
        /* Storage blocked — the token still works for this page view. */
      }
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.toString());
    } else {
      try {
        value = localStorage.getItem(STORAGE_KEY);
      } catch {
        value = null;
      }
    }

    setToken(value);
    setClaims(value ? readScannerTokenClaims(value) : null);
    setResolvedToken(true);
    // Only ever re-run this for a genuinely new ?token= in the URL — reading
    // storage on every render would fight the strip-from-the-URL step above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('token')]);

  async function submitCode(code: string, entry: 'scan' | 'manual') {
    if (!token) return;
    setBusy(true);
    try {
      const result = await checkIn(token, { code, entry });
      setOutcome(describeOutcome(result));
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
        setTokenDead(caught.message || 'This scanner link no longer works.');
        return;
      }
      if (caught instanceof ApiError) {
        setOutcome({ tone: 'blocked', headline: 'Could not check in', detail: caught.message });
      } else {
        notify('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  function handleManualSubmit(code: string) {
    void submitCode(code, 'manual');
  }

  // The camera. Started once a usable token exists and manual entry is not
  // in the way of the video element it needs; torn down on the way out so a
  // backgrounded tab does not keep a phone's camera light on.
  useEffect(() => {
    if (!token || !resolvedToken || tokenDead || manual) return;
    const video = videoRef.current;
    if (!video) return;

    const scanner = new QrScanner(
      video,
      (result) => {
        if (processingRef.current) return;
        const now = Date.now();
        // The same code re-read a dozen times a second while a ticket sits
        // in frame is the normal case, not a retry — ignored for a few
        // seconds rather than re-submitted every frame.
        if (lastCodeRef.current?.code === result.data && now - lastCodeRef.current.at < 3000) {
          return;
        }
        processingRef.current = true;
        lastCodeRef.current = { code: result.data, at: now };
        void submitCode(result.data, 'scan').finally(() => {
          processingRef.current = false;
        });
      },
      {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: 'environment',
      },
    );

    scannerRef.current = scanner;
    setCameraError(null);

    scanner
      .start()
      .catch(() => {
        setCameraError(
          'Could not open the camera — check that this page has permission, or use manual entry below.',
        );
      });

    return () => {
      scanner.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, resolvedToken, tokenDead, manual]);

  if (!resolvedToken) return null;

  if (!token) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="font-display text-2xl font-extrabold">No scanner link</p>
          <p className="md-body-large mt-3 max-w-sm text-on-surface-variant">
            Ask your organiser for a scanner link for this event — it is a single
            link from their admin dashboard, good for a set number of hours.
          </p>
        </div>
      </div>
    );
  }

  if (tokenDead) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="font-display text-2xl font-extrabold text-error">
            This link no longer works
          </p>
          <p className="md-body-large mt-3 max-w-sm text-on-surface-variant">{tokenDead}</p>
          <p className="md-body-medium mt-2 text-on-surface-variant">
            Ask your organiser for a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="md-eyebrow text-on-surface-variant">Scanning</p>
          <p className="md-title-large truncate">{claims?.gate ?? 'Gate'}</p>
        </div>
        <Button type="button" variant="outlined" onClick={() => setManual((m) => !m)}>
          {manual ? 'Use camera' : 'Type code'}
        </Button>
      </div>

      {outcome && (
        <div onClick={() => setOutcome(null)} role="button" tabIndex={0}>
          <OutcomeBanner outcome={outcome} />
          <p className="md-body-small mt-1 text-center text-on-surface-variant">
            Tap to dismiss
          </p>
        </div>
      )}

      {manual ? (
        <ManualEntry onSubmit={handleManualSubmit} busy={busy} />
      ) : (
        <div className="overflow-hidden rounded-md bg-black">
          <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
        </div>
      )}

      {cameraError && !manual && (
        <p role="alert" className="md-body-medium text-center text-error">
          {cameraError}
        </p>
      )}

      <p className="md-body-small mt-auto text-center text-on-surface-variant">
        One scan admits one person, once. Each ticket in a party needs its own
        code.
      </p>
    </div>
  );
}

export function ScanPage() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Scanner />
      </ToastProvider>
    </ThemeProvider>
  );
}
