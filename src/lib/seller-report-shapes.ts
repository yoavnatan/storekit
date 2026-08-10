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

export type ReportId = 'sales' | 'products' | 'stock';
export const REPORT_IDS: readonly ReportId[] = ['sales', 'products', 'stock'];

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
