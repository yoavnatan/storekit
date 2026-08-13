import { escapeHtml as esc } from './html-escape.js';
import type { DeliveryMethod } from './shipping.js';
import type { BuyerInvoiceMode } from './invoicing/buyer-invoice.js';

/**
 * The buyer-invoice strip on a seller's order card — ONE builder, used by both renderers.
 *
 * The order card is rendered twice: server-side in `seller/dashboard.astro` for the first paint, and
 * again in `scripts/dashboard/orders.ts` when the list is filtered, sorted or paged. Every string
 * written into only one of them is a section that changes when the seller clicks "sort by date",
 * which is exactly the drift `translations.ts` was created to end
 * ([[project_client_renderer_i18n_drift]]). So the markup lives here and both call it.
 *
 * What it renders is deliberately small: the seller's own system produced the document, and this is
 * only the record that he provided it. Two actions, one line of state, no form.
 */

export interface OrderInvoiceRowState {
  mode: BuyerInvoiceMode | null;
  documentUrl: string | null;
}

export interface OrderInvoiceRowLabels {
  title: string;
  hint: string;
  owed: string;
  upload: string;
  handedShip: string;
  handedPickup: string;
  uploaded: string;
  view: string;
}

const CLS = {
  section: 'order-card__invoice mt-3 pt-3 border-t border-[color:var(--color-border)]',
  head: 'text-[0.78rem] font-bold text-[color:var(--color-muted)] uppercase tracking-[0.05em] mb-2',
  row: 'flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.82rem]',
  action: 'order-invoice-action inline-flex items-center gap-1.5 font-semibold [color:var(--color-primary)] bg-transparent border-0 p-0 cursor-pointer hover:underline',
  done: 'order-invoice-state inline-flex items-center gap-1.5 font-semibold [color:var(--color-success)]',
  owed: 'order-invoice-state [color:var(--color-muted)]',
  link: 'order-invoice-link font-semibold [color:var(--color-primary)] hover:underline',
  hint: 'order-invoice-hint block mt-1.5 text-[0.72rem] [color:var(--color-muted)]',
};

const CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const UP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

/**
 * `delivery` picks WHICH handover the seller is offered, and it is not cosmetic: "צורפה לחבילה" is
 * a false statement about a self-pickup order, and a seller ticking the only box he was given would
 * be making it. A parcel and a counter are two different acts and the label names the real one.
 */
/**
 * The chip on the COLLAPSED card — shown only while the invoice is still owed.
 *
 * **Only while owed, and that is the whole design.** A marker that is present on every order is
 * furniture: the seller stops seeing it within days, and it is then also useless on the day it
 * matters (memory `project_tab_strip_alert_beacon` — a beacon always on is not a beacon). Owed is a
 * state he can end, so the chip disappears when he ends it, which is what makes its presence mean
 * something.
 *
 * **Not a red dot.** A dot in this app is a call to act NOW and chains from the avatar down; issuing
 * a tax invoice is the seller's obligation to the tax authority rather than something stuck on the
 * platform, and it would raise a dot on nearly every new order. This is a status glyph in the muted
 * colour, next to the note chip and deliberately a DIFFERENT silhouette from it: a receipt with a
 * torn bottom edge, against the note's folded page. Two grey icons of the same shape would be worse
 * than one.
 *
 * The label lives only in `title`/`aria-label`, because the header is a dense row and a word here
 * would push the amount and the status badge around on a phone.
 */
export function orderInvoiceChipHtml(state: OrderInvoiceRowState | null, label: string): string {
  if (state?.mode) return '';
  return (
    `<span class="order-invoice-chip inline-flex items-center shrink-0 [color:var(--color-muted)] cursor-help"` +
    ` data-tooltip="${esc(label)}" aria-label="${esc(label)}" tabindex="0">` +
    // ── The two things this glyph has to do at 13px ──
    // **Not read as the note chip.** That one is a full-width page with a folded corner and lines
    // across it. This is a NARROW slip torn off at the bottom, and it gives up its right-hand third
    // to the badge — so the two differ in outline before either is recognised, which is all a reader
    // gets at this size.
    // **Say "missing", not "here".** The badge is a MINUS rather than an ×: an × is the close/delete
    // glyph everywhere else in this dashboard, so on an order card it invites a click that would
    // destroy something, and at 13px its two strokes collapse into a blob. A minus stays one clean
    // horizontal at any size and reads as absence.
    // The badge is filled with the surface colour so it punches a hole in the slip behind it instead
    // of tangling with its edge — a stroke-only circle at this size is two lines crossing.
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 2.8h11v15.4l-2.75-1.6-2.75 1.6-2.75-1.6L4 18.2z"/>' +
      '<line x1="7.2" y1="7.4" x2="11.8" y2="7.4"/><line x1="7.2" y1="11" x2="11.8" y2="11"/>' +
      '<circle cx="17.6" cy="17.6" r="4.9" fill="var(--color-surface)"/>' +
      '<line x1="15.4" y1="17.6" x2="19.8" y2="17.6"/>' +
    '</svg></span>'
  );
}

export function orderInvoiceRowHtml(
  state: OrderInvoiceRowState | null,
  delivery: DeliveryMethod | null | undefined,
  labels: OrderInvoiceRowLabels,
): string {
  const handedLabel = delivery === 'pickup' ? labels.handedPickup : labels.handedShip;

  let body: string;
  if (state?.mode === 'upload' && state.documentUrl) {
    // `rel="noopener"` on a target=_blank link that the SELLER supplied the URL for. The host is
    // pinned server-side (`buyer-invoice.ts`), so this is the second layer rather than the only one.
    body =
      `<span class="${CLS.done}">${CHECK}${esc(labels.uploaded)}</span>` +
      `<a class="${CLS.link}" href="${esc(state.documentUrl)}" target="_blank" rel="noopener noreferrer">${esc(labels.view)}</a>`;
  } else if (state?.mode === 'handover') {
    body = `<span class="${CLS.done}">${CHECK}${esc(handedLabel)}</span>`;
  } else {
    body =
      `<span class="${CLS.owed}">${esc(labels.owed)}</span>` +
      `<button type="button" class="${CLS.action}" data-invoice-mode="upload">${UP}${esc(labels.upload)}</button>` +
      `<button type="button" class="${CLS.action}" data-invoice-mode="handover">${esc(handedLabel)}</button>`;
  }

  // The hint appears only while the invoice is still owed. Once it is settled the sentence has
  // nothing left to ask for, and a standing line of prose above a resolved state is exactly the
  // thing the owner asked never to leave on a screen.
  const hint = state?.mode ? '' : `<span class="${CLS.hint}">${esc(labels.hint)}</span>`;

  return (
    `<div class="${CLS.section}">` +
      `<h3 class="${CLS.head}">${esc(labels.title)}</h3>` +
      `<div class="${CLS.row}">${body}</div>` +
      hint +
    '</div>'
  );
}
