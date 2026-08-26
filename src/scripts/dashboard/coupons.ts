// Seller dashboard → "מבצעים" tab → the coupon-codes card (components/dashboard/CouponsCard.astro).
//
// List, create, edit, delete — all over `fetch` against /api/seller/coupons, with the list redrawn
// from the response rather than reloaded, like every other dashboard mutation
// (memory `feedback_ajax_forms`).
//
// The status word on each row comes from the SERVER's `live` flag, not from a date comparison
// here: the checkout decides whether a code works, and a dashboard that decides it a second way is
// a dashboard that eventually disagrees with the till about a code a seller is standing behind.

import { showToast, showErrorToast } from '../../lib/toast.js';
import { escapeHtml as esc } from '../../lib/html-escape.js';
import { formatPrice } from '../../config/store.config.js';
import { fromAgorot } from '../../lib/money.js';
import { isScheduleOpen } from '../../lib/discounts.js';
import type { StoreCoupon } from '../../lib/coupons.js';
import { initSelectDropdown, refreshSelectDropdown } from './select-dropdown.js';

interface CouponView extends StoreCoupon { live: boolean }
interface CouponsResponse { ok: boolean; coupons?: CouponView[]; error?: string; field?: string }

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Why this code is not working, in the seller's words. Ordered by what they would fix first: a
 *  switch they flipped, then a window that has closed or not opened, then a cap that filled. */
function statusLabel(c: CouponView, i: Record<string, string>): { text: string; live: boolean } {
  if (c.live) return { text: i['couponStatusLive'] ?? 'פעיל', live: true };
  if (!c.active) return { text: i['couponStatusOff'] ?? 'כבוי', live: false };
  if (c.maxUses !== undefined && c.usedCount >= c.maxUses) return { text: i['couponStatusUsedUp'] ?? 'נוצל', live: false };
  // Through `isScheduleOpen`, never a date string built here: it is the function the checkout and
  // every other schedule in this app already ask, and it is a LOCAL calendar day rather than a UTC
  // instant — `toISOString().slice(0,10)` would put a code's last evening in the wrong day for
  // sellers in Israel, which is exactly the confusion `lib/business-day.ts` exists over.
  if (c.endsAt && !isScheduleOpen({ endsAt: c.endsAt })) return { text: i['couponStatusEnded'] ?? 'הסתיים', live: false };
  return { text: i['couponStatusPending'] ?? 'טרם התחיל', live: false };
}

/** The discount itself, in the unit the seller typed it in. `dir="ltr"` on the number so a percent
 *  sign or a ₪ does not jump to the far side of an RTL row (memory `feedback_seller_copy_register`
 *  — no digits stranded beside Latin text). */
function valueLabel(c: CouponView): string {
  return c.kind === 'percent' ? `-${c.value}%` : `-${formatPrice(c.value)}`;
}

/** `YYYY-MM-DD` → the short local date the rest of the dashboard prints (products.ts uses the same
 *  shape). Noon UTC so a date-only string cannot land on the previous day in a negative offset. */
function shortDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/**
 * The schedule, in words rather than with an arrow.
 *
 * There was a `→ 31.08` here and it was wrong twice over (owner, 2026-08-09: "התאריכים לא ברורים,
 * תאריך התחלה לא מופיע, והחץ הפוך"). The start date was simply never printed — so a code scheduled
 * for next week looked identical to one running now, which is exactly the pair a seller needs to
 * tell apart. And an arrow is a DIRECTION on screen, so in Hebrew it points the wrong way; the fix
 * is not to flip it but to remove it, since "מ… עד…" says the same thing in every direction and
 * needs no maintenance the day someone renders this in English.
 */
function scheduleLabel(c: CouponView, i: Record<string, string>): string {
  const from = c.startsAt ? `${i['couponFrom'] ?? 'מ'}-${shortDay(c.startsAt)}` : '';
  const to = c.endsAt ? `${i['couponUntil'] ?? 'עד'} ${shortDay(c.endsAt)}` : '';
  return [from, to].filter(Boolean).join(' ');
}

