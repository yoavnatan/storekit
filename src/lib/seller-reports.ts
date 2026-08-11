/**
 * The seller's three exportable reports, built from data the caller already holds.
 *
 * **What a report is, and why it is not the Performance tab.** Performance answers "how am I
 * doing" — figures and charts, read at a glance and never printed. A report answers "give me the
 * rows": the sheet a bookkeeper reconciles a month against, the list a stock count is done from.
 * Different question, different shape, so they are not one screen with an export button bolted on.
 *
 * **Pure on purpose.** Every function here takes its orders and products as parameters and returns
 * plain rows — the `admin-stats.ts` half of the split in `order-reporting.ts`'s header, not the
 * `GROUP BY` half. That is what lets the invariants below be asserted without a database, and the
 * invariants are the point of the module: three reports over the same orders that disagree about a
 * month's takings are worse than no reports, because the disagreement is discovered by an
 * accountant rather than by us.
 *
 * **The rules the rows obey, none of them re-implemented here:**
 *  • what counts as revenue — `orders.ts#countsAsRevenue`. NEVER `paymentStatus === 'paid'`, which
 *    still matches a cancelled order. Rows for orders that do not count are still LISTED (a seller
 *    reconciling a month needs to see the cancellation, not a gap where it was) and carry
 *    `countsAsRevenue: false`; the totals only ever add the ones that do.
 *  • this store's net for an order — `admin-stats.ts#orderNetForStore`, floored at zero.
 *  • which calendar day an order belongs to — `business-day.ts`. A report that says "August" to a
 *    seller in Israel is not asking the question `toISOString()` answers.
 *  • commission — `pricing.ts#commissionOnAgorot`, at the rate the SELLER'S OWN tier gives, which
 *    the caller passes in. The Performance tab's expense line uses the same function.
 *  • splitting one order-level discount across several product lines — `money.ts#allocateAgorot`,
 *    which is why the product report's revenue column sums to the sales report's, exactly.
 */
import type { Order, OrderItem } from './orders.js';
import { countsAsRevenue } from './orders.js';
import { orderNetForStore } from './admin-stats.js';
import { allocateAgorot, toAgorot } from './money.js';
import { commissionOnAgorot } from './pricing.js';
import { businessDayISO } from './business-day.js';
import type { StoreProduct } from './store-products.js';
// Ids and row shapes live in their own leaf module so the reports TAB can import them without
// dragging `orders.ts` → `db.ts` into the browser bundle — its header carries the reasoning.
// Re-exported here so a server caller has one import for the whole feature.
import type { SalesRow, ReportTotals, ProductSalesRow, StockRow, PayoutRow, PayoutReportTotals } from './seller-report-shapes.js';
import { LOW_STOCK_AT } from './seller-report-shapes.js';
export type { ReportId, SalesRow, ProductSalesRow, StockRow, PayoutRow } from './seller-report-shapes.js';
export { isReportId, LOW_STOCK_AT, ACCOUNT_WIDE_REPORTS } from './seller-report-shapes.js';

/* ── 1. Sales, one row per order ─────────────────────────────────────────────────────────── */

const EMPTY_TOTALS: ReportTotals = {
  rows: 0, grossAgorot: 0, discountAgorot: 0, netAgorot: 0,
  shippingAgorot: 0, commissionAgorot: 0, payoutAgorot: 0,
};

