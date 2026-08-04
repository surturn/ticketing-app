import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// QR images for email.
//
// `qrcode.react` renders the on-page QR in the browser; a client that only
// ever opens the email needs the same code as a bitmap it can display without
// running any JavaScript. This is the one place that turns a signed payload
// into pixels — inline as a data: URI, so the image ships inside the HTML
// with no second request an image-blocking client would drop.
// ---------------------------------------------------------------------------

/** Renders a QR payload as a base64 PNG data URI, sized for an email body. */
export async function qrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });
}
