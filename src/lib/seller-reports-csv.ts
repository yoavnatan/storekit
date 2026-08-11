/**
 * The three reports as a file Excel opens correctly.
 *
 * **Why CSV and not PDF** (owner's call, 2026-08-10): CSV is what a bookkeeper actually asks for —
 * it opens, it sorts, it pastes into their own sheet — and the machinery for producing one that
 * Excel reads in Hebrew already exists here (`csv-bulk.ts`). A PDF would need either a rendering
 * library (hundreds of KB and a second layout surface to maintain) or a print stylesheet, and
 * neither buys the seller anything a spreadsheet does not.
 *
 * Three details are load-bearing and all three are borrowed rather than reinvented:
 *  • `BOM` first, or Excel reads UTF-8 Hebrew as mojibake. This is the single reason the export is
 *    usable at all on a Windows machine, which is most of them.
 *  • `sanitizeCsvCell` on every cell holding text a PERSON typed. A product name or a buyer name
 *    beginning `=` is a formula to Excel, and a CSV export is the classic injection route into a
 *    spreadsheet. Numbers and enum values we generate are exempt because they cannot begin with one.
 *  • `\r\n` line endings, matching `productsToCsv` — the format Excel expects.
 *
 * Money is written as a plain decimal (`123.45`), never formatted with a ₪ or a thousands
 * separator: the point of the column is that it can be summed in the spreadsheet, and `1,234 ₪` is
 * text there.
 *
 * **The date stays ISO in the FILE while the screen shows DD/MM/YYYY, and that is deliberate.** A
 * spreadsheet parses `2026-08-03` as a real date on every machine and then renders it in the
 * reader's own locale — so on an Israeli Excel the bookkeeper sees 03/08/2026 anyway, and the
 * column still sorts and filters as a date. Writing `03/08/2026` into the file instead would be
 * read as March 8th by any machine set to a US locale, which is a wrong date with no error
 * anywhere. The unambiguous form travels; the readable form is the screen's job.
 */
import { BOM, toCsvCell, sanitizeCsvCell } from './csv-bulk.js';
import { fromAgorot } from './money.js';
import type { SalesRow, ProductSalesRow, StockRow, PayoutRow, ReportId } from './seller-reports.js';
import type { Lang } from '../i18n/translations.js';

/** Agorot → the decimal a spreadsheet can add up. Two places always, so a column of them lines up. */
const money = (agorot: number): string => fromAgorot(agorot).toFixed(2);

type Header = Record<Lang, string>;

const SALES_HEADERS: Header[] = [
  { he: 'תאריך', en: 'Date' },
  { he: 'מספר הזמנה', en: 'Order ID' },
  { he: 'לקוח', en: 'Customer' },
  { he: 'עיר', en: 'City' },
  { he: 'פריטים', en: 'Items' },
  { he: 'לפני הנחה', en: 'Before discount' },
  { he: 'הנחה', en: 'Discount' },
  { he: 'קוד קופון', en: 'Coupon code' },
  { he: 'סכום המכירה', en: 'Sale total' },
  { he: 'משלוח', en: 'Shipping' },
  { he: 'עמלת פלטפורמה', en: 'Platform commission' },
  { he: 'לתשלום למוכר', en: 'Seller payout' },
  { he: 'סטטוס תשלום', en: 'Payment status' },
  { he: 'סטטוס משלוח', en: 'Shipping status' },
  { he: 'נכלל בהכנסות', en: 'Counted as revenue' },
];

const PRODUCT_HEADERS: Header[] = [
  { he: 'מוצר', en: 'Product' },
  { he: 'מק"ט', en: 'SKU' },
  { he: 'יחידות', en: 'Units' },
  { he: 'לפני הנחה', en: 'Before discount' },
  { he: 'הנחה (יחסית)', en: 'Discount (allocated)' },
  { he: 'סכום המכירה', en: 'Sale total' },
  { he: 'מלאי נוכחי', en: 'Current stock' },
];

const STOCK_HEADERS: Header[] = [
  { he: 'מוצר', en: 'Product' },
  { he: 'מק"ט', en: 'SKU' },
  { he: 'מלאי', en: 'Stock' },
  { he: 'מחיר', en: 'Price' },
  { he: 'שווי מלאי', en: 'Stock value' },
  { he: 'מצב', en: 'State' },
];

