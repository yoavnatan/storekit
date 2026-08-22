import { describe, expect, it } from 'vitest';
import type { Order, OrderItem } from '../src/lib/orders.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import {
  buildSalesReport, buildProductSalesReport, buildStockReport, isReportId,
  LOW_STOCK_AT,
} from '../src/lib/seller-reports.js';
import { allocateAgorot } from '../src/lib/money.js';

const SLUG = 'my-store';

type Line = { productId: string; name: string; priceAgorot: number; qty: number };

function line(l: Line): OrderItem {
  return {
    productId: l.productId, productName: l.name, productSlug: l.productId,
    storeSlug: SLUG, storeName: 'החנות שלי', priceAgorot: l.priceAgorot, qty: l.qty,
  };
}

function order(opts: {
  id: string;
  createdAt: string;
  lines: Line[];
  discountAgorot?: number;
  couponCode?: string;
  shippingAgorot?: number;
  paymentStatus?: Order['paymentStatus'];
  shippingStatus?: Order['shippingStatus'];
  otherStoreAgorot?: number;
}): Order {
  const lines = opts.lines.map(line);
  const subtotal = lines.reduce((n, i) => n + i.priceAgorot * i.qty, 0);
  const discount = opts.discountAgorot ?? 0;
  return {
    id: opts.id,
    buyerName: 'רות לוי', buyerEmail: 'r@example.com', buyerPhone: '0500000000',
    buyerAddress: { city: 'חיפה', street: 'הרצל 1' },
    items: [
      ...lines,
      ...(opts.otherStoreAgorot
        ? [{ productId: 'x', productName: 'אחר', productSlug: 'x', storeSlug: 'other-store', storeName: 'אחרת', priceAgorot: opts.otherStoreAgorot, qty: 1 }]
        : []),
    ],
    storeSubtotals: {
      [SLUG]: {
        storeName: 'החנות שלי',
        subtotalAgorot: subtotal,
        shippingAgorot: opts.shippingAgorot ?? 0,
        ...(discount ? { discount: { type: 'amount' as const, value: discount / 100, appliedAgorot: discount } } : {}),
        ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
      },
      ...(opts.otherStoreAgorot
        ? { 'other-store': { storeName: 'אחרת', subtotalAgorot: opts.otherStoreAgorot, shippingAgorot: 0 } }
        : {}),
    },
    shippingAgorot: opts.shippingAgorot ?? 0,
    totalAgorot: subtotal - discount + (opts.shippingAgorot ?? 0),
    paymentStatus: opts.paymentStatus ?? 'paid',
    shippingStatus: opts.shippingStatus ?? 'delivered',
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
}

function product(p: Partial<StoreProduct> & { id: string; name: string }): StoreProduct {
  return {
    storeId: 'store-1', slug: p.id, description: '', price: 100, stock: 10, ...p,
  } as StoreProduct;
}

// Noon UTC, so the business-day conversion (Asia/Jerusalem) cannot land the row on a neighbouring
// date and make a range test pass or fail for the wrong reason.
const at = (day: string): string => `${day}T12:00:00.000Z`;

describe('sales report', () => {
  const orders = [
    order({ id: 'o1', createdAt: at('2026-08-03'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 2 }], shippingAgorot: 3000 }),
    order({ id: 'o2', createdAt: at('2026-08-05'), lines: [{ productId: 'p2', name: 'שולחן', priceAgorot: 50000, qty: 1 }], discountAgorot: 5000, couponCode: 'AUG10' }),
    order({ id: 'o3', createdAt: at('2026-08-06'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 1 }], shippingStatus: 'cancelled' }),
    order({ id: 'o4', createdAt: at('2026-07-30'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 9 }] }),
  ];

  const built = buildSalesReport(orders, SLUG, '2026-08-01', '2026-08-31', 12);

  it('holds the window, and holds it in business days', () => {
    expect(built.rows.map((r) => r.orderId)).toEqual(['o3', 'o2', 'o1']); // newest first, July excluded
  });

  it('lists a cancelled order but never counts it', () => {
    const cancelled = built.rows.find((r) => r.orderId === 'o3');
    expect(cancelled?.countsAsRevenue).toBe(false);
    // The row is present — a seller reconciling a month has to see the cancellation, not a gap.
    expect(cancelled?.grossAgorot).toBe(10000);
    // ...and charges no commission on it. Billing for a sale that did not happen is the one number
    // that would make a seller distrust the whole tab.
    expect(cancelled?.commissionAgorot).toBe(0);
    expect(built.totals.rows).toBe(3);
    expect(built.totals.grossAgorot).toBe(20000 + 50000);
  });

  it('nets the discount out and takes commission on the net, not the gross', () => {
    const discounted = built.rows.find((r) => r.orderId === 'o2');
    expect(discounted?.netAgorot).toBe(45000);
    expect(discounted?.commissionAgorot).toBe(5400); // 12% of 450.00
    expect(discounted?.payoutAgorot).toBe(45000 - 5400);
    expect(discounted?.couponCode).toBe('AUG10');
  });

  it('sees only this store in a multi-store order', () => {
    const shared = buildSalesReport(
      [order({ id: 'm1', createdAt: at('2026-08-04'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 1 }], otherStoreAgorot: 99900 })],
      SLUG, '2026-08-01', '2026-08-31', 12,
    );
    expect(shared.totals.grossAgorot).toBe(10000);
  });

  it('every total is the sum of the counting rows — parts sum to the whole', () => {
    const counting = built.rows.filter((r) => r.countsAsRevenue);
    for (const key of ['grossAgorot', 'discountAgorot', 'netAgorot', 'shippingAgorot', 'commissionAgorot', 'payoutAgorot'] as const) {
      expect(built.totals[key]).toBe(counting.reduce((n, r) => n + r[key], 0));
    }
  });

  it('never reports negative revenue, even for a row whose discount exceeds its subtotal', () => {
    // reconcile.ts is what REPORTS such a row as wrong; a report must not bend it silently, but it
    // must also not print money owed backwards.
    const broken = buildSalesReport(
      [order({ id: 'b1', createdAt: at('2026-08-04'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 1 }], discountAgorot: 15000 })],
      SLUG, '2026-08-01', '2026-08-31', 12,
    );
    expect(broken.rows[0].netAgorot).toBe(0);
    expect(broken.totals.netAgorot).toBe(0);
  });
});

