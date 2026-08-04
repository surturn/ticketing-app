// ---------------------------------------------------------------------------
// The HTML shell every email is poured into.
//
// Written for mail clients rather than for browsers, which means going back
// about fifteen years: tables for layout, inline styles only, no flexbox, no
// grid, no external stylesheet, no web font. Gmail strips <style> blocks in
// some contexts and Outlook renders through Word, so anything clever here is a
// broken email in somebody's inbox — and a broken email about a ticket costs
// more trust than a plain one ever would.
//
// Every message still carries the plain-text version alongside. That is not a
// fallback nobody sees: it is what a text-only client shows, what a screen
// reader may prefer, and one of the signals a spam filter weighs.
// ---------------------------------------------------------------------------

/** Escapes interpolated values so a buyer's own name cannot inject markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The palette, matching the storefront.
 *
 * Hexes rather than the design tokens: an email has no custom properties and
 * no dark-mode switch we control, so these are literal by necessity. Held
 * together here so the two do not drift apart silently.
 */
const INK = '#1a1b21';
const MUTED = '#44474f';
const LINE = '#c4c6d0';
const PRIMARY = '#0b5fd9';
const PAPER = '#ffffff';
const CANVAS = '#f4f3fa';

export interface DetailRow {
  label: string;
  value: string;
}

/** One scannable ticket: a QR image with its tier and code underneath. */
export interface TicketQr {
  label: string;
  code: string;
  /** A `data:` URI PNG — inline, so no image request the client can block. */
  dataUrl: string;
}

export interface EmailLayout {
  /** The one-line headline, shown large at the top of the card. */
  heading: string;
  /** Leading paragraphs, before any detail block. */
  intro: string[];
  /** The labelled facts: event, order, amount. */
  details?: DetailRow[];
  /** Scannable QR codes, one per ticket, shown as images. */
  tickets?: TicketQr[];
  /** An optional section heading and body after the details. */
  section?: { title: string; body: string[] };
  /** The single call to action. */
  action?: { label: string; url: string };
  /** Small print under the action — unsubscribe, and anything similar. */
  footnote?: string;
}

function detailTable(rows: DetailRow[]): string {
  const cells = rows
    .map(
      ({ label, value }) => `
        <tr>
          <td style="padding:6px 16px 6px 0;color:${MUTED};font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td>
          <td style="padding:6px 0;color:${INK};font-size:14px;font-weight:600">${esc(value)}</td>
        </tr>`,
    )
    .join('');

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="background:${CANVAS};border-radius:4px;padding:16px 20px;margin:24px 0">
      <tr><td>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">${cells}</table>
      </td></tr>
    </table>`;
}

/**
 * The QR block: one image per ticket, tier and code underneath.
 *
 * A table per ticket, not a grid — the same Outlook constraint as the button
 * below. The image is a `data:` URI, embedded rather than linked, because a
 * remote image is exactly what a mail client blocks until someone clicks
 * "show images," and a ticket nobody can see at the gate is worse than a
 * slightly heavier email.
 */
function ticketBlock(tickets: TicketQr[]): string {
  const cards = tickets
    .map(
      ({ label, code, dataUrl }) => `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="background:${CANVAS};border-radius:4px;margin:0 0 12px">
          <tr>
            <td align="center" style="padding:20px">
              <img src="${dataUrl}" width="200" height="200" alt="QR code for ${esc(label)} ${esc(code)}"
                   style="display:block;width:200px;height:200px;border:0;background:${PAPER};border-radius:4px">
              <p style="margin:14px 0 0;font-size:13px;color:${MUTED}">${esc(label)}</p>
              <p style="margin:2px 0 0;font-size:15px;font-weight:600;letter-spacing:0.04em;color:${INK}">${esc(code)}</p>
            </td>
          </tr>
        </table>`,
    )
    .join('');

  return `<div style="margin:24px 0">${cards}</div>`;
}

/**
 * The button.
 *
 * A table with a background colour rather than a styled anchor: Outlook ignores
 * padding on an inline element, which turns a button into underlined text.
 * `border-radius` is quietly dropped by the same client, and a square button is
 * an acceptable outcome where an invisible one is not.
 */
function actionButton(label: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px">
      <tr>
        <td align="center" bgcolor="${PRIMARY}" style="border-radius:4px">
          <a href="${esc(url)}"
             style="display:inline-block;padding:13px 28px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">
            ${esc(label)}
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${MUTED}">
      If the button does not work, copy this into your browser:<br>
      <span style="color:${MUTED};word-break:break-all">${esc(url)}</span>
    </p>`;
}

const FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

export function renderEmail(layout: EmailLayout): string {
  const intro = layout.intro
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK}">${esc(paragraph)}</p>`,
    )
    .join('');

  const section = layout.section
    ? `<h2 style="margin:28px 0 10px;font-size:15px;font-weight:700;color:${INK}">${esc(layout.section.title)}</h2>` +
      layout.section.body
        .map(
          (paragraph) =>
            `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${MUTED}">${esc(paragraph)}</p>`,
        )
        .join('')
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(layout.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};${FONT}">
  <!-- Shown in the inbox preview line, next to the subject. Hidden in the body
       itself, which is what the zero dimensions and the character padding are
       for: without the padding, clients pull the following body text into the
       preview instead. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">
    ${esc(layout.intro[0] ?? '')}
    ${'&#847;&zwnj;&nbsp;'.repeat(60)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CANVAS}">
    <tr>
      <td align="center" style="padding:32px 16px">

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="max-width:560px;background:${PAPER};border:1px solid ${LINE};border-radius:6px">

          <!-- Masthead. Drawn in text rather than an image: a remote logo is
               blocked by default in most clients, and a brand that only appears
               once someone clicks "show images" is a brand that mostly does not
               appear. -->
          <tr>
            <td style="padding:24px 32px 0">
              <span style="font-size:17px;font-weight:800;letter-spacing:-0.02em;color:${INK}">Eventify</span><span
                    style="font-size:17px;font-weight:800;letter-spacing:-0.02em;color:${PRIMARY}"> Tickets</span>
            </td>
          </tr>

          <tr><td style="padding:0 32px"><div style="height:1px;background:${LINE};margin:18px 0 0"></div></td></tr>

          <tr>
            <td style="padding:26px 32px 32px">
              <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;font-weight:800;letter-spacing:-0.01em;color:${INK}">
                ${esc(layout.heading)}
              </h1>
              ${intro}
              ${layout.details?.length ? detailTable(layout.details) : ''}
              ${layout.tickets?.length ? ticketBlock(layout.tickets) : ''}
              ${section}
              ${layout.action ? actionButton(layout.action.label, layout.action.url) : ''}
            </td>
          </tr>

          <!-- Attribution. The M-Pesa prompt on a buyer's phone shows the
               registered Safaricom business name, not the product name, and a
               payment request from a company they have never heard of is what
               a cancelled order looks like. Saying who builds Eventify, on
               every message, is how that stops being a surprise. -->
          <tr>
            <td style="padding:20px 32px 26px;background:${CANVAS};border-top:1px solid ${LINE};border-radius:0 0 6px 6px">
              <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED}">
                Questions about this order? Reply to this email, or write to
                <a href="mailto:hello@invonicstechnologies.com" style="color:${PRIMARY};text-decoration:underline">hello@invonicstechnologies.com</a>.
              </p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED}">
                Eventify Tickets is built and operated by Invonics Technologies.
                Payments appear on your M-Pesa statement as <strong style="color:${INK}">INVONICS TECHNOLOGIES</strong>.
              </p>
              ${
                layout.footnote
                  ? `<p style="margin:10px 0 0;font-size:12px;line-height:1.6;color:${MUTED}">${esc(layout.footnote)}</p>`
                  : ''
              }
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
