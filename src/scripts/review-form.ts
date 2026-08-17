import { arrowStep, wrapIndex } from '../lib/arrow-step.js';

/**
 * The star picker and the submit for `ReviewForm.astro`.
 *
 * Drives every review form on the page at once — the product page has one, `/review/[orderId]` has
 * one per purchased item — so it is written against a NodeList and holds no module-level state.
 *
 * **No literal ever appears here.** Every message comes off the form's own `data-str-*`, which is
 * what keeps the client's wording inside `translations.ts` and inside the `copy:review` pass
 * (memory `project_client_renderer_i18n_drift`). A string typed here would be invisible to both.
 *
 * The POST is a plain `fetch` — `initCsrf()` in the layout has already wrapped `window.fetch`, so
 * the token rides along with nothing to remember (`scripts/csrf-client.ts`).
 */

interface FormState {
  rating: number;
}

const REASON_KEY: Record<string, string> = {
  spam: 'spam',
  'too-long': 'tooLong',
};

function str(form: HTMLFormElement, key: string): string {
  return form.dataset[key] ?? '';
}

function paint(form: HTMLFormElement, state: FormState, hovered: number): void {
  const shown = hovered || state.rating;
  form.querySelectorAll<HTMLButtonElement>('.review-star').forEach((btn) => {
    const n = Number(btn.dataset.rating);
    const on = n <= shown;
    btn.style.color = on ? 'var(--color-warning)' : 'var(--color-border)';
    // The picker fills whole stars only: a half star is a thing an AVERAGE can be, never a thing
    // one person chooses. Offering ten steps would also make the tap target 13px wide on a phone.
    btn.setAttribute('aria-checked', String(n === state.rating));
    btn.tabIndex = n === (state.rating || 1) ? 0 : -1;
  });
  form.querySelector<HTMLButtonElement>('.review-submit')!.disabled = state.rating === 0;
}

function message(form: HTMLFormElement, text: string, tone: 'ok' | 'error' | 'muted'): void {
  const el = form.querySelector<HTMLParagraphElement>('.review-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = tone === 'ok' ? 'var(--color-success)' : tone === 'error' ? 'var(--color-danger)' : 'var(--color-muted)';
}

function initOne(form: HTMLFormElement): void {
  const state: FormState = { rating: 0 };
  const buttons = [...form.querySelectorAll<HTMLButtonElement>('.review-star')];
  const row = form.querySelector<HTMLElement>('.review-stars');
  if (!buttons.length || !row) return;

  buttons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      state.rating = Number(btn.dataset.rating);
      paint(form, state, 0);
      message(form, '', 'muted');
    });
    // Hover previews the score without committing it — the one hover signal this control gets
    // (AI_INSTRUCTIONS: never stack two).
    btn.addEventListener('mouseenter', () => paint(form, state, Number(btn.dataset.rating)));
    btn.addEventListener('mouseleave', () => paint(form, state, 0));
    btn.addEventListener('keydown', (e) => {
      // `arrowStep` against the ROW, not the document: the star row is deliberately `dir="ltr"` on
      // an RTL page (StarRating.astro says why), so the document's direction is the wrong answer
      // here and ArrowRight really does mean "next star".
      const step = arrowStep(e.key, row);
      if (!step) return;
      e.preventDefault();
      const next = buttons[wrapIndex(index, step, buttons.length)]!;
      state.rating = Number(next.dataset.rating);
      paint(form, state, 0);
      next.focus();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.rating) {
      message(form, str(form, 'strPick'), 'error');
      return;
    }
    const submit = form.querySelector<HTMLButtonElement>('.review-submit')!;
    const body = form.querySelector<HTMLTextAreaElement>('.review-body')?.value ?? '';
    submit.disabled = true;
    submit.classList.add('btn--busy');
    submit.textContent = str(form, 'strSending');
    message(form, '', 'muted');

    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: form.dataset.orderId,
          productId: form.dataset.productId,
          rating: state.rating,
          body,
          ...(form.dataset.token ? { token: form.dataset.token } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (data?.ok) {
        message(form, str(form, 'strThanks'), 'ok');
        // The form is spent: one purchase earns one review, so leaving an enabled button would
        // only offer the buyer a 409 they can do nothing about.
        form.querySelectorAll<HTMLElement>('.review-star, .review-body, .review-submit')
          .forEach((el) => { (el as HTMLButtonElement).disabled = true; });
        form.dispatchEvent(new CustomEvent('review:published', { bubbles: true, detail: data.review }));
        return;
      }

      const key = res.status === 429 ? 'throttled'
        : res.status === 409 ? 'already'
        : REASON_KEY[String(data?.reason)] ?? 'failed';
      message(form, str(form, `str${key[0]!.toUpperCase()}${key.slice(1)}`) || str(form, 'strFailed'), 'error');
    } catch {
      message(form, str(form, 'strFailed'), 'error');
    } finally {
      submit.classList.remove('btn--busy');
      submit.textContent = str(form, 'strSubmit');
      // Re-enabled only while the review is still unwritten — the success path above disabled it
      // permanently and must not be undone here.
      if (!form.querySelector<HTMLButtonElement>('.review-star')?.disabled) submit.disabled = state.rating === 0;
    }
  });

  paint(form, state, 0);
}

export function initReviewForms(root: ParentNode = document): void {
  root.querySelectorAll<HTMLFormElement>('.review-form').forEach((form) => {
    if (form.dataset.reviewInit) return;
    form.dataset.reviewInit = '1';
    initOne(form);
  });
}
