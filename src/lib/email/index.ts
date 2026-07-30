// sendEmail() — the one entry point the rest of the app calls to send mail.
//
// Adapter selection is env-driven and lazy: a real provider (Resend) is used
// when its key is present, otherwise the console no-op adapter, so dev/CI need
// no account and no code path is gated behind secrets. Swapping providers =
// add an adapter file + one branch here; callers never change.
//
// Resilient by contract: send() catches everything and resolves to an
// EmailResult — it never throws, so a mail failure can't break the flow that
// triggered it (checkout must still succeed if the confirmation email fails).

import { store } from '../../config/store.config.js';
import type { EmailAdapter, EmailMessage, EmailResult } from './adapter.js';
import { createResendAdapter } from './resend-adapter.js';
import { serverEnv } from '../runtime-env.js';
import { createConsoleAdapter } from './console-adapter.js';

let cached: EmailAdapter | null = null;

function getAdapter(): EmailAdapter {
  if (cached) return cached;
  const resendKey = serverEnv('RESEND_API_KEY');
  cached = resendKey ? createResendAdapter(resendKey) : createConsoleAdapter();
  return cached;
}

/** The verified sender address. Must be on a domain verified with the provider
 *  (see GO_LIVE_CHECKLIST §4) — falls back to a localhost-safe default in dev. */
function fromAddress(): string {
  const configured = serverEnv('EMAIL_FROM');
  if (configured) return configured;
  return `${store.name} <no-reply@${new URL(store.url).hostname}>`;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const adapter = getAdapter();
  const withReplyTo: EmailMessage = {
    ...message,
    replyTo: message.replyTo ?? store.business.email,
  };
  try {
    return await adapter.send(withReplyTo, fromAddress());
  } catch (err) {
    // Defensive — adapters shouldn't throw, but sendEmail() must never surface one.
    return { ok: false, provider: adapter.name, error: err instanceof Error ? err.message : String(err) };
  }
}

export type { EmailMessage, EmailResult } from './adapter.js';
