import { formatAgorot } from '../../lib/money.js';
import { formatDayShort } from '../../lib/format-date.js';
import { escapeHtml as esc } from '../../lib/html-escape.js';
import type { SellerTransfers } from '../../lib/seller-transfers.js';

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
  | ({ state: 'ok' } & SellerTransfers)
  | { state: 'no-provider' | 'no-account' | 'unavailable' };

function tt(key: string): string {
  try {
    const dict = JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {};
    return String(dict[key] ?? '');
  } catch { return ''; }
}

/** One `label: value` line. The whole strip is this shape — a labelled grid rather than prose, so a
 *  seller looking for one figure finds it by its label (`feedback_labelled_grid_over_prose`). */
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

  const lines: string[] = [row(tt('payTransferPending'), formatAgorot(data.pendingAgorot), true)];

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
    // silent: it is not swallowed — it becomes the `unavailable` state, which prints
    // `payTransferUnavailable` where the figure would have been. A toast on top of a strip that
    // already says it could not read would be the same sentence twice.
    data = { state: 'unavailable' };
  }

  const html = bodyHtml(data);
  // Nothing to say — no gateway, or no clearing account yet. The strip stays out of the DOM's way
  // rather than rendering an empty card: the go-live screen further down already owns "you have no
  // account", and two screens saying it is one more than the seller needs.
  if (!html) { strip.hidden = true; return; }
  body.innerHTML = html;
  strip.hidden = false;
}
