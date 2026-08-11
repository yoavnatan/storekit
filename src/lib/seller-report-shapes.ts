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

export type ReportId = 'sales' | 'products' | 'stock' | 'payouts';
export const REPORT_IDS: readonly ReportId[] = ['sales', 'products', 'stock', 'payouts'];

/**
 * ⚠️ `payouts` is the ONE report on this tab that is not about the store in the switcher.
 *
 * A payout is one bank transfer per seller ACCOUNT — one ח״פ, one bank account, however many stores
 * (`pricing.ts`, `seller-account.ts`) — so it cannot be split by shop, and a per-store column here
 * would be a number no transfer ever matches. It is labelled "מכל החנויות" in its own description
 * rather than footnoted, the same way the Payments tab labels its two account-wide tiles.
 *
 * The route still takes a `storeSlug` for it, and that is authorization and not scope: the slug
 * proves the session owns a store, and the payouts are then read for the SESSION's seller id. See
 * `/api/seller/reports`.
 */
export const ACCOUNT_WIDE_REPORTS: readonly ReportId[] = ['payouts'];

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

/**
 * One transfer the platform made to this seller — the accounting report (owner, סשן א׳ §6).
 *
 * *"שולם בעבר — נראה לי מידע מיותר בתשלומים, זה אמור להיות בדו״חות… מידע שהוא מרגיש יותר חשבונאי…
 * דו״ח יותר חשבונאי שכולל גם תשלומים מהפלטפורמה. לפי תקופה שהוא בוחר."* The Payments tab lost its
 * lifetime "שולם בעבר" tile and its history table to this: a figure with no period and no export is
 * one nobody can reconcile a month against.
 *
 * **`commissionAgorot` is the INCREMENT this transfer settled, never a lifetime total** — the
 * column's own comment in migration 0023 says why, and getting it wrong bills the same commission
 * twice. It is here because it is the other half of what the seller needs for their books: what
 * arrived, and what was taken before it did.
 */
export interface PayoutRow {
  /** Business-day ISO of the transfer — `sentAt` when it went out, `createdAt` while it is still
   *  pending. Null for neither: a row always has a created date. */
  dayISO: string;
  /** 'YYYY-MM' on the business calendar — the month the money was earned in, which is NOT the month
   *  it was transferred in and is the pairing a bookkeeper reconciles against. */
  periodKey: string;
  amountAgorot: number;
  commissionAgorot: number;
  status: 'pending' | 'sent' | 'paid' | 'failed';
  /** A bounced transfer is money that came back, so it is LISTED and excluded from the totals — the
   *  same stance the sales report takes with a cancelled order, and for the same reason: a month is
   *  reconciled against what happened, not against what stuck. */
  countsAsPaid: boolean;
}

export interface PayoutReportTotals {
  rows: number;
  amountAgorot: number;
  commissionAgorot: number;
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
