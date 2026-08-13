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
