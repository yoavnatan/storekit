import { describe, expect, it } from 'vitest';
import { sortRows, columnsFor, type AnyRow, type Column } from '../src/scripts/dashboard/reports.js';
import type { SalesRow, StockRow } from '../src/lib/seller-report-shapes.js';

/**
 * The reports tab's column sorting.
 *
 * Two things are worth pinning and neither is "does it sort". A money column renders as
 * `1,234.00 ₪` and sorting on THAT string orders 1,000 before 90, which reads as a broken table
 * rather than a different opinion about order — so a column must sort by the underlying agorot.
 * And the rows array is the same one the export href and the totals line were built from, so
 * sorting must not reorder it in place under them.
 */
const T: Record<string, string> = {
  repColDate: 'תאריך', repColCustomer: 'לקוח', repColItems: 'פריטים', repColGross: 'ברוטו',
  repColDiscount: 'הנחה', repColNet: 'נטו', repColCommission: 'עמלה', repColPayout: 'לתשלום',
  repColState: 'מצב', repColProduct: 'מוצר', repColSku: 'מק"ט', repColUnits: 'יחידות',
  repColStock: 'מלאי', repColStockValue: 'שווי',
};

const col = (report: 'sales' | 'products' | 'stock', key: string): Column<never> | undefined =>
  columnsFor(report, T).find((c) => c.key === key);

function sale(id: string, payoutAgorot: number, dayISO: string): SalesRow {
  return {
    orderId: id, dayISO, buyerName: 'ב', city: 'ח', items: 1,
    grossAgorot: payoutAgorot, discountAgorot: 0, couponCode: '', netAgorot: payoutAgorot,
    shippingAgorot: 0, commissionAgorot: 0, payoutAgorot,
    paymentStatus: 'paid', shippingStatus: 'delivered', countsAsRevenue: true,
  };
}

describe('report sorting', () => {
  it('orders money by its value, not by the string it renders as', () => {
    // 90.00 ₪ vs 1,000.00 ₪ — the pair that exposes a string sort.
    const rows: AnyRow[] = [sale('a', 9000, '2026-08-01'), sale('b', 100000, '2026-08-02'), sale('c', 50, '2026-08-03')];
    const asc = sortRows(rows, col('sales', 'payout'), 1) as SalesRow[];
    expect(asc.map((r) => r.payoutAgorot)).toEqual([50, 9000, 100000]);
    const desc = sortRows(rows, col('sales', 'payout'), -1) as SalesRow[];
    expect(desc.map((r) => r.payoutAgorot)).toEqual([100000, 9000, 50]);
  });

  it('never reorders the array the totals and the export were built from', () => {
    const rows: AnyRow[] = [sale('a', 300, '2026-08-01'), sale('b', 100, '2026-08-02')];
    const before = rows.map((r) => (r as SalesRow).orderId);
    sortRows(rows, col('sales', 'payout'), 1);
    expect(rows.map((r) => (r as SalesRow).orderId)).toEqual(before);
  });

  it('sorts dates chronologically, which for an ISO day is also alphabetical', () => {
    const rows: AnyRow[] = [sale('a', 1, '2026-09-01'), sale('b', 1, '2026-08-31'), sale('c', 1, '2026-10-02')];
    const asc = sortRows(rows, col('sales', 'day'), 1) as SalesRow[];
    expect(asc.map((r) => r.dayISO)).toEqual(['2026-08-31', '2026-09-01', '2026-10-02']);
  });

  it('leaves the rows exactly as the server ordered them when the column is not sortable', () => {
    // "Customer" and "SKU" carry no sortBy on purpose — a sort arrow on every column turns the
    // header into nine controls answering questions nobody asks.
    const rows: AnyRow[] = [sale('a', 1, '2026-08-02'), sale('b', 1, '2026-08-01')];
    expect(sortRows(rows, col('sales', 'buyer'), 1)).toEqual(rows);
    expect(sortRows(rows, undefined, 1)).toEqual(rows);
  });

  it('sorts a product name the way a person reads a list, digits included', () => {
    const stock = (name: string): StockRow =>
      ({ productId: name, name, sku: '', stock: 1, price: 1, valueAgorot: 100, state: 'ok' });
    const rows: AnyRow[] = [stock('פריט 10'), stock('פריט 2'), stock('פריט 1')];
    const asc = sortRows(rows, col('stock', 'name'), 1) as StockRow[];
    // `numeric: true` — without it "פריט 10" sorts before "פריט 2".
    expect(asc.map((r) => r.name)).toEqual(['פריט 1', 'פריט 2', 'פריט 10']);
  });
});