/** Orders this store appears in, inside `[fromISO, toISO]` inclusive, newest first. */
function ordersInRange(orders: readonly Order[], storeSlug: string, fromISO: string, toISO: string): Order[] {
  return orders
    .filter((o) => o.storeSubtotals?.[storeSlug] !== undefined)
    .filter((o) => {
      const day = businessDayISO(new Date(o.createdAt));
      return day >= fromISO && day <= toISO;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function itemsFor(order: Order, storeSlug: string): OrderItem[] {
  return order.items.filter((i) => i.storeSlug === storeSlug);
}

export function buildSalesReport(
  orders: readonly Order[],
  storeSlug: string,
  fromISO: string,
  toISO: string,
  commissionPercent: number,
): { rows: SalesRow[]; totals: ReportTotals } {
  const rows = ordersInRange(orders, storeSlug, fromISO, toISO).map<SalesRow>((o) => {
    const sub = o.storeSubtotals[storeSlug];
    const net = orderNetForStore(o, storeSlug);
    const counts = countsAsRevenue(o);
    // `commissionOnAgorot` and never a local percentage: the Performance tab's expense line is
    // built from that same function, and two surfaces rounding a commission their own way is how
    // a seller ends up with two different answers to what the platform charged them.
    // Zero on a sale that does not count as revenue — a cancelled order costs the seller nothing,
    // and a report that billed for one would be the first believable reason to distrust the tab.
    const commission = counts ? commissionOnAgorot(net, commissionPercent) : 0;
    return {
      orderId: o.id,
      dayISO: businessDayISO(new Date(o.createdAt)),
      buyerName: o.buyerName,
      city: o.buyerAddress?.city ?? '',
      items: itemsFor(o, storeSlug).reduce((n, i) => n + i.qty, 0),
      grossAgorot: sub.subtotalAgorot,
      discountAgorot: sub.discount?.appliedAgorot ?? 0,
      couponCode: sub.couponCode ?? '',
      netAgorot: net,
      shippingAgorot: sub.shippingAgorot,
      commissionAgorot: commission,
      payoutAgorot: net - commission,
      paymentStatus: o.paymentStatus,
      shippingStatus: o.shippingStatus,
      countsAsRevenue: counts,
    };
  });

  const totals = rows.reduce<ReportTotals>((acc, r) => {
    if (!r.countsAsRevenue) return { ...acc, rows: acc.rows + 1 };
    return {
      rows: acc.rows + 1,
      grossAgorot: acc.grossAgorot + r.grossAgorot,
      discountAgorot: acc.discountAgorot + r.discountAgorot,
      netAgorot: acc.netAgorot + r.netAgorot,
      shippingAgorot: acc.shippingAgorot + r.shippingAgorot,
      commissionAgorot: acc.commissionAgorot + r.commissionAgorot,
      payoutAgorot: acc.payoutAgorot + r.payoutAgorot,
    };
  }, EMPTY_TOTALS);

  return { rows, totals };
}

/* ── 2. Products, one row per product sold ───────────────────────────────────────────────── */

/**
 * Units and revenue per product, over the same window and the same revenue rule as the sales
 * report — cancelled orders contribute nothing here either.
 *
 * **The discount column is an ALLOCATION and it has to be said out loud.** A discount (or a
 * coupon) is written against the ORDER, not against a line, so "what did this product earn" has no
 * answer in the data. Leaving discounts out entirely was the alternative and it is worse: the
 * product report would then overstate every discounted day, and would not add up to the sales
 * report an accountant is holding beside it. So the discount is split across the order's lines
 * pro-rata by line gross, in whole agorot, by `allocateAgorot` — which guarantees the parts sum to
 * the order's discount exactly, and therefore that `sum(netAgorot)` here equals the sales report's
 * `totals.netAgorot` to the agora. That equality is asserted, not hoped for.
 */
export function buildProductSalesReport(
  orders: readonly Order[],
  products: readonly StoreProduct[],
  storeSlug: string,
  fromISO: string,
  toISO: string,
): { rows: ProductSalesRow[]; totals: { units: number; grossAgorot: number; discountAgorot: number; netAgorot: number } } {
  const stockById = new Map(products.map((p) => [p.id, p.stock]));
  const skuById = new Map(products.map((p) => [p.id, p.sku ?? '']));
  const acc = new Map<string, ProductSalesRow>();

  for (const order of ordersInRange(orders, storeSlug, fromISO, toISO)) {
    if (!countsAsRevenue(order)) continue;
    const lines = itemsFor(order, storeSlug);
    const gross = lines.map((i) => i.priceAgorot * i.qty);
    const shares = allocateAgorot(order.storeSubtotals[storeSlug].discount?.appliedAgorot ?? 0, gross);

    lines.forEach((item, idx) => {
      const row = acc.get(item.productId) ?? {
        productId: item.productId,
        // The name AS SOLD, not today's — a receipt does not change when a product is renamed.
        name: item.productName,
        sku: skuById.get(item.productId) ?? '',
        units: 0,
        grossAgorot: 0,
        discountAgorot: 0,
        netAgorot: 0,
        stock: stockById.get(item.productId) ?? null,
      };
      row.units += item.qty;
      row.grossAgorot += gross[idx];
      row.discountAgorot += shares[idx];
      // Floored per line for the same reason `orderNetForStore` floors: a stored row whose
      // discount exceeds its subtotal must report as zero, never as negative money.
      row.netAgorot = Math.max(0, row.grossAgorot - row.discountAgorot);
      acc.set(item.productId, row);
    });
  }

  const rows = [...acc.values()].sort((a, b) => b.netAgorot - a.netAgorot || a.name.localeCompare(b.name));
  const totals = rows.reduce(
    (t, r) => ({
      units: t.units + r.units,
      grossAgorot: t.grossAgorot + r.grossAgorot,
      discountAgorot: t.discountAgorot + r.discountAgorot,
      netAgorot: t.netAgorot + r.netAgorot,
    }),
    { units: 0, grossAgorot: 0, discountAgorot: 0, netAgorot: 0 },
  );
  return { rows, totals };
}

/* ── 3. Stock, one row per product ───────────────────────────────────────────────────────── */

/** A stock count sheet: the whole live catalogue, no date range — a stocktake is about now.
 *  Ordered by how much it needs attention (out, then low, then the rest), because that is the
 *  order the seller acts in; alphabetical would bury the two products that are gone. */
export function buildStockReport(products: readonly StoreProduct[]): {
  rows: StockRow[];
  totals: { products: number; units: number; valueAgorot: number; out: number; low: number };
} {
  const rank = { out: 0, low: 1, ok: 2 } as const;
  const rows = products
    .map<StockRow>((p) => ({
      productId: p.id,
      name: p.name,
      sku: p.sku ?? '',
      stock: p.stock,
      price: p.price,
      // `toAgorot` and not a local ×100: the EPSILON nudge is what keeps a price the seller
      // typed as 19.99 from valuing the shelf an agora light per unit.
      valueAgorot: toAgorot(p.price) * p.stock,
      state: p.stock <= 0 ? 'out' : p.stock <= LOW_STOCK_AT ? 'low' : 'ok',
    }))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.stock - b.stock || a.name.localeCompare(b.name));

  return {
    rows,
    totals: {
      products: rows.length,
      units: rows.reduce((n, r) => n + r.stock, 0),
      valueAgorot: rows.reduce((n, r) => n + r.valueAgorot, 0),
      out: rows.filter((r) => r.state === 'out').length,
      low: rows.filter((r) => r.state === 'low').length,
    },
  };
}

/* ── 4. Platform payments, one row per transfer ──────────────────────────────────────────── */

/** A payout as this builder needs it — a projection of `payouts.ts#SellerPayout`, so a test can
 *  assert the whole report from three literals and this module still imports no database. */
export interface PayoutInput {
  periodKey: string;
  amountAgorot: number;
  commissionAgorot: number;
  status: 'pending' | 'sent' | 'paid' | 'failed';
  /** ISO timestamps, as `payouts.ts` returns them. */
  createdAt: string;
  sentAt: string | null;
}

/**
 * Every transfer that reached this seller inside `[fromISO, toISO]`, newest first (owner, סשן א׳ §6).
 *
 * **Which date the window is applied to, and why it is not `createdAt`.** A payout row is created by
 * the monthly run and stamped `sent_at` when the transfer actually leaves; those can fall on
 * different days and, at a month boundary, in different months. A seller reconciling March against a
 * bank statement is asking about the day the money MOVED, so `sentAt` wins where it exists and
 * `createdAt` is the fallback for a row that has not been sent yet. The row prints the date it was
 * filtered on, so the window and the column can never describe different things.
 *
 * `businessDayISO` and never `toISOString().slice(0,10)` — a transfer at 01:30 Israel time on the
 * 1st is a UTC 30th, and a report that puts it in the wrong month is the whole reason
 * `business-day.ts` exists.
 *
 * **A `failed` transfer is listed and excluded from the totals.** It is money that came back
 * (`seller-account.ts` excludes it from `paidOut` for the same reason), and a seller who sees a gap
 * where a bounced transfer was has no way to ask about it. Same stance the sales report takes with a
 * cancelled order, deliberately.
 */
export function buildPayoutsReport(
  payouts: readonly PayoutInput[],
  fromISO: string,
  toISO: string,
): { rows: PayoutRow[]; totals: PayoutReportTotals } {
  const rows = payouts
    .map<PayoutRow>((p) => ({
      dayISO: businessDayISO(new Date(p.sentAt ?? p.createdAt)),
      periodKey: p.periodKey,
      amountAgorot: p.amountAgorot,
      commissionAgorot: p.commissionAgorot,
      status: p.status,
      countsAsPaid: p.status !== 'failed',
    }))
    .filter((r) => r.dayISO >= fromISO && r.dayISO <= toISO)
    .sort((a, b) => (a.dayISO < b.dayISO ? 1 : a.dayISO > b.dayISO ? -1 : 0));

  const totals = rows.reduce<PayoutReportTotals>(
    (t, r) => (r.countsAsPaid
      ? { rows: t.rows + 1, amountAgorot: t.amountAgorot + r.amountAgorot, commissionAgorot: t.commissionAgorot + r.commissionAgorot }
      : t),
    { rows: 0, amountAgorot: 0, commissionAgorot: 0 },
  );
  return { rows, totals };
}
