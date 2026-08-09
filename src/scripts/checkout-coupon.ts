/**
 * The coupon field on the checkout page — markup, state and the one network call.
 *
 * **Why it is a disclosure and not a field.** A coupon box that is always on screen is a field
 * almost every shopper has nothing to put in, and for the ones who suspect a code exists it is an
 * invitation to leave and go looking for one. So there are two gates before anything is drawn:
 * the store has to actually be running a live code (the server says so — `storeOffersCoupon`,
 * answered on the price refresh this page already makes), and the buyer has to press "יש לי קוד
 * קופון" before a text input exists. A store with no promotion running adds exactly zero pixels
 * to the page, which is the whole answer to "how do we add this without weighing the UI down".
 *
 * **The number is a preview, and the server is the till.** Applying a code fetches its TERMS, and
 * `lib/coupons.ts#couponDiscountAgorot` — the same pure function `/api/checkout` uses — turns
 * those into the figure shown. The code itself travels with the purchase and every part of the
 * decision is made again server-side before a card is touched. That is the same arrangement the
 * store sale already has (`resolvePrice` is isomorphic for the same reason), and it is why a code
 * that expires while the buyer fills in their address fails loudly at the pay button rather than
 * quietly charging a different number than the one on screen.
 *
 * Markup as a STRING rather than a component because the checkout cart is rebuilt client-side on
 * every render — the same reason `price-html.ts` and `discount-field.ts` exist.
 */

import { couponDiscountAgorot, type PublicCoupon } from '../lib/coupons.js';
import { escapeHtml as esc } from '../lib/html-escape.js';
import { toAgorot, fromAgorot } from '../lib/money.js';

/** Codes accepted so far, per store slug. Survives a re-render (the cart's markup does not). */
const applied = new Map<string, PublicCoupon>();

export function appliedCoupon(storeSlug: string): PublicCoupon | undefined {
  return applied.get(storeSlug);
}

/** What the codes come to for the pay button — `{ storeSlug: code }`, only for stores actually
 *  being paid for right now. A code attached to a store whose lines were all unticked must not
 *  travel: `/api/checkout` would refuse a coupon for a store that is not in the order. */
export function couponCodesFor(storeSlugs: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slug of storeSlugs) {
    const c = applied.get(slug);
    if (c) out[slug] = c.code;
  }
  return out;
}

/** The discount this store's applied code takes off an ILS subtotal, in ILS. Zero when no code is
 *  applied, and zero when the subtotal has not reached the code's minimum — the same verdict the
 *  server reaches, because it is the same function over the same numbers. */
export function couponSavingIls(storeSlug: string, subtotalIls: number): number {
  const c = applied.get(storeSlug);
  if (!c) return 0;
  const subtotalAgorot = toAgorot(subtotalIls);
  if (subtotalAgorot < c.minSubtotalAgorot) return 0;
  return fromAgorot(couponDiscountAgorot(c, subtotalAgorot));
}

export function clearCoupon(storeSlug: string): void {
  applied.delete(storeSlug);
}

/** Drop every code — used when the pay button comes back with a coupon rejection, so the page
 *  cannot keep showing a discount the server has just refused. */
export function clearAllCoupons(): void {
  applied.clear();
}

export interface CouponStrings {
  /** "יש לי קוד קופון" — the closed disclosure. */
  have: string;
  placeholder: string;
  apply: string;
  remove: string;
  /** "קוד לא תקף" */
  invalid: string;
  /** "נסו שוב בעוד רגע" — the throttled answer, which is not the buyer's fault. */
  throttled: string;
  /** "הקוד תקף מ-{min}" — `{min}` is replaced with the formatted threshold. */
  belowMin: string;
  applied: string;
}

/**
 * One store's coupon row.
 *
 * Rendered inside `.co-store-block`, above the shipping card, because that is where the money for
 * this store stops being a list of items and starts being a total. Open when a code is already
 * applied, closed otherwise — a re-render must not throw away a discount the buyer just earned.
 */