const PAYOUT_HEADERS: Header[] = [
  { he: 'תאריך העברה', en: 'Transfer date' },
  { he: 'תקופה', en: 'Period' },
  { he: 'הועבר אליך', en: 'Transferred to you' },
  { he: 'עמלה שנגבתה', en: 'Commission taken' },
  { he: 'מצב', en: 'Status' },
];

const YES_NO: Record<Lang, [string, string]> = { he: ['כן', 'לא'], en: ['Yes', 'No'] };
/** The seller-facing name of each payout state. Spelled here rather than reused from the dashboard
 *  translation table because a CSV is a FILE — it is opened by a bookkeeper, in a spreadsheet, with
 *  no i18n runtime anywhere near it, and the same `Lang` shape every other header in this module
 *  uses is what makes that one lookup instead of a second mechanism. */
const PAYOUT_STATUS: Record<Lang, Record<PayoutRow['status'], string>> = {
  he: { pending: 'ממתין', sent: 'נשלח לבנק', paid: 'הועבר', failed: 'נכשל' },
  en: { pending: 'Pending', sent: 'Sent to the bank', paid: 'Transferred', failed: 'Failed' },
};
const STOCK_STATE: Record<Lang, Record<StockRow['state'], string>> = {
  he: { out: 'אזל', low: 'נמוך', ok: 'תקין' },
  en: { out: 'Out of stock', low: 'Low', ok: 'OK' },
};

function serialize(headers: Header[], rows: string[][], lang: Lang): string {
  const head = headers.map((h) => toCsvCell(h[lang])).join(',');
  const body = rows.map((r) => r.map((cell) => toCsvCell(sanitizeCsvCell(cell))).join(','));
  return BOM + [head, ...body].join('\r\n');
}

export function salesReportCsv(rows: readonly SalesRow[], lang: Lang): string {
  const [yes, no] = YES_NO[lang];
  return serialize(SALES_HEADERS, rows.map((r) => [
    r.dayISO, r.orderId, r.buyerName, r.city, String(r.items),
    money(r.grossAgorot), money(r.discountAgorot), r.couponCode, money(r.netAgorot),
    money(r.shippingAgorot), money(r.commissionAgorot), money(r.payoutAgorot),
    r.paymentStatus, r.shippingStatus, r.countsAsRevenue ? yes : no,
  ]), lang);
}

export function productSalesReportCsv(rows: readonly ProductSalesRow[], lang: Lang): string {
  return serialize(PRODUCT_HEADERS, rows.map((r) => [
    r.name, r.sku, String(r.units),
    money(r.grossAgorot), money(r.discountAgorot), money(r.netAgorot),
    // A product sold and since deleted has no live stock, and a blank cell says that; a 0 would
    // claim it is out of stock, which is a different thing and would send the seller restocking it.
    r.stock === null ? '' : String(r.stock),
  ]), lang);
}

export function stockReportCsv(rows: readonly StockRow[], lang: Lang): string {
  return serialize(STOCK_HEADERS, rows.map((r) => [
    r.name, r.sku, String(r.stock), r.price.toFixed(2), money(r.valueAgorot), STOCK_STATE[lang][r.state],
  ]), lang);
}

export function payoutsReportCsv(rows: readonly PayoutRow[], lang: Lang): string {
  return serialize(PAYOUT_HEADERS, rows.map((r) => [
    r.dayISO, r.periodKey, money(r.amountAgorot), money(r.commissionAgorot), PAYOUT_STATUS[lang][r.status],
  ]), lang);
}

/** `<store>-<report>-<from>_<to>.csv`, ASCII-only. A Hebrew store name in a `Content-Disposition`
 *  filename needs RFC 5987 encoding that browsers disagree about, and the date range is the part
 *  that actually stops two downloads overwriting each other in the Downloads folder. */
export function reportFileName(report: ReportId, storeSlug: string, fromISO: string, toISO: string): string {
  const safeSlug = storeSlug.replace(/[^A-Za-z0-9_-]/g, '') || 'store';
  const span = report === 'stock' ? '' : `-${fromISO}_${toISO}`;
  return `${safeSlug}-${report}${span}.csv`;
}
