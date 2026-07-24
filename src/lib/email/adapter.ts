// Email adapter contract — the single seam every email provider plugs into.
//
// Swapping Resend for Brevo/SendGrid/SES later means writing one new file that
// implements EmailAdapter and pointing index.ts at it — no caller changes.
// Same black-box discipline as the DB adapters in src/lib/*: the rest of the
// app depends on this interface, never on a concrete provider's SDK.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback for clients that don't render HTML (and better deliverability). */
  text: string;
  /** Where a reply goes (defaults to the platform's business email if omitted). */
  replyTo?: string;
}

export interface EmailResult {
  ok: boolean;
  /** Provider message id when sent, or the reason it didn't. */
  id?: string;
  error?: string;
  /** Which adapter handled it — 'console' means nothing actually left the server. */
  provider: string;
}

export interface EmailAdapter {
  readonly name: string;
  send(message: EmailMessage, from: string): Promise<EmailResult>;
}