describe('product report', () => {
  const orders = [
    order({
      id: 'o1', createdAt: at('2026-08-03'),
      lines: [
        { productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 1 },
        { productId: 'p2', name: 'שולחן', priceAgorot: 20000, qty: 1 },
      ],
      // Deliberately indivisible by three: 100 agorot over a 1:2 split is where a naive
      // per-line round loses or invents an agora.
      discountAgorot: 100,
    }),
    order({ id: 'o2', createdAt: at('2026-08-04'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 3 }] }),
    order({ id: 'o3', createdAt: at('2026-08-05'), lines: [{ productId: 'p1', name: 'כיסא', priceAgorot: 10000, qty: 5 }], paymentStatus: 'failed' }),
  ];
  const products = [product({ id: 'p1', name: 'כיסא', stock: 4, sku: 'CH-1' }), product({ id: 'p2', name: 'שולחן', stock: 0 })];
  const built = buildProductSalesReport(orders, products, SLUG, '2026-08-01', '2026-08-31');

  it('counts units only from orders that count as revenue', () => {
    expect(built.rows.find((r) => r.productId === 'p1')?.units).toBe(4); // 1 + 3, never the failed 5
  });

  it('carries live stock beside units sold, and a blank rather than 0 for a deleted product', () => {
    expect(built.rows.find((r) => r.productId === 'p1')?.stock).toBe(4);
    const orphan = buildProductSalesReport(orders, [], SLUG, '2026-08-01', '2026-08-31');
    expect(orphan.rows[0].stock).toBeNull();
  });

  it('reconciles to the sales report to the agora, discount allocation included', () => {
    // The whole reason the discount is allocated rather than dropped: an accountant holds the two
    // exports side by side, and a difference of one agora is a difference.
    const sales = buildSalesReport(orders, SLUG, '2026-08-01', '2026-08-31', 12);
    expect(built.totals.netAgorot).toBe(sales.totals.netAgorot);
    expect(built.totals.grossAgorot).toBe(sales.totals.grossAgorot);
    expect(built.totals.discountAgorot).toBe(sales.totals.discountAgorot);
  });

  it('sorts by what earned most', () => {
    expect(built.rows[0].productId).toBe('p1');
  });
});

describe('allocateAgorot', () => {
  it('always gives back exactly the amount it was handed', () => {
    for (const total of [0, 1, 7, 100, 999, 123457]) {
      for (const weights of [[1, 2], [1, 1, 1], [5, 3, 2, 1], [10000, 1]]) {
        expect(allocateAgorot(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('is deterministic — the same split twice, so a report re-run does not move a number', () => {
    expect(allocateAgorot(100, [1, 1, 1])).toEqual(allocateAgorot(100, [1, 1, 1]));
    expect(allocateAgorot(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('gives zeros rather than inventing an even split when there is nothing to weigh by', () => {
    expect(allocateAgorot(500, [0, 0])).toEqual([0, 0]);
    expect(allocateAgorot(500, [])).toEqual([]);
    expect(allocateAgorot(0, [1, 2])).toEqual([0, 0]);
  });
});

describe('stock report', () => {
  const built = buildStockReport([
    product({ id: 'a', name: 'תקין', stock: 40, price: 25 }),
    product({ id: 'b', name: 'אזל', stock: 0, price: 10 }),
    product({ id: 'c', name: 'נמוך', stock: LOW_STOCK_AT, price: 100 }),
  ]);

  it('puts what needs acting on first', () => {
    expect(built.rows.map((r) => r.state)).toEqual(['out', 'low', 'ok']);
  });

  it('values the shelf in agorot, so it can be summed against every other money column', () => {
    expect(built.totals.valueAgorot).toBe(40 * 2500 + 0 + LOW_STOCK_AT * 10000);
    expect(built.totals.units).toBe(40 + LOW_STOCK_AT);
    expect(built.totals).toMatchObject({ products: 3, out: 1, low: 1 });
  });
});

describe('isReportId', () => {
  it('rejects anything not one of the three', () => {
    expect(isReportId('sales')).toBe(true);
    expect(isReportId('stock')).toBe(true);
    // `payouts` was the fourth until 2026-08-21 — it listed transfers this platform made, and it
    // makes none. An old bookmark carrying it must be REFUSED rather than silently answered.
    expect(isReportId('payouts')).toBe(false);
    expect(isReportId('revenue')).toBe(false);
    expect(isReportId(null)).toBe(false);
  });
});
