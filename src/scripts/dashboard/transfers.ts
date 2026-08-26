import { formatAgorot } from '../../lib/money.js';
import { formatDayShort } from '../../lib/format-date.js';
import { escapeHtml as esc } from '../../lib/html-escape.js';
import type { SellerTransfers } from '../../lib/seller-transfers.js';
import type { InvoiceOffer } from '../../lib/seller-invoicing.js';
import { busyButton } from './btn-busy.js';
import { showErrorToast } from '../../lib/toast.js';

/**
 * Seller dashboard → "תשלומים" → the strip that says how much money is on its way to his bank.
 *
 * Owner, סשן א׳ §1 (2026-08-25). The figures belong to PayMe and are read from
 * `/api/seller/transfers`; the reasoning for reading theirs rather than our own accrual is in
 * `lib/seller-transfers.ts`, and it is the whole reason this file exists rather than a server-side
 * number in the panel.
 *
 * ── Why it is fetched here instead of rendered by the panel ──
 * The panel is server-rendered on the click that opens it, and this is a call to a third party. On
 * the render path, PayMe being slow is the dashboard being slow and PayMe being down is a panel
 * that does not render at all. Here, the worst case is one strip that says it could not read.
 *
 * ── Every state says something DIFFERENT from zero ──
 * "₪0 is waiting for you" and "we could not reach the processor" and "you have no clearing account
 * yet" are three different facts, and a renderer that collapses any of them into a zero is lying on
 * a money screen. Each state below prints its own sentence, and the amount is printed only when the
 * server said `ok`.
 *
 * Strings come from `#i18n-data` and never from a literal here — the drift class
 * `project_client_renderer_i18n_drift`, guarded by `tests/transfers-i18n.test.ts`.
 */
type TransfersResponse =
  | ({ state: 'ok'; invoicing: InvoiceOffer | null } & SellerTransfers)
  | { state: 'no-provider' | 'no-account' | 'unavailable' };

function tt(key: string): string {
  try {
    const dict = JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {};
    return String(dict[key] ?? '');
  } catch { return ''; }
}

/** One `label: value` line. The whole strip is this shape — a labelled grid rather than prose, so a
 *  seller looking for one figure finds it by its label (`feedback_no_standing_screen_prose`). */
function row(label: string, value: string, strong = false): string {
  return (
    '<div class="flex items-baseline justify-between gap-3 py-1">' +
      `<dt class="muted m-0 shrink-0">${esc(label)}</dt>` +
      `<dd class="m-0 text-end ${strong ? 'text-[1.05rem] font-bold' : 'font-semibold'}">${esc(value)}</dd>` +
    '</div>'
  );
}

function bodyHtml(data: TransfersResponse): string {
  if (data.state === 'unavailable') return `<p class="muted m-0">${esc(tt('payTransferUnavailable'))}</p>`;
  if (data.state !== 'ok') return '';

  // The balance itself is no longer a row here — it is the headline above this list
  // (`PayoutsPanel.astro`, owner סשן א׳ §2). What is left is everything that needs a label.
  const lines: string[] = [];

  // The date, only when PayMe have really set one. Their own measurement (`seller-transfers.ts`)
  // is that money accrues into an OPEN window with no payment date, so this is normally the
  // second branch — and inventing "the 10th" from the commercial agreement would be us promising
  // a schedule that is theirs to change per seller.
  if (data.pendingAgorot > 0) {
    lines.push(data.next
      ? row(tt('payTransferNext'), `${formatDayShort(data.next.dayISO)} · ${formatAgorot(data.next.amountAgorot)}`)
      : row(tt('payTransferNext'), tt('payTransferNextUnknown')));
  }

  // History, up to three. A pending figure with nothing behind it is a number a seller has no way
  // to check; the full statement is PayMe's own reporting and not a dashboard strip.
  //
  // **ONE `<dt>` and several `<dd>`, inside ONE wrapper div — not a `row()` each.** A `<div>` inside
  // a `<dl>` must hold one or more `<dt>` followed by one or more `<dd>`; a div carrying a lone
  // heading `<dt>` (the first version) is invalid, and the shape that IS valid is also the truer
  // description — "transferred to you" is one term with several values under it.
  if (data.past.length) {
    const items = data.past.slice(0, 3).map((t) =>
      '<dd class="m-0 mt-1 flex items-baseline justify-between gap-3">' +
        `<span>${esc(formatDayShort(t.dayISO))}</span>` +
        `<span class="font-semibold">${esc(formatAgorot(t.amountAgorot))}</span>` +
      '</dd>').join('');
    lines.push(
      '<div class="mt-3 pt-3 border-t [border-color:var(--color-border)]">' +
        `<dt class="muted m-0">${esc(tt('payTransferPast'))}</dt>${items}` +
      '</div>',
    );
  }

  return lines.join('');
}

/**
 * ── The per-charge fee breakdown left this file on 2026-08-26 (owner, סשן א׳ §1) ──
 * It rendered the last six charges with PayMe's own fee split. That is a RECORD, not a strip, and
 * it now lives where a period can be chosen and a CSV exported — the `fees` report on the Reports
 * tab (`lib/seller-reports.ts#buildFeesReport`), which reads the same `get-transactions` figures
 * server-side and applies the same `paymeDay` rule that keeps a malformed date out of a money row.
 */

/**
 * The one add-on a seller may switch on for himself: PayMe issuing the buyer's invoice in his name.
 *
 * **Absent, not disabled, when PayMe have not provisioned the service** — `invoicing` is null and
 * this renders nothing (`lib/seller-invoicing.ts`). A greyed-out switch would be a feature we are
 * advertising and cannot deliver.
 *
 * **The price is PayMe's, passed through at cost** (owner, 2026-08-25), and it is printed from what
 * the server read back rather than from any number in this repo — so the screen he agrees on is the
 * one he is billed.
 */
