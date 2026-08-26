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
import { vatWithinAgorot } from './vat.js';
import { businessDayISO } from './business-day.js';
import type { StoreProduct } from './store-products.js';
// Ids and row shapes live in their own leaf module so the reports TAB can import them without
// dragging `orders.ts` → `db.ts` into the browser bundle — its header carries the reasoning.
// Re-exported here so a server caller has one import for the whole feature.
import type { SalesRow, ReportTotals, ProductSalesRow, StockRow, FeeRow, FeeTotals } from './seller-report-shapes.js';
import { LOW_STOCK_AT } from './seller-report-shapes.js';
export type { ReportId, SalesRow, ProductSalesRow, StockRow, FeeRow, FeeTotals, FeeKind } from './seller-report-shapes.js';
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




/* ── 4. Fees, one row per fee ─────────────────────────────────────────────────────────────── */

/**
 * Every fee this seller was charged in the window, from whichever party charged it.
 *
 * ── Why the commission half is derived and the clearing half is read ──
 * Our commission is a rule we own: a percentage of a figure we computed, and
 * `commissionOnAgorot` is the one definition of it — the same call the sales report and the
 * Performance tab's expense line make, so the fee report cannot disagree with either about what a
 * month cost. The clearing fee is PayMe's, is not derivable from anything here, and arrives as a
 * measured amount per charge (`PaymeTransaction.processingAgorot`); it is passed IN so this module
 * stays pure and so a processor being unreachable degrades to a report with one source missing and
 * a sentence saying so, rather than to no report.
 *
 * ── Account-wide, and the orders arrive that way ──
 * `orders` is every order across every shop this seller owns, and `rateFor` gives the commission
 * percent of the SHOP each order slice belongs to — a seller can run two shops on two plans, and a
 * single blended rate would misstate both. `ACCOUNT_WIDE_REPORTS` carries why the report is not
 * scoped to the shop in the switcher.
 *
 * ── Three columns per row, in the shape of a tax invoice (owner, 2026-08-26) ──
 * *"בדוחו״ת צריך להיות שקופים… מה שנהוג. באופן אחיד."* The Israeli convention for a business
 * document is סכום · מע״מ · סה״כ, and the word that does the work is *uniformly*: our fees are
 * quoted before VAT (`pricing.ts`) and charged with it, while the processor reports figures that
 * already contain it. Both are normalised to the same three columns here — ours by ADDING the tax
 * we charge, the processor's by EXTRACTING the tax already inside theirs — so the sheet sums to a
 * number that means one thing.
 *
 * ── A cancelled order costs nothing, here as everywhere ──
 * `countsAsRevenue` is the gate, never `paymentStatus === 'paid'`. A refunded sale that still
 * showed a commission row would be us billing for a sale that did not happen, on the document a
 * seller checks us against.
 */
/** A charged amount, as the three columns a business document carries.
 *
 *  Extraction rather than addition, always: every amount that reaches this function is a GROSS —
 *  what was really deducted or debited — and `vatWithinAgorot` is spelled so that net + vat is the
 *  gross exactly. Grossing a net up instead would let a row's three cells disagree by an agora. */
function split(grossAgorot: number): Pick<FeeRow, 'amountAgorot' | 'vatAgorot' | 'totalAgorot'> {
  const vatAgorot = vatWithinAgorot(grossAgorot);
  return { amountAgorot: grossAgorot - vatAgorot, vatAgorot, totalAgorot: grossAgorot };
}

export function buildFeesReport(input: {
  orders: readonly Order[];
  /** Slug → commission percent, for every shop this seller owns. */
  rateFor: ReadonlyMap<string, number>;
  fromISO: string;
  toISO: string;
  /** The processor's own per-charge fees, already narrowed to the window by the caller — it is the
   *  only part of this that came off a network. Empty is a real answer and not an error. */
  clearing?: readonly { dayISO: string; reference: string; baseAgorot: number; feeAgorot: number }[];
  /** Monthly subscription charges we have a RECORD of — never a schedule we re-derived. Deriving
   *  "he has paid every month since March" from a standing order's start date would invent history
   *  on a money document; a month with no recorded charge is simply absent. */
  subscription?: readonly { dayISO: string; reference: string; amountAgorot: number }[];
}): { rows: FeeRow[]; totals: FeeTotals } {
  const { orders, rateFor, fromISO, toISO, clearing = [], subscription = [] } = input;

  const rows: FeeRow[] = [];

  for (const order of orders) {
    const day = businessDayISO(new Date(order.createdAt));
    if (day < fromISO || day > toISO) continue;
    if (!countsAsRevenue(order)) continue;
    for (const slug of Object.keys(order.storeSubtotals ?? {})) {
      const rate = rateFor.get(slug);
      if (rate === undefined) continue;  // a slice of another seller's shop in the same order
      const net = orderNetForStore(order, slug);
      // `rate` is the CHARGED percent — the plan's rate plus VAT — because that is what PayMe
      // really deducted. So the gross is what it produced, and the fee before tax is derived back
      // out of it by extraction: computing it from the quoted rate instead would give a net and a
      // gross that differ by a rounding, on a document whose whole job is that its columns add up.
      const gross = commissionOnAgorot(net, rate);
      if (gross <= 0) continue;
      rows.push({ dayISO: day, kind: 'commission', reference: order.id, baseAgorot: net, ...split(gross), payee: 'platform' });
    }
  }

  // The processor's figures already contain the tax (GO_LIVE §3.1.0 — their per-charge fees are
  // reported after VAT), so they are SPLIT, never grossed up a second time.
  for (const c of clearing) {
    rows.push({ dayISO: c.dayISO, kind: 'clearing', reference: c.reference, baseAgorot: c.baseAgorot, ...split(c.feeAgorot), payee: 'processor' });
  }
  // The standing order's price is the billed figure since 2026-08-26 (`store-plan.ts`), i.e. gross.
  for (const sub of subscription) {
    rows.push({ dayISO: sub.dayISO, kind: 'subscription', reference: sub.reference, baseAgorot: 0, ...split(sub.amountAgorot), payee: 'platform' });
  }

  // Newest first, and by kind within a day so the two fees on one sale sit together rather than
  // being separated by whatever order the two sources happened to arrive in.
  rows.sort((a, b) => (a.dayISO < b.dayISO ? 1 : a.dayISO > b.dayISO ? -1 : a.kind.localeCompare(b.kind)));

  const sum = (kind: FeeRow['kind']): number =>
    rows.reduce((n, r) => (r.kind === kind ? n + r.amountAgorot : n), 0);
  // Every total is summed from the ROWS and never re-derived from another total: `split` guarantees
  // net + vat === total per row, so summing the three columns keeps that property for the sheet.
  // Re-extracting the VAT from the grand total can differ from the sum of the extractions by an
  // agora — which on a document a bookkeeper adds up is a document that does not add up.
  const totals: FeeTotals = {
    rows: rows.length,
    commissionAgorot: sum('commission'),
    clearingAgorot: sum('clearing'),
    subscriptionAgorot: sum('subscription'),
    netAgorot: rows.reduce((n, r) => n + r.amountAgorot, 0),
    vatAgorot: rows.reduce((n, r) => n + r.vatAgorot, 0),
    totalAgorot: rows.reduce((n, r) => n + r.totalAgorot, 0),
  };
  return { rows, totals };
}