export function couponRowHtml(storeSlug: string, s: CouponStrings, index: number): string {
  const c = applied.get(storeSlug);
  const slug = esc(storeSlug);
  // **Keyed by the block's INDEX, not by the slug.** Store slugs carry Hebrew (`url-base.ts#toSlug`
  // keeps it deliberately), so deriving an id by stripping the slug down to `[A-Za-z0-9-]` collapses
  // every Hebrew-slugged store to the SAME string — two stores in one cart would then share one DOM
  // id, and `aria-controls` on the second disclosure would point at the first one's panel. The
  // position in the rendered list is unique by construction and needs no escaping.
  const inputId = `co-coupon-${index}`;
  return `<div class="co-coupon mb-3" data-store-slug="${slug}">
    <button type="button" class="co-coupon__toggle inline-flex items-center gap-1.5 bg-transparent border-0 p-0 text-[.83rem] font-semibold [color:var(--color-accent)] cursor-pointer [font-family:inherit] hover:underline"
            aria-expanded="${c ? 'true' : 'false'}" aria-controls="${inputId}-panel" data-store-slug="${slug}"${c ? ' hidden' : ''}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a2 2 0 0 1 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1-2-2z"/><line x1="9" y1="9" x2="9" y2="9.01"/><line x1="15" y1="15" x2="15" y2="15.01"/><line x1="15.5" y1="8.5" x2="8.5" y2="15.5"/></svg>
      ${esc(s.have)}
    </button>
    <div id="${inputId}-panel" class="co-coupon__panel mt-2"${c ? '' : ' hidden'}>
      ${c ? `<div class="co-coupon__applied flex items-center justify-between gap-2 py-2 px-3 rounded-[var(--radius)]" style="background:color-mix(in srgb, var(--color-sale) 9%, var(--color-surface));border:1px solid color-mix(in srgb, var(--color-sale) 22%, transparent)">
          <span class="flex items-center gap-1.5 min-w-0 text-[.83rem] font-semibold [color:var(--color-sale)]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            <span class="overflow-hidden text-ellipsis whitespace-nowrap" dir="ltr">${esc(c.code)}</span>
          </span>
          <button type="button" class="co-coupon__remove bg-transparent border-0 p-0 text-[.78rem] [color:var(--color-muted)] cursor-pointer [font-family:inherit] hover:[color:var(--color-text)]" data-store-slug="${slug}">${esc(s.remove)}</button>
        </div>`
        : `<div class="flex items-center gap-2">
          <input type="text" id="${inputId}" class="co-coupon__input flex-1 min-w-0 py-2 px-3 border-[1.5px] [border-color:var(--color-border)] rounded-[var(--radius)] bg-[color:var(--color-bg)] [color:var(--color-text)] text-[.875rem] [font-family:inherit] uppercase transition-[border-color,background] duration-150 box-border focus:outline-none focus:[border-color:var(--color-accent)] focus:bg-[color:var(--color-surface)]"
                 dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24"
                 placeholder="${esc(s.placeholder)}" aria-label="${esc(s.have)}" data-store-slug="${slug}" />
          <button type="button" class="co-coupon__apply btn btn--ghost btn--sm shrink-0" data-store-slug="${slug}">${esc(s.apply)}</button>
        </div>`}
      <p class="co-coupon__msg hidden text-[.78rem] mt-1.5 [color:var(--color-danger)]" role="status"></p>
    </div>
  </div>`;
}

/** Open the closed disclosure and focus the field — the press and the field appearing are one
 *  action, so the buyer is never left hunting for where to type. */
export function openCouponPanel(row: HTMLElement): void {
  const toggle = row.querySelector<HTMLElement>('.co-coupon__toggle');
  const panel = row.querySelector<HTMLElement>('.co-coupon__panel');
  toggle?.setAttribute('aria-expanded', 'true');
  panel?.removeAttribute('hidden');
  panel?.querySelector<HTMLInputElement>('.co-coupon__input')?.focus();
}

export type CouponApplyResult = { ok: true } | { ok: false; message: string };

/**
 * Check a typed code with the server and remember it on success.
 *
 * `subtotalIls` is passed so a code that is real but not yet earned ("above ₪150") is refused
 * HERE with the threshold named, instead of being accepted and silently taking nothing off. That
 * check is deliberately on the client: the threshold is part of the code's public terms, and the
 * buyer can act on it — add another item — which is the only refusal in this feature that is a
 * suggestion rather than a dead end.
 */
export async function applyCouponCode(
  storeSlug: string,
  code: string,
  subtotalIls: number,
  s: CouponStrings,
  formatIls: (n: number) => string,
): Promise<CouponApplyResult> {
  let res: Response;
  try {
    res = await fetch('/api/cart/coupon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeSlug, code }),
    });
  } catch {
    // Offline or the request never landed. Reported as "try again in a moment" rather than
    // "wrong code": telling a buyer their real code is invalid because our network blinked is the
    // one wrong answer here — it sends them away believing the promotion was fake.
    return { ok: false, message: s.throttled };
  }
  const data = await res.json().catch(() => null) as
    { ok?: boolean; coupon?: PublicCoupon; throttled?: boolean } | null;

  if (!data?.ok || !data.coupon) {
    return { ok: false, message: data?.throttled ? s.throttled : s.invalid };
  }
  const coupon = data.coupon;
  if (toAgorot(subtotalIls) < coupon.minSubtotalAgorot) {
    return { ok: false, message: s.belowMin.replace('{min}', formatIls(fromAgorot(coupon.minSubtotalAgorot))) };
  }
  applied.set(storeSlug, coupon);
  return { ok: true };
}
