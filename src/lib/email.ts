import { brevoConfigured, env } from '../config/env.js';
import { serviceUnavailable } from './errors.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Brevo transactional email.
//
// Deliberately a plain `fetch` against the REST API rather than the @getbrevo
// SDK: the SDK is a generated wrapper over one POST, and one fewer dependency
// in the worker image is worth more than the typings.
//
// Errors are classified before they propagate, along one line: will this
// message ever succeed unchanged?
//
// A 400 will not — a malformed address or an unverified sender fails identically
// forever, and retrying only burns the queue's attempts, so it is non-retryable.
// A 429 or 5xx will, once Brevo recovers. So will a 401 or 403, once whoever
// owns the account fixes the key or the authorised-IP list — those are account
// state, not this message, which is why they retry rather than discard.
// ---------------------------------------------------------------------------

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15_000;

export interface EmailMessage {
  to: string;
  toName?: string | null;
  subject: string;
  /** Plain-text body. Converted to minimal HTML for clients that demand it. */
  text: string;
  html?: string;
}

export interface EmailResult {
  sent: boolean;
  messageId?: string;
  skipped?: 'not_configured' | 'no_recipient';
}

/** Escapes text so a buyer's name can never inject markup into the email. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtml(text: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#111">${escapeHtml(
    text,
  )
    .split('\n')
    .join('<br>')}</div>`;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (!brevoConfigured) {
    logger.warn(
      { to: message.to, subject: message.subject },
      'BREVO_API_KEY/BREVO_SENDER_EMAIL not set — email not sent',
    );
    return { sent: false, skipped: 'not_configured' };
  }

  if (!message.to) {
    return { sent: false, skipped: 'no_recipient' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [{ email: message.to, ...(message.toName ? { name: message.toName } : {}) }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html ?? textToHtml(message.text),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw serviceUnavailable('email_timeout', 'Brevo request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();

  if (!response.ok) {
    // 429 and 5xx are transient; retrying is correct. Everything else is a
    // configuration or payload problem that will fail identically forever.
    if (response.status === 429 || response.status >= 500) {
      throw serviceUnavailable(
        'email_provider_error',
        `Brevo returned ${response.status}: ${body}`,
      );
    }

    // 401 and 403 are the exception to that rule. They describe the state of the
    // account rather than anything about this message, they resolve through an
    // operator action rather than a change of payload, and while they last every
    // message is affected equally.
    //
    // Retrying is therefore the correct response: the queue backs off, and
    // delivery resumes on its own once the account is usable again.
    if (response.status === 401 || response.status === 403) {
      throw serviceUnavailable(
        'email_provider_unauthorised',
        `Brevo rejected our credentials (${response.status}): ${body}`,
      );
    }

    logger.error(
      { status: response.status, body, to: message.to },
      'Brevo rejected the message — not retrying',
    );
    return { sent: false };
  }

  const parsed = JSON.parse(body) as { messageId?: string };
  logger.info(
    { to: message.to, subject: message.subject, messageId: parsed.messageId },
    'email sent',
  );

  return { sent: true, messageId: parsed.messageId };
}
