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
import { periodRange, shortDate, displayDate, PERIOD_PRESETS, PERIOD_PRESET_LABEL_KEY, type PeriodPreset } from '../../lib/date-range.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
// `seller-report-shapes.js`, never `seller-reports.js`: the builders there import `orders.ts`,
// which reaches `db.ts`, which opens a connection pool at module scope — so importing them from a
// browser file would bundle Postgres into the seller dashboard.
import { isReportId, type ReportId, type SalesRow, type ProductSalesRow, type StockRow, type FeeRow } from '../../lib/seller-report-shapes.js';
import { showErrorToast } from '../../lib/toast.js';

const ENDPOINT = '/api/seller/reports';

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export type AnyRow = SalesRow | ProductSalesRow | StockRow | FeeRow;
interface Payload {
  ok?: boolean;
  rows?: AnyRow[];
  totals?: Record<string, number>;
  /** Fee report only — how much of the PROCESSOR's half of the ledger this window really covers.
   *  `partial` and `unavailable` are said in the summary rather than left to look like a quiet
   *  zero (AI_INSTRUCTIONS → no silent caps). */
  processor?: 'ok' | 'partial' | 'unavailable' | 'none';
}

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

/** Eight characters of a machine id, the way every other screen on this dashboard shortens one.
 *  A lookup aid and never an identifier — the whole value travels in the `title` and in the CSV. */
