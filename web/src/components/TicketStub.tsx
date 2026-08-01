/**
 * A ticket, as an object worth keeping.
 *
 * The brand asks for something that reads as a physical collectible rather than
 * a receipt, so the card carries the two features that say "ticket" without a
 * caption: notches punched into the sides, and a perforated tear line between
 * the body and the stub.
 *
 * Both are pure CSS. The notches are a radial-gradient mask, which means they
 * cut through whatever is behind them — the card keeps its shape over any
 * background and at any width, with no images and nothing to load.
 */
import { QRCodeSVG } from 'qrcode.react';
import { motion } from 'framer-motion';
import type { OrderTicket } from '@/lib/api';
import { formatEventDate } from '@/lib/format';

export function TicketStub({
  ticket,
  eventName,
  startsAt,
  venue,
  timezone,
  index = 0,
}: {
  ticket: OrderTicket;
  eventName: string;
  startsAt: string;
  venue: string | null;
  timezone: string;
  index?: number;
}) {
  const used = ticket.status === 'checked_in';
  const voided = ticket.status === 'void';

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      // The physical spring from the brand's motion spec, so the arrival has
      // weight rather than simply appearing.
      transition={{ type: 'spring', stiffness: 200, damping: 15, delay: index * 0.08 }}
      className="relative"
    >
      <div
        className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container"
        style={{
          // Two notches, one per side, at the tear line. `mask` clips the card
          // itself, so the cut-outs are genuinely transparent.
          maskImage:
            'radial-gradient(circle 14px at 0 68%, transparent 98%, black 100%), radial-gradient(circle 14px at 100% 68%, transparent 98%, black 100%)',
          maskComposite: 'intersect',
          WebkitMaskImage:
            'radial-gradient(circle 14px at 0 68%, transparent 98%, black 100%), radial-gradient(circle 14px at 100% 68%, transparent 98%, black 100%)',
          WebkitMaskComposite: 'source-in',
        }}
      >
        {/* Body. A live ticket sits on the tertiary container — Material's own
            way of saying "this one is special" — so the moment of confirmation
            still has a colour the rest of the app does not use. */}
        <div
          className={`relative p-5 ${
            !used && !voided
              ? 'bg-tertiary-container text-on-tertiary-container'
              : 'text-on-surface'
          }`}
        >
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              {/* The tier is a fact the door checks, so it stays in the data
                  face. Colour is inherited from the container rather than
                  pinned to `on-surface-variant`, which would be reaching for a
                  role paired with a different background. */}
              <p className="md-data-small tracking-widest uppercase opacity-80">
                {ticket.tierName}
              </p>
              <h3 className="md-title-large mt-1">{eventName}</h3>
              <p className="md-data-medium mt-1 opacity-80">
                {formatEventDate(startsAt, timezone)}
              </p>
              {venue && <p className="md-body-medium opacity-80">{venue}</p>}
            </div>

            {(used || voided) && (
              <span
                className={`md-label-medium shrink-0 rounded-full border px-2.5 py-0.5 ${
                  voided
                    ? 'border-error/40 text-error'
                    : 'border-outline-variant text-on-surface-variant'
                }`}
              >
                {voided ? 'Void' : 'Admitted'}
              </span>
            )}
          </div>
        </div>

        {/* Tear line, aligned with the notches. */}
        <div
          className="mx-4 border-t border-dashed border-outline-variant"
          aria-hidden="true"
        />

        {/* Stub: the part that gets scanned. */}
        <div className="flex items-center gap-4 p-5">
          <div
            className={`rounded-xl bg-white p-2 transition ${
              used || voided ? 'opacity-40 grayscale' : ''
            }`}
          >
            {/* Encodes `code.signature` exactly as the gate expects. Rendered as
                SVG so it stays sharp on any screen and when zoomed — a scanner
                reading a blurry raster code is a queue at the door. */}
            <QRCodeSVG
              value={ticket.qr}
              size={96}
              level="M"
              marginSize={0}
              aria-label={`QR code for ticket ${ticket.code}`}
            />
          </div>

          <div className="min-w-0">
            <p className="md-body-small text-on-surface-variant">Ticket code</p>
            {/* Tabular figures and generous tracking: this gets read aloud and
                typed in by hand when a scanner fails. */}
            <p className="md-data-medium mt-0.5 tracking-wider text-on-surface">
              {ticket.code}
            </p>
            <p className="md-body-small mt-2 text-on-surface-variant">
              {used
                ? 'Already scanned at the gate'
                : voided
                  ? 'This ticket was cancelled'
                  : 'Show this at the door'}
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
