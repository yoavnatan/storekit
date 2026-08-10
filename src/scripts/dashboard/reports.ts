/**
 * The reports tab's client half — three controls, one fetch, one table.
 *
 * `ReportsPanel.astro`'s header carries the product reasoning (why this is its own tab, why
 * nothing is rendered server-side, why the stock report has no period). This file is only the
 * wiring, and the two things worth knowing about it are:
 *
 *  • **The export is a real `<a download>`, never a fetch-and-blob.** The href is rebuilt whenever
 *    the selection changes, so the browser performs the download itself: it lands in the seller's
 *    Downloads folder with the server's filename, it can be re-run from the browser's own download
 *    list, and it does not need this script to be alive at the moment it is pressed.
 *  • **A failed load never blanks the table.** Same rule the store grid learned on 2026-08-10: an
 *    empty answer and no answer are different facts, and rendering "no rows" for a request that
 *    did not arrive tells a seller their month was empty. On failure the previous table stays,
 *    the error goes to the toast surface, and the period chip goes back to the one whose numbers
 *    are actually on screen.
 */
import { escapeHtml as esc } from '../../lib/html-escape.js';
import { formatAgorot } from '../../lib/money.js';
import { periodRange } from '../../lib/date-range.js';
// `seller-report-shapes.js`, never `seller-reports.js`: the builders there import `orders.ts`,
// which reaches `db.ts`, which opens a connection pool at module scope — so importing them from a
// browser file would bundle Postgres into the seller dashboard.
import { isReportId, type ReportId, type SalesRow, type ProductSalesRow, type StockRow } from '../../lib/seller-report-shapes.js';
import { showErrorToast } from '../../lib/toast.js';

const ENDPOINT = '/api/seller/reports';

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export type AnyRow = SalesRow | ProductSalesRow | StockRow;
interface Payload { ok?: boolean; rows?: AnyRow[]; totals?: Record<string, number> }

/** A column: its heading, how to draw a cell, and whether it is a number (so the whole column can
 *  be right-aligned and tabular in one place rather than per cell). */
export interface Column<R> {
  key: string;
  head: string;
  num?: boolean;
  cell: (row: R) => string;
  /**
   * What this column sorts BY, when it sorts at all. A column without one is not sortable, and
   * that is most of them on purpose — see `tableHtml`.
   *
   * Deliberately the underlying VALUE and never the rendered cell: `cell` returns HTML with a
   * currency symbol and thousands separators in it, so sorting on that would order 1,000 ₪ before
   * 90 ₪ and read as a broken table rather than a different opinion about order.
   */
  sortBy?: (row: R) => number | string;
}

const money = (agorot: number): string => formatAgorot(agorot);

export function columnsFor(report: ReportId, t: Record<string, string>): Column<never>[] {
  const sales: Column<SalesRow>[] = [
    { key: 'day', head: t.repColDate ?? '', cell: (r) => esc(r.dayISO), sortBy: (r) => r.dayISO },
    { key: 'buyer', head: t.repColCustomer ?? '', cell: (r) => esc(r.buyerName) },
    { key: 'items', head: t.repColItems ?? '', num: true, cell: (r) => String(r.items) },
    { key: 'gross', head: t.repColGross ?? '', num: true, cell: (r) => money(r.grossAgorot) },
    { key: 'discount', head: t.repColDiscount ?? '', num: true, cell: (r) => (r.discountAgorot ? `−${money(r.discountAgorot)}` : '—') },
    { key: 'net', head: t.repColNet ?? '', num: true, cell: (r) => money(r.netAgorot), sortBy: (r) => r.netAgorot },
    { key: 'commission', head: t.repColCommission ?? '', num: true, cell: (r) => (r.commissionAgorot ? `−${money(r.commissionAgorot)}` : '—') },
    { key: 'payout', head: t.repColPayout ?? '', num: true, cell: (r) => `<strong>${money(r.payoutAgorot)}</strong>`, sortBy: (r) => r.payoutAgorot },
    {
      key: 'state',
      head: t.repColState ?? '',
      // The one column that is not a number and not a name: whether this row is IN the totals.
      // A cancelled order stays listed — a seller reconciling a month needs to see it — so the
      // row has to say why it contributes nothing, or it reads as an arithmetic error.
      cell: (r) => (r.countsAsRevenue
        ? `<span class="report-state report-state--ok">${esc(t.repStateCounted ?? '')}</span>`
        : `<span class="report-state report-state--off">${esc(t.repStateNotCounted ?? '')}</span>`),
    },
  ];

  const products: Column<ProductSalesRow>[] = [
    { key: 'name', head: t.repColProduct ?? '', cell: (r) => esc(r.name), sortBy: (r) => r.name },
    { key: 'sku', head: t.repColSku ?? '', cell: (r) => esc(r.sku) || '—' },
    { key: 'units', head: t.repColUnits ?? '', num: true, cell: (r) => String(r.units), sortBy: (r) => r.units },
    { key: 'gross', head: t.repColGross ?? '', num: true, cell: (r) => money(r.grossAgorot) },
    { key: 'net', head: t.repColNet ?? '', num: true, cell: (r) => `<strong>${money(r.netAgorot)}</strong>`, sortBy: (r) => r.netAgorot },
    // Blank, not 0, for a product that has since been deleted: a sold line is a snapshot and
    // outlives the product it points at, and "0" would send the seller restocking a ghost.
    { key: 'stock', head: t.repColStock ?? '', num: true, cell: (r) => (r.stock === null ? '—' : String(r.stock)) },
  ];

  const stock: Column<StockRow>[] = [
    { key: 'name', head: t.repColProduct ?? '', cell: (r) => esc(r.name), sortBy: (r) => r.name },
    { key: 'sku', head: t.repColSku ?? '', cell: (r) => esc(r.sku) || '—' },
    { key: 'stock', head: t.repColStock ?? '', num: true, cell: (r) => String(r.stock), sortBy: (r) => r.stock },
    { key: 'value', head: t.repColStockValue ?? '', num: true, cell: (r) => money(r.valueAgorot), sortBy: (r) => r.valueAgorot },
    {
      key: 'state',
      head: t.repColState ?? '',
      cell: (r) => {
        const label = r.state === 'out' ? t.repStockOut : r.state === 'low' ? t.repStockLow : t.repStockOk;
        const mod = r.state === 'ok' ? 'ok' : r.state === 'low' ? 'warn' : 'off';
        return `<span class="report-state report-state--${mod}">${esc(label ?? '')}</span>`;
      },
    },
  ];

  const byReport = { sales, products, stock };
  return byReport[report] as unknown as Column<never>[];
}