const shortRef = (ref: string): string => `#${ref.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** The products table's sort chevron, to the attribute. Inline SVG and not a glyph — the site has
 *  a standing rule against emoji/geometric characters in place of an icon. */
const SORT_CHEVRON = '<svg class="sort-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';

export function columnsFor(report: ReportId, t: Record<string, string>): Column<never>[] {
  const sales: Column<SalesRow>[] = [
    // DD/MM/YYYY on screen, and the ISO string as the sort key — sorting the formatted text would
    // put 03/08 before 31/07, which is the classic way a date column silently sorts wrong.
    { key: 'day', head: t.repColDate ?? '', cell: (r) => esc(displayDate(r.dayISO)), sortBy: (r) => r.dayISO },
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


  /* ── The fee ledger ──────────────────────────────────────────────────────────────────────
     Five columns and no cleverness: what, who charged it, on what, and how much. **`payee` is a
     column of its own** rather than a shade of the amount — the clearing fee is the processor's and
     the commission is ours, and a seller reading one "fees" column concludes the mall took all of
     it (the same rule that split `payChargeClearing` from `payChargeCommission`). */
  const fees: Column<FeeRow>[] = [
    { key: 'day', head: t.repColDate ?? '', cell: (r) => esc(displayDate(r.dayISO)), sortBy: (r) => r.dayISO },
    {
      key: 'kind',
      head: t.repColFeeKind ?? '',
      cell: (r) => esc(t[FEE_KIND_KEY[r.kind]] ?? ''),
      sortBy: (r) => r.kind,
    },
    { key: 'payee', head: t.repColFeePayee ?? '', cell: (r) => esc(t[r.payee === 'processor' ? 'repFeePayeeProcessor' : 'repFeePayeePlatform'] ?? '') },
    // ── The reference, SHORTENED on screen and whole in the file ──
    // A commission row references an order id and a clearing row references the processor's sale
    // id; both are 36-character machine strings, and printed in full they were the widest column
    // in the table and unreadable in every one of them (driven, 2026-08-26). Eight characters is
    // the convention this project already uses for exactly this — `error-reference.ts#errorRef`,
    // and `order-notify.ts` for an order — and the full value stays in the `title` and in the CSV,
    // which is what a spreadsheet joins on.
    {
      key: 'ref',
      head: t.repColFeeRef ?? '',
      cell: (r) => (r.reference
        ? `<span title="${esc(r.reference)}" dir="ltr">${esc(shortRef(r.reference))}</span>`
        : '—'),
    },
    // A dash, never ₪0: the monthly subscription is not a cut of anything.
    { key: 'base', head: t.repColFeeBase ?? '', num: true, cell: (r) => (r.baseAgorot ? money(r.baseAgorot) : '—') },
    // סכום · מע״מ · סה״כ — a tax invoice's three columns, uniform across every row whoever charged
    // it (owner, 2026-08-26). The last one is bold because it is the money that left his account;
    // the first two are what his bookkeeper posts.
    { key: 'amount', head: t.repColFeeAmount ?? '', num: true, cell: (r) => money(r.amountAgorot), sortBy: (r) => r.amountAgorot },
    { key: 'vat', head: t.repColFeeVat ?? '', num: true, cell: (r) => (r.vatAgorot ? money(r.vatAgorot) : '—') },
    { key: 'total', head: t.repColFeeTotal ?? '', num: true, cell: (r) => `<strong>${money(r.totalAgorot)}</strong>`, sortBy: (r) => r.totalAgorot },
  ];

  const byReport = { sales, products, stock, fees };
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
    // `.sort-btn` + `.sort-icon` — the products table's own header control, not a second one.
    // Everything about it already exists in dashboard.css: the chevron sits at 20% opacity on
    // every sortable column (so a seller can SEE which columns sort before clicking one), goes to
    // full opacity when active, and rotates 180° for descending. The first version of this table
    // drew ▲/▼ text glyphs that appeared only once a column was active — which invented a
    // vocabulary AND hid which columns were sortable.
    // `aria-sort` carries the same fact for a screen reader, so the state is never icon-only.
    const ariaSort = on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none';
    // The accessible name is "מיין לפי <column>" — the same one the products table's sort buttons
    // carry, and it is the hover tooltip too. `t.sortByLabel` is written inline in the attribute
    // rather than through a local: tests/icon-tooltips.test.ts reads the `<button …>` tag out of the
    // SOURCE and requires that key by name, which is what makes the rule enforceable at all. It
    // caught this button with no label, then again with the label built one line above.
    // The whole tag on one template literal for the same reason — a tag split across `+` is a tag
    // that scan cannot see.
    const dir = sortDir === 1 ? 'asc' : 'desc';
    return `<th scope="col"${cls} aria-sort="${ariaSort}"><button type="button" class="sort-btn" data-sort="${esc(c.key)}" data-active="${on}" data-dir="${dir}" aria-label="${esc(`${t.sortByLabel ?? 'Sort by'} ${c.head}`)}"><span class="sort-btn__label">${esc(c.head)}</span>${SORT_CHEVRON}</button></th>`;
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

/** Fee kind → the translation key that names it. A map rather than a chain, so a kind added to
 *  `FeeKind` without a word here is a missing key rather than a silently blank cell. */
const FEE_KIND_KEY: Record<FeeRow['kind'], string> = {
  commission: 'repFeeKindCommission',
  clearing: 'repFeeKindClearing',
  subscription: 'repFeeKindSubscription',
};

