/**
 * The reports' vocabulary — ids and row shapes — with NOTHING that touches a database.
 *
 * **Why this is a separate file from `seller-reports.ts`.** The builders there import
 * `orders.ts` and `admin-stats.ts`, which reach `db.ts`, which opens a connection pool at module
 * scope. The reports TAB (`scripts/dashboard/reports.ts`) runs in the browser and needs the row
 * shapes to render a table and `isReportId` to validate what it read off a `data-` attribute — so
 * importing them from the builders would bundle Postgres into the seller dashboard. Module-scope
 * side effects mean tree-shaking cannot be relied on to save us, and this is the same split
 * `csv-bulk.ts`'s header already records making for the same reason.
 *
 * `Order` appears below only in `import type` position, so it is erased at build and brings
 * nothing with it.
 */
import type { Order } from './orders.js';

export type ReportId = 'sales' | 'products' | 'stock' | 'fees';
export const REPORT_IDS: readonly ReportId[] = ['sales', 'products', 'stock', 'fees'];

/**
 * Reports that are about the ACCOUNT rather than about the store in the switcher.
 *
 * It was empty between 2026-08-21 and 2026-08-26 — the old `payouts` report listed transfers this
 * platform made, and under the split model it makes none.
 *
 * **`fees` put it back, and it belongs here because two of its three sources are account-level.**
 * A seller has ONE clearing account and ONE standing order however many shops he runs
 * (`store-plan.ts`), so his clearing fees and his monthly charge are not a fact about the shop in
 * the switcher. Only the sale commission is per-shop, and scoping the whole report to one shop to
 * accommodate that column would produce a fee total that is missing rows — which on a document a
 * bookkeeper reconciles against is worse than no document.
 */
export const ACCOUNT_WIDE_REPORTS: readonly ReportId[] = ['fees'];

export function isReportId(v: string | null | undefined): v is ReportId {
  return REPORT_IDS.includes(v as ReportId);
}

/** At or below this, a product is worth restocking before it sells out. Matches the seller
 *  dashboard's own low-stock badge, so the report and the tab strip never disagree about which
 *  products are the problem. */
export const LOW_STOCK_AT = 3;

export interface SalesRow {
  orderId: string;
  /** Business-day ISO (`YYYY-MM-DD`) — what the seller means by "the 3rd". */
  dayISO: string;
  buyerName: string;
  city: string;
  items: number;
  /** This store's slice, before its discount. */
  grossAgorot: number;
  discountAgorot: number;
  couponCode: string;
  /** gross − discount, floored at zero. The figure commission is taken on. */
  netAgorot: number;
  shippingAgorot: number;
  commissionAgorot: number;
  /** net − commission. What the sale is worth to the seller, shipping excluded. */
  payoutAgorot: number;
  paymentStatus: Order['paymentStatus'];
  shippingStatus: Order['shippingStatus'];
  countsAsRevenue: boolean;
}

export interface ReportTotals {
  rows: number;
  grossAgorot: number;
  discountAgorot: number;
  netAgorot: number;
  shippingAgorot: number;
  commissionAgorot: number;
  payoutAgorot: number;
}

export interface ProductSalesRow {
  productId: string;
  name: string;
  sku: string;
  units: number;
  grossAgorot: number;
  /** This product's share of the order-level discounts it appeared in — `buildProductSalesReport`
   *  explains why that is an allocation and what guarantees it still adds up. */
  discountAgorot: number;
  netAgorot: number;
  /** Live stock, so "sold 40, 2 left" is one row rather than two reports. Null when the product no
   *  longer exists: a sold line is a snapshot and outlives the product it points at. */
  stock: number | null;
}


export interface StockRow {
  productId: string;
  name: string;
  sku: string;
  stock: number;
  /** ILS, as the seller typed it. */
  price: number;
  /** stock × price, in agorot. */
  valueAgorot: number;
  state: 'out' | 'low' | 'ok';
}


/* ── The fee ledger (owner, סשן א׳ §1, 2026-08-26) ──────────────────────────────────────────
 *
 * *"העמלות על המכירות לא צריכות להופיע שם, אלא בלשונית דוח״ות, כדו״ח עמלות. כולל כל העמלות
 * שהיוזר משלם. עמלת סליקה, עמלת מכירה, וכו׳."*
 *
 * The Payments tab used to carry a card listing the last six charges with their fee split. It is
 * the right information in the wrong place twice over: that tab answers *"how much money is coming
 * to me"*, and six rows is a sample rather than a record. A fee is an EXPENSE, and an expense
 * belongs in the thing a bookkeeper exports — a period, every row in it, and a CSV.
 *
 * ── One row per fee, never one row per sale ──
 * A sale can carry two fees charged by two different parties, and rolling them into one "fees"
 * column is the exact mistake `payChargeClearing`/`payChargeCommission` were split to avoid: a
 * seller shown a single deduction concludes the platform took all of it. So `payee` is a column of
 * the data and not a footnote.
 */
export type FeeKind = 'commission' | 'clearing' | 'subscription';

export interface FeeRow {
  /** Business-day ISO. For a processor fee it is PayMe's own calendar day, sliced never parsed
   *  (`seller-transfers.ts#paymeDay`). */
  dayISO: string;
  kind: FeeKind;
  /** What it was taken on — an order id, PayMe's sale id, or the month of a subscription charge. */
  reference: string;
  /** The amount the fee was calculated FROM, agorot. Zero for a fee that is not a cut of anything
   *  (the monthly subscription), which the table renders as a dash rather than as ₪0. */
  baseAgorot: number;
  /**
   * The fee itself, agorot, **before VAT** — the first of the three columns every row carries.
   *
   * ── The shape is a tax invoice's, and that was the owner's instruction ──
   * *"ובדוחו״ת צריך להיות שקופים, לא יודע איך זה נהוג עם מע״מ או בלי, מה שנהוג. באופן אחיד"*
   * (2026-08-26). The Israeli convention for a business document is סכום · מע״מ · סה״כ, so that is
   * what this is — and *uniformly*, which is the harder half: our fees arrive quoted before VAT and
   * the processor's arrive reported after it, so one of the two has to be converted. The
   * processor's is, by extraction (`vat.ts#vatWithinAgorot`), because extraction from their gross
   * is exact and cannot disagree with the figure on his statement.
   */
  amountAgorot: number;
  /** The VAT on `amountAgorot`. Zero only for a fee that genuinely carries none. */
  vatAgorot: number;
  /** `amountAgorot + vatAgorot`, always — what actually left his account. Stored rather than
   *  re-added at every renderer so the row a spreadsheet sums and the row a screen prints are the
   *  same three numbers. */
  totalAgorot: number;
  /** Who charges it. Two parties, and the seller must be able to tell them apart. */
  payee: 'platform' | 'processor';
}

export interface FeeTotals {
  rows: number;
  /** Each kind's own subtotal, BEFORE VAT — the same convention as the rows. */
  commissionAgorot: number;
  clearingAgorot: number;
  subscriptionAgorot: number;
  /** Everything before VAT, the VAT on it, and the sum of the two. Three figures rather than one,
   *  because that is what a seller copies into his books. */
  netAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
}
