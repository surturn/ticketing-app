/**
 * Interrupts someone leaving while their seats are actually held.
 *
 * The fact behind this is real, which is the only reason it exists. A checkout
 * takes a genuine reservation — `ORDER_HOLD_MINUTES` on the server — and the
 * expiry worker really does return those seats to the pool. A buyer who wanders
 * off mid-payment loses them without ever being told there was a clock, and
 * then comes back to an event that is sold out. Saying so is information they
 * would otherwise pay for by losing the tickets.
 *
 * Three rules keep this a notice rather than a trap:
 *
 *   1. It only appears while the hold is live — an order still awaiting payment
 *      with time left on it. Once paid, expired or cancelled there is nothing
 *      to lose and nothing to say, so it does not fire at all.
 *   2. Both choices are full-size, legible controls. Staying is visually
 *      primary because it is the common intent, which is ordinary hierarchy —
 *      but leaving is a real button a thumb can find at a glance, not grey
 *      text hidden in a corner. A buyer who cannot work out how to leave does
 *      not convert; they force-quit, and some of them dispute the charge, which
 *      is a worse outcome than the abandoned cart this is meant to prevent.
 *   3. It fires once. An interstitial that reappears every time somebody tries
 *      to leave is the thing people screenshot, and rightly.
 */
import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from './ui';
import { formatCountdown } from '@/lib/format';

export function LeaveCheckoutDialog({
  active,
  expiresAt,
}: {
  /** True only while seats are genuinely reserved and payment is outstanding. */
  active: boolean;
  expiresAt: string | null;
}) {
  // Once used, this checkout does not ask again.
  const [spent, setSpent] = useState(false);
  const spentRef = useRef(spent);
  spentRef.current = spent;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      active &&
      !spentRef.current &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  const [remaining, setRemaining] = useState(() =>
    expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0,
  );

  useEffect(() => {
    if (!expiresAt) return;
    const id = window.setInterval(
      () => setRemaining(new Date(expiresAt).getTime() - Date.now()),
      1_000,
    );
    return () => window.clearInterval(id);
  }, [expiresAt]);

  /**
   * Releases the block the moment the hold stops being real.
   *
   * Without this, a payment that lands while the dialog is open would leave the
   * buyer trapped behind a warning about seats they have now bought.
   */
  useEffect(() => {
    if (!active && blocker.state === 'blocked') blocker.proceed();
  }, [active, blocker]);

  if (blocker.state !== 'blocked') return null;

  const leave = () => {
    setSpent(true);
    blocker.proceed();
  };

  const stay = () => {
    setSpent(true);
    blocker.reset();
  };

  const timeLeft = remaining > 0 ? formatCountdown(remaining) : null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 grid place-items-center bg-scrim/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-checkout-title"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          className="w-full max-w-sm rounded-lg bg-surface-container-high p-6 shadow-xl"
        >
          <h2 id="leave-checkout-title" className="md-title-large text-on-surface">
            Your seats are still held
          </h2>

          <p className="md-body-medium mt-3 text-on-surface-variant">
            {timeLeft
              ? `They are reserved for another ${timeLeft}. If you leave before paying, they go back on sale for someone else.`
              : 'If you leave before paying, they go back on sale for someone else.'}
          </p>

          <div className="mt-6 flex flex-col gap-2">
            <Button onClick={stay} full>
              Finish paying
            </Button>
            {/* Outlined and full width — the same size and the same reach as the
                option above it. Which one is primary is a matter of emphasis,
                not of whether the other can be found. */}
            <Button variant="outlined" onClick={leave} full>
              Leave and release them
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