/**
 * Redemptions, said so the number cannot be misread.
 *
 * "מומש 0 מתוך 1" was three questions at once — of what, per whom, and is 1 a count of coupons?
 * (owner, 2026-08-09.) The cap is a TOTAL across every buyer, which is what "first N customers"
 * means, so the row now says the total out loud and the form's own label and hint say it too.
 */
function usesLabel(c: CouponView, i: Record<string, string>): string {
  const used = `${i['couponRedemptions'] ?? 'מימושים'}: ${c.usedCount}`;
  return c.maxUses === undefined
    ? `${used} ${i['couponUsesUnlimited'] ?? '(ללא הגבלה)'}`
    : `${used} ${i['couponUsedOf'] ?? 'מתוך'} ${c.maxUses}`;
}

function rowHtml(c: CouponView, i: Record<string, string>): string {
  const status = statusLabel(c, i);
  // ONE line: code, then what it gives, then its conditions — a seller scanning this list reads
  // across a row, and the code stacked above its own data made every row two rows and none of them
  // aligned (owner, 2026-08-09). `flex-wrap` still lets a 375px screen break it, which is a
  // different thing from building it broken.
  const facts: string[] = [];
  if (c.minSubtotalAgorot > 0) facts.push(`${i['couponMinBadge'] ?? 'מעל'} ${formatPrice(fromAgorot(c.minSubtotalAgorot))}`);
  facts.push(usesLabel(c, i));
  const when = scheduleLabel(c, i);
  if (when) facts.push(when);

  return `<li class="flex items-center gap-2.5 flex-wrap py-2 px-2.5 rounded-[var(--radius-sm)] border border-[color:var(--color-border)]" data-coupon-row="${esc(c.id)}">
    <span class="font-semibold text-[0.86rem] shrink-0 max-w-[11rem] overflow-hidden text-ellipsis whitespace-nowrap" dir="ltr">${esc(c.code)}</span>
    <span class="sale-chip shrink-0" dir="ltr">${esc(valueLabel(c))}</span>
    <span class="muted text-[0.75rem] min-w-0 flex-1">${esc(facts.join(' · '))}</span>
    <span class="text-[0.75rem] font-semibold shrink-0 ${status.live ? '[color:var(--color-sale)]' : '[color:var(--color-muted)]'}">${esc(status.text)}</span>
    <button type="button" class="btn btn--ghost btn--sm shrink-0" data-coupon-edit="${esc(c.id)}">${esc(i['couponEdit'] ?? 'עריכה')}</button>
    <button type="button" class="btn btn--ghost btn--sm shrink-0" data-coupon-delete="${esc(c.id)}" data-coupon-code="${esc(c.code)}">${esc(i['couponDelete'] ?? 'מחיקה')}</button>
  </li>`;
}

/** A refusal code from the API → the sentence for it. Falls back rather than printing the raw
 *  code: an untranslated `min-subtotal` on screen is worse than a generic failure. */
function errorText(res: CouponsResponse, i: Record<string, string>): string {
  const key = res.error === 'duplicate' ? 'couponErrDuplicate'
    : res.error === 'code' ? 'couponErrCode'
    : res.error === 'value' ? 'couponErrValue'
    : res.error === 'min-subtotal' ? 'couponErrMinSubtotal'
    : res.error === 'uses' ? 'couponErrUses'
    : res.error === 'dates' ? 'couponErrDates'
    : '';
  // A server sentence (a 404 on a store or a row) is already Hebrew and already specific, so it is
  // preferred over the generic line whenever the response carried one instead of a field code.
  return (key && i[key]) || (key ? '' : res.error ?? '') || i['couponErrGeneric'] || 'שמירת הקוד נכשלה.';
}

