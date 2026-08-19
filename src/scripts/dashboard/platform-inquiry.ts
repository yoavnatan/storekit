import { showToast, showErrorToast } from '../../lib/toast.js';

/**
 * "פנייה לפלטפורמה" — the seller's way to START a conversation with us.
 *
 * **Until 2026-08-19 there was none.** A seller could reply inside a thread the admin had opened,
 * and nothing else; a seller with a question found a `mailto:` on `/contact` and left the product.
 * The owner's answer when the gap was put to him: *"להודעות, כשרשור שאפשר לענות לו"*.
 *
 * It posts to `/api/report`, which is the same endpoint the contact form uses, and that is
 * deliberate rather than lazy: everything that makes an inquiry actionable — the role, the account
 * id, the store — is resolved there from the SESSION, so a second endpoint would be a second place
 * for that rule to live and a second place for it to drift. Signed in as a seller, the thread comes
 * out attached to their account, which is what puts the answer back in their own Messages tab.
 */
export function initPlatformInquiry(): void {
  const toggle = document.getElementById('seller-inquiry-toggle') as HTMLButtonElement | null;
  const form = document.getElementById('seller-inquiry-form');
  const text = document.getElementById('seller-inquiry-text') as HTMLTextAreaElement | null;
  const send = document.getElementById('seller-inquiry-send') as HTMLButtonElement | null;
  if (!toggle || !form || !text || !send || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';

  toggle.addEventListener('click', () => {
    const open = form.hasAttribute('hidden');
    if (open) form.removeAttribute('hidden'); else form.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Focused only on OPEN, and only because the seller pressed a button that means "I want to
    // write" — the reply boxes further down this page deliberately do not autofocus, since an
    // always-open textarea under every thread reads as a chat window.
    if (open) text.focus();
  });

  send.addEventListener('click', async () => {
    const message = text.value.trim();
    if (!message) { text.focus(); return; }
    send.disabled = true;
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'question', message, pageUrl: location.pathname }),
      });
      if (res.status === 429) {
        const body = await res.json() as { retryAfterMinutes?: number };
        showErrorToast(`נשלחו יותר מדי פניות. אפשר לנסות שוב בעוד ${body.retryAfterMinutes ?? 60} דקות.`);
        return;
      }
      if (!res.ok) throw new Error('failed');
      text.value = '';
      form.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      showToast('הפנייה נשלחה. התשובה תופיע כאן, בהודעות.');
    } catch {
      showErrorToast('שליחת הפנייה נכשלה, נסו שוב');
    } finally {
      send.disabled = false;
    }
  });
}