/**
 * Sorting, and why only some columns have it.
 *
 * The seller's questions of a report are few and known: which sale was biggest, which product
 * earned most, what is nearly out of stock, and what happened on a given day. Those are the
 * columns that carry a `sortBy`. A sort arrow on "customer" or "SKU" would answer nothing anybody
 * asks and would turn a readable header row into nine competing controls.
 *
 * FILTERING is deliberately absent, and that is a decision rather than a gap. The table is already
 * scoped by report and by period, the export button is right above it, and a spreadsheet filters
 * better than anything built here would — the export IS the filtering story. A filter row would be
 * a second, weaker filtering language layered on a table the seller is about to open in Excel.
 *
 * Sorting is CLIENT-SIDE over the rows already loaded, which is correct because a report is not
 * paginated: what is on screen is the whole window. It never re-requests, so it cannot fail.
 */
export function sortRows(rows: AnyRow[], col: Column<never> | undefined, dir: 1 | -1): AnyRow[] {
  if (!col?.sortBy) return rows;
  const key = col.sortBy as (row: AnyRow) => number | string;
  // A copy: `rows` is the payload the export href and the totals were built from, and sorting it
  // in place would quietly reorder what those describe.
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
  });
}

function tableHtml(report: ReportId, rows: AnyRow[], t: Record<string, string>, sortKey = '', sortDir: 1 | -1 = 1): string {
  if (rows.length === 0) return `<p class="muted text-[0.85rem] m-0 py-8 text-center">${esc(t.repEmpty ?? '')}</p>`;
  const cols = columnsFor(report, t);
  const active = cols.find((c) => c.key === sortKey);
  const head = cols.map((c) => {
    const cls = c.num ? ' class="report-num"' : '';
    if (!c.sortBy) return `<th scope="col"${cls}>${esc(c.head)}</th>`;
    const on = c.key === sortKey;
    // `aria-sort` on the header is what a screen reader reads the order off; the arrow is the
    // sighted half of the same fact, never the only one (no colour-only, no glyph-only state).
    const ariaSort = on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none';
    const arrow = on ? (sortDir === 1 ? '▲' : '▼') : '';
    return `<th scope="col"${cls} aria-sort="${ariaSort}">`
      + `<button type="button" class="report-sort" data-sort="${esc(c.key)}">`
      + `${esc(c.head)}<span class="report-sort__arrow" aria-hidden="true">${arrow}</span></button></th>`;
  }).join('');
  const body = sortRows(rows, active, sortDir).map((row) => {
    const cells = cols.map((c) =>
      // `data-label` is what turns the row into a labelled card under 700px (dashboard.css) — the
      // treatment the orders table already uses, rather than a second mobile layout.
      `<td data-label="${esc(c.head)}"${c.num ? ' class="report-num"' : ''}>${c.cell(row as never)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="report-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function summaryText(report: ReportId, totals: Record<string, number>, t: Record<string, string>): string {
  const n = (key: string): number => totals[key] ?? 0;
  if (report === 'stock') {
    return [
      `${t.repSumProducts ?? ''} ${n('products')}`,
      `${t.repSumUnits ?? ''} ${n('units')}`,
      `${t.repSumStockValue ?? ''} ${money(n('valueAgorot'))}`,
      n('out') ? `${t.repSumOut ?? ''} ${n('out')}` : '',
    ].filter(Boolean).join(' · ');
  }
  if (report === 'products') {
    return [
      `${t.repSumUnits ?? ''} ${n('units')}`,
      `${t.repSumNet ?? ''} ${money(n('netAgorot'))}`,
    ].join(' · ');
  }
  return [
    `${t.repSumOrders ?? ''} ${n('rows')}`,
    `${t.repSumNet ?? ''} ${money(n('netAgorot'))}`,
    `${t.repSumCommission ?? ''} ${money(n('commissionAgorot'))}`,
    `${t.repSumPayout ?? ''} ${money(n('payoutAgorot'))}`,
  ].join(' · ');
}

export function initReportsTab(): void {
  const root = document.getElementById('reports-root');
  if (!root) return;

  const storeSlug = root.dataset.storeSlug ?? '';
  const rangeRow = document.getElementById('reports-range') as HTMLElement | null;
  const wrap = document.getElementById('reports-table-wrap') as HTMLElement | null;
  const summaryEl = document.getElementById('reports-summary') as HTMLElement | null;
  const exportLink = document.getElementById('reports-export') as HTMLAnchorElement | null;
  const fromInput = document.getElementById('reports-from') as HTMLInputElement | null;
  const toInput = document.getElementById('reports-to') as HTMLInputElement | null;
  const t = i18n();

  // The selection whose rows are actually ON SCREEN, as opposed to the one just clicked. A failed
  // fetch restores from this, so the chips can never name a period the table below them is not.
  let shown = { report: 'sales' as ReportId, preset: 'thisMonth' };
  let inFlight = 0;
  // Whether a table has ever been painted. On a LATER failure the previous rows stay on screen and
  // the toast is the whole message; on the FIRST one there is nothing behind the loading line, and
  // a toast that fades leaves the panel saying "loading" for as long as the seller looks at it.
  let everRendered = false;
  // The rows currently on screen, kept so a sort click re-renders from memory. A report is not
  // paginated — the window IS the whole answer — so re-requesting to reorder would be a round trip
  // that can fail, for a change the browser can make instantly and cannot get wrong.
  let lastRows: AnyRow[] = [];
  let sortKey = '';
  let sortDir: 1 | -1 = 1;

  const currentReport = (): ReportId => (isReportId(root.dataset.report) ? root.dataset.report : 'sales');

  /**
   * The window the table is showing: whatever is typed in the two date fields, else the pressed
   * preset. Both fields must be filled and in order before a custom window counts — a half-typed
   * range would otherwise fire a load on every keystroke of the year, and `from > to` is a request
   * the server rejects with a 400 the seller cannot act on.
   */
  function currentRange(): { from: string; to: string } {
    const from = fromInput?.value ?? '';
    const to = toInput?.value ?? '';
    if (from && to && from <= to) return { from, to };
    return periodRange(root!.dataset.preset ?? 'thisMonth');
  }

  /** True while the two fields hold a usable window — which is what un-presses the chips. */
  const customActive = (): boolean => {
    const from = fromInput?.value ?? '';
    const to = toInput?.value ?? '';
    return !!from && !!to && from <= to;
  };

  function query(format?: 'csv'): string {
    const report = currentReport();
    const params = new URLSearchParams({ report, storeSlug });
    if (report !== 'stock') {
      const { from, to } = currentRange();
      params.set('from', from);
      params.set('to', to);
    }
    if (format) params.set('format', format);
    return `${ENDPOINT}?${params.toString()}`;
  }

  function paintControls(): void {
    const report = currentReport();
    for (const btn of root!.querySelectorAll<HTMLElement>('.report-pick')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.report === report));
    }
    // No chip is pressed while a custom window is in force: leaving "this month" lit beside two
    // date fields naming a different fortnight is the same class of lie as a range label that
    // outlives the figures under it (performance.ts's `restoreShownRange` note).
    const custom = customActive();
    for (const btn of root!.querySelectorAll<HTMLElement>('.report-preset')) {
      btn.setAttribute('aria-pressed', String(!custom && btn.dataset.preset === root!.dataset.preset));
    }
    // A stocktake has no period. Hidden rather than disabled: a row of seven dead chips is a
    // question the seller cannot answer and should not have been asked.
    if (rangeRow) rangeRow.hidden = report === 'stock';
  }

  async function load(): Promise<void> {
    paintControls();
    const report = currentReport();
    const token = ++inFlight;
    if (wrap) wrap.setAttribute('aria-busy', 'true');
    if (exportLink) exportLink.setAttribute('aria-disabled', 'true');

    let payload: Payload | null = null;
    // The one refusal a seller can actually act on, and the only one worth its own sentence: the
    // window they typed is longer than the endpoint will build (MAX_DAYS). Everything else — a
    // 500, a dropped connection — is "try again", which the generic notice already says. Without
    // this, picking January two years ago answered "something went wrong", which is true and
    // useless: nothing tells them the fix is a shorter range.
    let tooLong = false;
    try {
      const res = await fetch(query());
      if (res.ok) payload = await res.json() as Payload;
      else if (res.status === 400) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        tooLong = body?.error === 'Range too large';
      }
      // silent: reported below — `payload` stays null, which restores the previous selection and
      // toasts, and never draws an empty report for a request that did not arrive.
    } catch { /* payload stays null — reported below, never drawn as an empty report */ }

    // A newer click already went out: it owns the table now.
    if (token !== inFlight) return;

    if (!payload?.ok || !payload.rows) {
      root!.dataset.report = shown.report;
      root!.dataset.preset = shown.preset;
      paintControls();
      if (wrap) {
        wrap.removeAttribute('aria-busy');
        if (!everRendered) {
          const line = tooLong ? (t.repRangeTooLongTitle ?? '') : (t.repLoadFailedTitle ?? '');
          wrap.innerHTML = `<p class="muted text-[0.85rem] m-0 py-8 text-center">${esc(line)}</p>`;
        }
      }
      if (tooLong) showErrorToast(t.repRangeTooLongTitle ?? '', t.repRangeTooLongBody ?? '');
      else showErrorToast(t.repLoadFailedTitle ?? '', t.repLoadFailedBody ?? '');
      return;
    }

    // A new report or a new window is a new question — the previous column's order would be
    // carried onto data it was never chosen for, and the server's own ordering (newest first,
    // biggest earner first, most urgent stock first) is the better default every time.
    lastRows = payload.rows;
    sortKey = '';
    sortDir = 1;
    if (wrap) {
      wrap.innerHTML = tableHtml(report, lastRows, t, sortKey, sortDir);
      wrap.removeAttribute('aria-busy');
      everRendered = true;
    }
    if (summaryEl) summaryEl.textContent = summaryText(report, payload.totals ?? {}, t);
    if (exportLink) {
      exportLink.href = query('csv');
      // Nothing to export is not an error, but a download of a header row and no rows is a file
      // the seller has to open to discover is empty.
      if (payload.rows.length === 0) exportLink.setAttribute('aria-disabled', 'true');
      else exportLink.removeAttribute('aria-disabled');
    }
    shown = { report, preset: root!.dataset.preset ?? 'thisMonth' };
  }

  root.addEventListener('click', (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>('.report-pick');
    if (pick && pick.dataset.report !== root.dataset.report) {
      root.dataset.report = pick.dataset.report ?? 'sales';
      void load();
      return;
    }
    const preset = (e.target as HTMLElement).closest<HTMLElement>('.report-preset');
    if (preset) {
      // Pressing a chip CLEARS the custom window — otherwise the chip lights up and the table does
      // not move, because `currentRange` would still be reading the two date fields. Handled even
      // when the same chip is re-pressed, since that is the gesture for "back to this preset".
      const wasCustom = customActive();
      if (fromInput) fromInput.value = '';
      if (toInput) toInput.value = '';
      if (wasCustom || preset.dataset.preset !== root.dataset.preset) {
        root.dataset.preset = preset.dataset.preset ?? 'thisMonth';
        void load();
      }
    }
  });

  // `change`, not `input`: a date field fires `input` per segment, so typing a year would send
  // three requests for windows the seller never asked for. `change` is the browser saying the
  // value is complete.
  for (const el of [fromInput, toInput]) {
    el?.addEventListener('change', () => {
      // An incomplete or backwards pair is not an error to shout about — the seller is mid-typing.
      // It simply falls back to the pressed preset, and `paintControls` re-lights the chip.
      void load();
    });
  }

  // Sort: same column toggles direction, a new column starts ascending. No fetch — see sortRows.
  wrap?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.report-sort');
    const key = btn?.dataset.sort;
    if (!key) return;
    if (key === sortKey) sortDir = sortDir === 1 ? -1 : 1;
    else { sortKey = key; sortDir = 1; }
    wrap.innerHTML = tableHtml(currentReport(), lastRows, t, sortKey, sortDir);
  });

  // A disabled link is still a link, and a click on one must do nothing rather than navigate to
  // an empty href — which on this site would reload the dashboard and lose the seller's place.
  exportLink?.addEventListener('click', (e) => {
    if (exportLink.getAttribute('aria-disabled') === 'true' || !exportLink.getAttribute('href')) e.preventDefault();
  });

  void load();
}
