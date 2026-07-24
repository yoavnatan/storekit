// Resend adapter — talks to Resend's REST API over fetch (no SDK dependency, so
// nothing to bundle and nothing provider-specific leaks past this file).
// Free tier: ~3,000 emails/month. Activated only when RESEND_API_KEY is set;
// see index.ts for adapter selection. Docs: https://resend.com/docs/api-reference/emails/send-email

import type { EmailAdapter, EmailMessage, EmailResult } from './adapter.js';

const ENDPOINT = 'https://api.resend.com/emails';

export function createResendAdapter(apiKey: string): EmailAdapter {
  return {
    name: 'resend',
    async send(message: EmailMessage, from: string): Promise<EmailResult> {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          }),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return { ok: false, provider: 'resend', error: `HTTP ${res.status} ${detail}`.trim() };
        }

        const data = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, provider: 'resend', id: data.id };
      } catch (err) {
        return { ok: false, provider: 'resend', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
