// Console adapter — the zero-config dev/no-key fallback. Nothing leaves the
// server; it just logs that an email WOULD have been sent, so local dev and CI
// work with no provider account and the checkout flow stays fully exercisable.
// Selected automatically by index.ts whenever no real provider key is present.

import type { EmailAdapter, EmailMessage, EmailResult } from './adapter.js';

export function createConsoleAdapter(): EmailAdapter {
  return {
    name: 'console',
    async send(message: EmailMessage, from: string): Promise<EmailResult> {
      // eslint-disable-next-line no-console
      console.info(`[email:console] would send "${message.subject}" from ${from} → ${message.to}`);
      return { ok: true, provider: 'console', id: 'console-noop' };
    },
  };
}