export function initCouponsCard(): void {
  const card = el<HTMLElement>('coupons-card');
  if (!card || card.dataset['ready'] === '1') return;
  card.dataset['ready'] = '1';

  const i = getI18n();
  const storeId = card.dataset['storeId'] ?? '';
  const form = el<HTMLFormElement>('coupon-form');
  const list = el<HTMLElement>('coupon-list');
  const empty = el<HTMLElement>('coupon-empty');
  const errorEl = el<HTMLElement>('coupon-error');
  const saveBtn = el<HTMLButtonElement>('coupon-save-btn');
  if (!form || !list) return;

  /**
   * The site's own dropdown for אחוז/סכום, not the operating system's (2026-08-26).
   *
   * The identical choice, on the identical dashboard, was already drawn correctly one card away:
   * `discount-field.ts` upgrades the sale form's type select for exactly this reason. The coupon
   * form was the copy that never got it, so a seller setting up a discount met the site's dropdown
   * and a seller setting up a coupon met the browser's — same decision, two different controls,
   * a few centimetres apart. That is the twin-drift shape memory `project_brand_boost_twin_drift`
   * names, and it is why this is a fix rather than a preference.
   *
   * The `<select>` is hidden and MIRRORED, which is the part that needs care rather than the
   * upgrade itself: `showForm` below opens an edit by assigning `.value` straight onto the element,
   * and a programmatic assignment fires no `change` — so the visible trigger would keep whatever it
   * last displayed. Editing a ₪-off coupon would have opened a form reading "אחוז" over a select
   * holding `amount`, and the seller would have had to notice a control disagreeing with itself.
   * `refreshSelectDropdown` there is what makes the mirror follow.
   */
  const kindSelect = el<HTMLSelectElement>('coupon-kind');
  if (kindSelect) initSelectDropdown(kindSelect);

  /** Which row the open form is editing; empty string = a new code. */
  let editingId = '';
  /** The last list the server returned — what an "edit" press reads its values from, so opening the
   *  form costs no round trip and can never show something other than what the list is showing. */
  let loaded: CouponView[] = [];

  const render = (coupons: CouponView[]): void => {
    loaded = coupons;
    list.innerHTML = coupons.map((c) => rowHtml(c, i)).join('');
    empty?.toggleAttribute('hidden', coupons.length > 0);
  };

  const showForm = (c?: CouponView): void => {
    editingId = c?.id ?? '';
    (el<HTMLInputElement>('coupon-code'))!.value = c?.code ?? '';
    (el<HTMLSelectElement>('coupon-kind'))!.value = c?.kind ?? 'percent';
    // The assignment above fires no `change`, so the mirrored trigger has to be told (see the
    // upgrade at the top of this function).
    refreshSelectDropdown(el<HTMLSelectElement>('coupon-kind'));
    (el<HTMLInputElement>('coupon-value'))!.value = c ? String(c.value) : '';
    (el<HTMLInputElement>('coupon-min'))!.value = c && c.minSubtotalAgorot > 0 ? String(fromAgorot(c.minSubtotalAgorot)) : '';
    (el<HTMLInputElement>('coupon-uses'))!.value = c?.maxUses !== undefined ? String(c.maxUses) : '';
    (el<HTMLInputElement>('coupon-starts'))!.value = c?.startsAt ?? '';
    (el<HTMLInputElement>('coupon-ends'))!.value = c?.endsAt ?? '';
    (el<HTMLInputElement>('coupon-active'))!.checked = c ? c.active : true;
    errorEl?.classList.add('hidden');
    form.classList.remove('hidden');
    form.removeAttribute('hidden');
    (el<HTMLInputElement>('coupon-code'))!.focus();
  };

  const hideForm = (): void => {
    editingId = '';
    form.classList.add('hidden');
    form.setAttribute('hidden', '');
  };

  const send = async (payload: Record<string, unknown>): Promise<CouponsResponse> => {
    try {
      const res = await fetch('/api/seller/coupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, ...payload }),
      });
      return await res.json() as CouponsResponse;
      // silent: the caller turns this into `errorText` beside the form, or a toast.
    } catch {
      return { ok: false };
    }
  };

  el<HTMLButtonElement>('coupon-add-btn')?.addEventListener('click', () => showForm());
  el<HTMLButtonElement>('coupon-cancel-btn')?.addEventListener('click', hideForm);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn) saveBtn.disabled = true;
    const data = new FormData(form);
    const res = await send({
      ...(editingId ? { couponId: editingId } : {}),
      code: data.get('code'),
      kind: data.get('kind'),
      value: data.get('value'),
      minSubtotal: data.get('minSubtotal'),
      maxUses: data.get('maxUses'),
      startsAt: data.get('startsAt'),
      endsAt: data.get('endsAt'),
      // An unchecked checkbox sends nothing, so the absence has to be spelled out — otherwise
      // `parseCouponInput`'s default (true) would silently switch a paused code back on.
      active: data.get('active') ? '1' : '0',
    });
    if (saveBtn) saveBtn.disabled = false;

    if (!res.ok || !res.coupons) {
      if (errorEl) { errorEl.textContent = errorText(res, i); errorEl.classList.remove('hidden'); }
      return;
    }
    render(res.coupons);
    hideForm();
    showToast(i['couponSaved'] ?? 'הקוד נשמר');
  });

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const editId = target.closest<HTMLElement>('[data-coupon-edit]')?.dataset['couponEdit'];
    if (editId) {
      const row = list.querySelector<HTMLElement>(`[data-coupon-row="${CSS.escape(editId)}"]`);
      // Read back off the last rendered list rather than re-fetching: the row on screen is the row
      // the server just returned, so a round trip would only re-answer a question already answered.
      const found = loaded.find((c) => c.id === editId);
      if (found) { showForm(found); row?.scrollIntoView({ block: 'nearest' }); }
      return;
    }

    const delBtn = target.closest<HTMLElement>('[data-coupon-delete]');
    if (!delBtn) return;
    const couponId = delBtn.dataset['couponDelete'] ?? '';
    // Through the shared ConfirmModal, never `confirm()` — a standing site-wide ban (Hard rules).
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: i['couponDeleteTitle'] ?? 'למחוק את הקוד?',
        message: `${i['couponDeleteMsg'] ?? ''} ${delBtn.dataset['couponCode'] ?? ''}`.trim(),
        okLabel: i['couponDelete'] ?? 'מחיקה',
        onConfirm: async () => {
          const res = await send({ _action: 'delete', couponId });
          if (!res.ok || !res.coupons) { showErrorToast(errorText(res, i)); return; }
          render(res.coupons);
          if (editingId === couponId) hideForm();
          showToast(i['couponDeleted'] ?? 'הקוד נמחק');
        },
      },
    }));
  });

  /**
   * The list did not load.
   *
   * It used to reveal the EMPTY state here, and the note beside it argued that a toast on page
   * load would be noise for a list most sellers have nothing in. The noise judgement was right and
   * the empty state was the wrong way to act on it: "אין עדיין קודי הנחה" is a statement about the
   * store, and a seller who has three codes and sees it will reasonably conclude they were
   * deleted. So: no toast (nobody pressed anything), and a line that says what actually happened.
   */
  function showLoadFailed(): void {
    empty?.setAttribute('hidden', '');
    list!.innerHTML = `<p class="muted text-[0.85rem] m-0 py-4 text-center">${esc(i['couponsLoadFailed'] ?? '')}</p>`;
  }

  void (async () => {
    try {
      const res = await fetch(`/api/seller/coupons?storeId=${encodeURIComponent(storeId)}`);
      const data = await res.json() as CouponsResponse;
      if (data.ok && data.coupons) render(data.coupons);
      else showLoadFailed();
      // silent: as a TOAST — nobody pressed anything, this is a page-load read. `showLoadFailed`
      // writes the reason where the list would have been, instead of the empty state.
    } catch {
      showLoadFailed();
    }
  })();
}