function invoicingHtml(offer: InvoiceOffer): string {
  const price = tt('payInvoiceAutoPrice')
    .replace('{monthly}', formatAgorot(offer.monthlyAgorot))
    .replace('{doc}', formatAgorot(offer.perDocumentAgorot));
  return (
    `<h3 class="text-[1.05rem] font-bold m-0">${esc(tt('payInvoiceAutoTitle'))}</h3>` +
    `<p class="m-0 mt-1 text-[0.85rem]">${esc(tt('payInvoiceAutoBody'))}</p>` +
    `<p class="muted m-0 mt-1 text-[0.8rem]">${esc(price)}</p>` +
    '<div class="flex items-center gap-3 mt-3">' +
      `<button type="button" class="btn btn--sm${offer.active ? ' btn--ghost' : ''}" id="pay-invoice-toggle" data-want="${offer.active ? '0' : '1'}">` +
        `${esc(tt(offer.active ? 'payInvoiceAutoDisable' : 'payInvoiceAutoEnable'))}</button>` +
      (offer.active ? `<span class="text-[0.82rem] font-semibold [color:var(--color-success)]">${esc(tt('payInvoiceAutoOn'))}</span>` : '') +
    '</div>'
  );
}

/**
 * Fill the strip. Re-runs with the panel, because a refresh replaces `#payouts-root` and the
 * element this writes into is inside it.
 *
 * A failed fetch is treated exactly as `unavailable`: the seller is told the figure could not be
 * read, which is the true statement, and the strip is never left showing a stale amount from before
 * a refresh.
 */
export async function initTransfersStrip(): Promise<void> {
  const strip = document.getElementById('pay-transfers');
  const body = document.getElementById('pay-transfers-body');
  if (!strip || !body) return;

  let data: TransfersResponse;
  try {
    const res = await fetch('/api/seller/transfers', { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() as TransfersResponse : { state: 'unavailable' };
  } catch {
    // silent: it is not swallowed - it becomes the `unavailable` state, which prints
    // `payTransferUnavailable` where the figure would have been. A toast on top of a strip that
    // already says it could not read would be the same sentence twice.
    data = { state: 'unavailable' };
  }

  // Nothing to say - no gateway, or no clearing account yet. The strip stays out of the DOM's way
  // rather than rendering an empty card: the go-live screen further down already owns "you have no
  // account", and two screens saying it is one more than the seller needs.
  //
  // **Keyed off the STATE, not off the rendered rows.** It used to return early on an empty
  // `bodyHtml`, which was the same test while the balance was one of those rows; it is not any
  // more (the balance is the headline since 2026-08-26), so a seller with ₪0 waiting and no history
  // would have had the whole strip vanish — an absence where a real, correct zero belongs.
  if (data.state === 'no-provider' || data.state === 'no-account') { strip.hidden = true; return; }

  // The headline figure, written straight rather than through `bodyHtml` — it is the one value on
  // this strip that is not a labelled row, and the `<dl>` below has no shape for a bare number.
  // Hidden rather than emptied when there is nothing to print: an empty `<p>` still carries its
  // own top margin, which would open a gap above the sentence that replaced it.
  const amount = document.getElementById('pay-transfers-amount');
  if (amount) {
    amount.textContent = data.state === 'ok' ? formatAgorot(data.pendingAgorot) : '';
    amount.hidden = data.state !== 'ok';
  }
  // The schedule line under the headline is server-rendered and stays in every state: it states a
  // rule ("the 10th of the month"), not a figure, so it is still true when the figure is not there.
  body.innerHTML = bodyHtml(data);
  strip.hidden = false;

  // The invoicing card exists only in the `ok` state, and only when PayMe have provisioned the
  // service at all - a card rendered empty is furniture.
  if (data.state !== 'ok') return;

  const inv = document.getElementById('pay-invoicing');
  if (inv && data.invoicing) {
    renderInvoicing(inv, data.invoicing);
    inv.hidden = false;
  }
}

/**
 * Draw the invoicing card and bind its one button, re-binding after every change.
 *
 * **Re-rendered from the SERVER's answer rather than flipped locally.** The POST returns the
 * account's real state read back from PayMe, so a call that half-succeeded cannot leave the card
 * claiming the opposite; and the price on it is refreshed with it, which matters because PayMe may
 * change their tariff under a 30-day notice.
 */
function renderInvoicing(host: HTMLElement, offer: InvoiceOffer): void {
  host.innerHTML = invoicingHtml(offer);
  const btn = host.querySelector<HTMLButtonElement>('#pay-invoice-toggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const want = btn.dataset.want === '1';
    const busy = busyButton(btn, tt('payInvoiceAutoBusy'));
    try {
      const res = await fetch('/api/seller/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: want }),
      });
      const out = await res.json().catch(() => null) as { ok?: boolean; invoicing?: InvoiceOffer | null } | null;
      if (!res.ok || !out?.ok || !out.invoicing) {
        showErrorToast(tt('payInvoiceAutoFailed'));
        return;
      }
      // **Released BEFORE the re-render, not by the `finally` below.** `renderInvoicing` replaces
      // `host.innerHTML`, which destroys this very button — so on the success path `done()` would
      // restore the old label onto a detached node. Harmless today, and exactly the shape that
      // stops being harmless the first time `done()` is given something else to do.
      busy.done();
      renderInvoicing(host, out.invoicing);
    } catch {
      // Not silent - the seller pressed a button that starts or ends a monthly charge, so a request
      // that never landed has to say so rather than leaving the card looking unchanged and correct.
      showErrorToast(tt('payInvoiceAutoFailed'));
    } finally {
      busy.done();
    }
  });
}