function summaryText(report: ReportId, totals: Record<string, number>, t: Record<string, string>): string {
  const n = (key: string): number => totals[key] ?? 0;
  if (report === 'fees') {
    return [
      `${t.repSumFeesNet ?? ''} ${money(n('netAgorot'))}`,
      `${t.repSumFeesVat ?? ''} ${money(n('vatAgorot'))}`,
      `${t.repSumFeesTotal ?? ''} ${money(n('totalAgorot'))}`,
      `${t.repFeeKindCommission ?? ''} ${money(n('commissionAgorot'))}`,
      `${t.repFeeKindClearing ?? ''} ${money(n('clearingAgorot'))}`,
      n('subscriptionAgorot') ? `${t.repFeeKindSubscription ?? ''} ${money(n('subscriptionAgorot'))}` : '',
    ].filter(Boolean).join(' · ');
  }
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
  const picker = document.getElementById('reports-range-picker') as HTMLElement | null;
  const rangeTrigger = document.getElementById('reports-range-trigger') as HTMLElement | null;
  const rangeLabel = document.getElementById('reports-range-label') as HTMLElement | null;
  const rangePortal = createFloatingPortal('reports-range-portal');
  const t = i18n();

  // The selection whose rows are actually ON SCREEN, as opposed to the one just chosen — including
  // the trigger's LABEL, which is the whole point. A failed load puts all of it back, so the
  // control can never name a window the table below it is not showing. Restoring the dates without
  // the label is what makes last month's revenue read as this month's (performance.ts learned it
  // first, and this control has a label precisely because it is a dropdown now).
  let shown = { report: 'sales' as ReportId, preset: 'thisMonth', from: '', to: '', label: '' };
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

  /** The window the table is showing. Both hidden fields are written by the picker below, whether
   *  the seller chose a preset or typed two dates, so there is exactly one place to read it from. */
  function currentRange(): { from: string; to: string } {
    const from = fromInput?.value ?? '';
    const to = toInput?.value ?? '';
    if (from && to && from <= to) return { from, to };
    return periodRange(picker?.dataset.preset ?? 'thisMonth');
  }

  function setRange(from: string, to: string, preset: string, labelText: string): void {
    if (fromInput) fromInput.value = from;
    if (toInput) toInput.value = to;
    if (picker) {
      if (preset) picker.dataset.preset = preset;
      else delete picker.dataset.preset;
    }
    if (rangeLabel) rangeLabel.textContent = labelText;
  }

  function applyPreset(preset: PeriodPreset): void {
    const { from, to } = periodRange(preset);
    setRange(from, to, preset, t[PERIOD_PRESET_LABEL_KEY[preset]] ?? preset);
    rangePortal.close();
    void load();
  }

  /** An arbitrary window. Refuses an incomplete or backwards pair rather than sending it: the
   *  endpoint answers `from > to` with a 400 the seller can do nothing with, and a half-typed year
   *  is not a range anybody asked for. The menu stays open so the fix is one more click. */
  function applyCustom(from: string, to: string): void {
    if (!from || !to || from > to) return;
    // The label becomes the dates themselves, and no preset stays marked — a lit "this month"
    // above a table covering a different fortnight is the same lie as a stale range label
    // (performance.ts's `restoreShownRange` note).
    setRange(from, to, '', `${shortDate(from)}–${shortDate(to)}`);
    rangePortal.close();
    void load();
  }

  function rangeMenuHtml(): string {
    const active = picker?.dataset.preset ?? '';
    const item = (p: PeriodPreset): string =>
      `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-preset="${p}" style="${p === active ? 'font-weight:700;color:var(--color-primary)' : ''}">${esc(t[PERIOD_PRESET_LABEL_KEY[p]] ?? p)}</button>`;
    // Both fields AND Apply on ONE line, and the whole menu tall enough not to scroll — both
    // learned by the performance picker, whose Apply button fell below the portal's 320px cap.
    // `dir="ltr"` belongs on each DATE FIELD, never on the row that holds them. A date is an LTR
    // run and its segments need it; the row is a Hebrew reading order, and the attribute on the
    // row flipped the whole thing — so "החל" sat on the RIGHT, at the START of an RTL row, before
    // the fields it applies to. On an RTL page the action belongs at the END, which is the left.
    // (Reported on the reports picker 2026-08-10. The advertising picker had it right all along
    // and is what both of these now match. Same trap as price-html.ts's badge: a direction set on
    // a container resolves that container's own inline axis too.)
    return `${PERIOD_PRESETS.map(item).join('')}
      <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>
      <div class="px-3 pt-1.5 pb-2">
        <div class="text-[.72rem] [color:var(--color-muted)] mb-1.5">${esc(t.perfPresetCustom ?? '')}</div>
        <div class="flex items-center gap-1.5">
          <input type="date" dir="ltr" data-range-from value="${esc(fromInput?.value ?? '')}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
          <span class="muted text-[0.8rem] shrink-0">–</span>
          <input type="date" dir="ltr" data-range-to value="${esc(toInput?.value ?? '')}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
          <button type="button" class="btn btn--sm btn--ghost shrink-0" data-range-apply>${esc(t.perfApply ?? '')}</button>
        </div>
      </div>`;
  }

  rangeTrigger?.addEventListener('click', () => {
    if (rangePortal.currentTrigger() === rangeTrigger) { rangePortal.close(); return; }
    rangePortal.open(rangeTrigger, '19rem', rangeMenuHtml, (portal) => {
      portal.style.maxHeight = 'min(80vh, 30rem)';
      portal.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => applyPreset((btn.dataset.preset as PeriodPreset) ?? 'thisMonth'));
      });
      portal.querySelector('[data-range-apply]')?.addEventListener('click', () => {
        applyCustom(
          portal.querySelector<HTMLInputElement>('[data-range-from]')?.value ?? '',
          portal.querySelector<HTMLInputElement>('[data-range-to]')?.value ?? '',
        );
      });
    });
  });

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
    // A stocktake has no period. Hidden rather than disabled: a dead control is a question the
    // seller cannot answer and should not have been asked.
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
      setRange(shown.from, shown.to, shown.preset, shown.label);
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

    // **A new REPORT resets the sort; a new PERIOD keeps it.** Those are different questions and
    // the first version got it wrong by resetting on both. Changing the report changes the columns
    // outright — the key would name a column that no longer exists — and the server's own ordering
    // (biggest earner first, most urgent stock first) is the right default for a table nobody has
    // expressed a preference about yet. Changing the period asks the SAME question of a different
    // month: a seller who sorted by payout to find the big orders and then stepped back a month is
    // still looking for the big orders, and re-sorting by hand every time is the friction every
    // other table on this site avoids.
    lastRows = payload.rows;
    if (report !== shown.report) { sortKey = ''; sortDir = 1; }
    if (wrap) {
      wrap.innerHTML = tableHtml(report, lastRows, t, sortKey, sortDir);
      wrap.removeAttribute('aria-busy');
      everRendered = true;
    }
    if (summaryEl) {
      // The fee ledger's processor half comes off a network and can be short or missing. Appended
      // to the summary rather than dropped: a total that is quietly incomplete is the one number on
      // this tab a seller would reconcile his books against and never question.
      const gap = report === 'fees' && payload.processor === 'partial' ? t.repFeesPartial
        : report === 'fees' && payload.processor === 'unavailable' ? t.repFeesNoProcessor
        : '';
      summaryEl.textContent = [summaryText(report, payload.totals ?? {}, t), gap].filter(Boolean).join(' · ');
    }
    if (exportLink) {
      exportLink.href = query('csv');
      // Nothing to export is not an error, but a download of a header row and no rows is a file
      // the seller has to open to discover is empty.
      if (payload.rows.length === 0) exportLink.setAttribute('aria-disabled', 'true');
      else exportLink.removeAttribute('aria-disabled');
    }
    shown = {
      report,
      preset: picker?.dataset.preset ?? '',
      from: fromInput?.value ?? '',
      to: toInput?.value ?? '',
      label: rangeLabel?.textContent ?? '',
    };
  }

  root.addEventListener('click', (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>('.report-pick');
    if (pick && pick.dataset.report !== root.dataset.report) {
      root.dataset.report = pick.dataset.report ?? 'sales';
      void load();
    }
  });

  // Sort: same column toggles direction, a new column starts ascending. No fetch — see sortRows.
  wrap?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.sort-btn');
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

  // Seeded from what the server rendered, so a failure on the FIRST load restores a real label
  // rather than blanking the trigger.
  shown = {
    report: 'sales',
    preset: picker?.dataset.preset ?? 'thisMonth',
    from: '',
    to: '',
    label: rangeLabel?.textContent ?? '',
  };
  void load();
}
