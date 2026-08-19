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
  const subject = document.getElementById('seller-inquiry-subject') as HTMLInputElement | null;
  const text = document.getElementById('seller-inquiry-text') as HTMLTextAreaElement | null;
  const send = document.getElementById('seller-inquiry-send') as HTMLButtonElement | null;
  const cancel = document.getElementById('seller-inquiry-cancel') as HTMLButtonElement | null;
  if (!toggle || !form || !subject || !text || !send || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';

  // Server-rendered, like every other string a script writes here — the fallback covers a missing
  // attribute only and is never the source of the sentence.
  let dict: Record<string, string> = {};
  try { dict = JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; } catch { /* noop */ }
  const needsSubject = dict.platformInquiryNeedsSubject ?? 'צריך נושא — כדי שנדע במה מדובר לפני שנפתח';
  const leftTemplate = dict.platformInquiryLeft ?? 'נותרו {n} תווים';

  /** Counts DOWN, and only once something is typed: an empty field announcing "120 characters left"
   *  is a limit presented as a target. It reads off `maxlength` rather than a number of its own, so
   *  the two can never disagree about what the ceiling is. */
  const wireCounter = (field: HTMLInputElement | HTMLTextAreaElement, out: HTMLElement | null) => {
    const max = Number(field.getAttribute('maxlength') ?? 0);
    const paint = () => {
      if (out) out.textContent = field.value.length ? leftTemplate.replace('{n}', String(max - field.value.length)) : '';
    };
    field.addEventListener('input', paint);
    // Typing is the correction, so the red goes the moment it starts — a field that stays marked
    // while being fixed is the version of this that people learn to ignore.
    field.addEventListener('input', () => field.removeAttribute('aria-invalid'));
    paint();
    return paint;
  };
  // The repaint is RETURNED and called directly rather than driven by a synthetic `input` event.
  // Two guards say why, and they are the same lesson from both ends: `unsaved-notice.test.ts`
  // forbids a hand-rolled `new Event('input')`, and `field-repaint-guard.test.ts` requires anything
  // using `announceValueChange` to also listen for `dash:fieldsrewritten`. Both exist for WIDGETS —
  // a control whose state lives in a field and whose picture lives elsewhere in the DOM. A counter
  // that reads the field it sits under is not one of those; it has no state to announce and nothing
  // to restore. Reaching for either helper here would be borrowing machinery for a problem this
  // does not have.
  const repaint = [
    wireCounter(subject, document.getElementById('seller-inquiry-subject-left')),
    wireCounter(text, document.getElementById('seller-inquiry-text-left')),
  ];

  /** One place that closes it, so the toggle, Cancel and a successful send cannot drift apart. */
  const close = (clear: boolean) => {
    if (clear) {
      subject.value = '';
      text.value = '';
      subject.removeAttribute('aria-invalid');
      // The counters read the fields, so clearing them has to repaint — or a reopened form still
      // claims the last message's remaining count.
      repaint.forEach((paint) => paint());
    }
    form.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', 'false');
  };

  cancel?.addEventListener('click', () => { close(true); toggle.focus(); });

  toggle.addEventListener('click', () => {
    const open = form.hasAttribute('hidden');
    if (!open) { close(false); return; }
    form.removeAttribute('hidden');
    toggle.setAttribute('aria-expanded', 'true');
    // Focused only on OPEN, and only because the seller pressed a button that means "I want to
    // write" — the reply boxes further down this page deliberately do not autofocus, since an
    // always-open textarea under every thread reads as a chat window.
    subject.focus();
  });

  send.addEventListener('click', async () => {
    const title = subject.value.trim();
    const message = text.value.trim();
    // The subject is required HERE and defaulted on the server, which is not a duplicated rule: the
    // server's fallback keeps a fault report from a stranger out of a "הודעת מערכת" row, and this
    // asks the seller — who is opening a conversation that will be answered — to name it.
    if (!title) {
      // The site's own invalid state, not a toast alone: a message that scrolls away leaves the
      // field looking exactly as it did before, and the person has to remember which one it meant.
      subject.setAttribute('aria-invalid', 'true');
      showErrorToast(needsSubject);
      subject.focus();
      return;
    }
    if (!message) { text.focus(); return; }
    send.disabled = true;
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'question', subject: title, message, pageUrl: location.pathname }),
      });
      if (res.status === 429) {
        const body = await res.json() as { retryAfterMinutes?: number };
        showErrorToast(`נשלחו יותר מדי פניות. אפשר לנסות שוב בעוד ${body.retryAfterMinutes ?? 60} דקות.`);
        return;
      }
      if (!res.ok) throw new Error('failed');
      close(true);
      showToast('הפנייה נשלחה. התשובה תופיע כאן, בהודעות.');
    } catch {
      showErrorToast('שליחת הפנייה נכשלה, נסו שוב');
    } finally {
      send.disabled = false;
    }
  });
}
