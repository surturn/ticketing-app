import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// QR images for email.
//
// Rendered as raw PNG bytes, base64-encoded, for embedding as a CID
// attachment rather than as a `data:` URI in the `<img src>`. Outlook's
// desktop client renders HTML mail through Word's engine, which does not
// display a `data:` URI image at all — the ticket a buyer needs at the gate
// would silently not be there, with nothing in the message to say so. A CID
// attachment is a real MIME part instead, referenced from the HTML as
// `cid:<name>`, and it is the one embedding mechanism that actually renders
// inline across every major mail client, Outlook included.
// ---------------------------------------------------------------------------

/** Renders a QR payload as base64-encoded PNG bytes, for a CID attachment. */
export async function qrPngBase64(payload: string): Promise<string> {
  const buffer = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });
  return buffer.toString('base64');
}
