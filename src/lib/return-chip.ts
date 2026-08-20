import { escapeHtml as esc } from './html-escape.js';
import type { ReturnStatus } from './returns.js';

/**
 * The chip an ORDER CARD wears while a return is running on it — as a dictionary KEY, not a word.
 *
 * ── The bug this closes, and it is this repo's standing twin-renderer class ──
 * The seller's order card is rendered twice: by the server on first paint, and again in JavaScript
 * after any search, sort, page change or fifteen-second poll (`scripts/dashboard/orders.ts`). The
 * server drew this chip; the client twin had never heard of it. So a return chip appeared on load
 * and then **silently disappeared** the moment the seller typed in the search box or turned a page —
 * which is exactly the confusion the owner reported (2026-08-20: *"אני מבולבל, אני יכול למצוא את
 * האינפורמציה גם על גבי כרטיסיית הזמנה?"*). The honest answer was "sometimes".
 *
 * `lib/return-buyer-cta.ts` was written for the same class one screen over, and its header states
 * the rule this file follows: **the DECISION travels, and each renderer only draws.** So this maps a
 * status to a key each side looks up in its own dictionary — never to a Hebrew string, which in a
 * client renderer is the drift `i18n-hardcoded-strings.test.ts` refuses.
 *
 * ── Why the closed states are empty ──
 * A chip that says "finished" on a row is one more thing to read past. The order is no longer in the
 * middle of anything: `rejected` left it exactly as it was, and `refunded` moved its own status to
 * `returned`, which the card's status badge already shows.
 */
export type ReturnChipKey =
  | 'returnChipWaiting' | 'returnChipReturning' | 'returnChipOnTheWay'
  | 'returnChipArrived' | 'returnChipDeciding' | 'returnChipOffered';

export const RETURN_CHIP_KEY: Record<ReturnStatus, ReturnChipKey | ''> = {
  requested: 'returnChipWaiting',
  approved: 'returnChipReturning',
  in_transit: 'returnChipOnTheWay',
  received: 'returnChipArrived',
  disputed: 'returnChipDeciding',
  offered: 'returnChipOffered',
  rejected: '',
  refunded: '',
  expired: '',
};

/**
 * What travels with an order to its card: the chip's key, and the short id the returns tab searches
 * by.
 *
 * The id is here rather than derived on the card because the chip is a LINK now — pressing it opens
 * the returns tab already searched down to this one case, which is the other half of the owner's
 * question. `data-return-order` on the returns card is the same eight characters, and both come from
 * `orderId.slice(0, 8)`; keeping the slice in one place is what stops a link that finds nothing.
 */
export interface OrderReturnChip {
  key: ReturnChipKey;
  /** The order's first 8 characters — what the returns tab's search matches on. */
  lookup: string;
  /** The raw machine state. The chip DISPLAYS `key`; the orders filter MATCHES this — a filter
   *  keyed on a dictionary key would break the day a wording pass renames one. */
  state: ReturnStatus;
}

export function orderReturnChip(status: ReturnStatus, orderId: string): OrderReturnChip | null {
  const key = RETURN_CHIP_KEY[status];
  return key ? { key, lookup: orderId.slice(0, 8), state: status } : null;
}

/**
 * The chip itself, as HTML — drawn by the server component and by the client renderer from this one
 * function, for the reason the whole module exists: they had drifted to "drawn" and "not drawn at
 * all".
 *
 * A `<button>` rather than a `<span>`, and that is the second half of the owner's question. Seeing
 * that an order is in the middle of coming back is not the same as being able to act on it — the
 * chip now opens the returns tab searched down to this one case, so the tab stops being a place he
 * has to remember to visit. Wired through `data-goto-panel` + `data-goto-intent`, the mechanism the
 * overview tiles already use (`scripts/dashboard/panel-intent.ts`).
 *
 * @param label the state, in the reader's language — `t.dashboard[chip.key]`
 * @param openLabel what pressing it does, for the tooltip and the accessible name
 */
export function orderReturnChipHtml(chip: OrderReturnChip | null, label: string, openLabel: string): string {
  if (!chip) return '';
  return (
    '<button type="button" class="order-return-chip inline-flex items-center gap-1 shrink-0 text-[0.72rem]'
    + ' font-semibold rounded-[var(--radius-sm)] px-1.5 py-0.5 border-0 cursor-pointer'
    + ' transition-[filter] duration-100 hover:brightness-95'
    + ' [background:color-mix(in_srgb,var(--color-warning)_12%,transparent)] [color:var(--color-warning)]"'
    + ` data-goto-panel="returns" data-goto-intent="search:${esc(chip.lookup)}"`
    + ` data-tooltip="${esc(openLabel)}" aria-label="${esc(`${label} — ${openLabel}`)}">`
    // An arrow curving back into a tray: the same silhouette the returns tab uses, and deliberately
    // unlike the note and invoice glyphs beside it.
    + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>'
    + esc(label)
    + '</button>'
  );
}
