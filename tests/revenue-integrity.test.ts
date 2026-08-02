import { describe, it, expect } from 'vitest';
import { countsAsRevenue, purchasedCountsFrom } from '../src/lib/orders.js';
import { buildPerformanceSummary } from '../src/lib/seller-performance.js';
import { getPlatformOverview, getStoreRevenueMap } from '../src/lib/admin-stats.js';
import fs from 'node:fs';
import path from 'node:path';

type AnyOrder = Parameters<typeof countsAsRevenue>[0];

describe('countsAsRevenue', () => {
  it('counts a paid order that is still running', () => {
    for (const shippingStatus of ['pending', 'processing', 'ready', 'shipped', 'delivered'] as const) {
      expect(countsAsRevenue({ paymentStatus: 'paid', shippingStatus } as AnyOrder), shippingStatus).toBe(true);
    }
  });

  it('does NOT count a cancelled order, even though its payment stayed "paid"', () => {
    // The exact shape a seller cancellation leaves behind: the charge happened,
    // the stock went back on the shelf. Counting it reports money that is owed back.
    expect(countsAsRevenue({ paymentStatus: 'paid', shippingStatus: 'cancelled' } as AnyOrder)).toBe(false);
  });

  it('does not count an unpaid or failed order', () => {
    expect(countsAsRevenue({ paymentStatus: 'pending', shippingStatus: 'pending' } as AnyOrder)).toBe(false);
    expect(countsAsRevenue({ paymentStatus: 'failed', shippingStatus: 'pending' } as AnyOrder)).toBe(false);
  });
});

// A cancelled order must vanish from BOTH surfaces. They are separate modules that
// each used to carry their own `paymentStatus === 'paid'` copy, which is how they
// drifted; these two assertions are what keeps them on the shared predicate.
const STORE = 'test-store';
const baseOrder = (id: string, amount: number, over: Record<string, unknown> = {}) => ({
  id,
  buyerName: 'B', buyerEmail: 'b@x.test', buyerPhone: '0500000000', buyerAddress: 'A',
  items: [{ productId: 'p1', productName: 'P', storeSlug: STORE, storeName: 'S', priceAgorot: amount, qty: 1, image: '' }],
  storeSubtotals: { [STORE]: { subtotalAgorot: amount, shippingAgorot: 0, total: amount } },
  shippingAgorot: 0,
  totalAgorot: amount,
  paymentStatus: 'paid',
  shippingStatus: 'delivered',
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
  ...over,
}) as never;

describe('a cancelled order leaves every revenue surface', () => {
  const live = baseOrder('o1', 100);
  const cancelled = baseOrder('o2', 250, { shippingStatus: 'cancelled' });

  it('is excluded from the seller Performance tab', () => {
    const withBoth = buildPerformanceSummary([live, cancelled], STORE, '2026-07-01', '2026-07-31', 'day');
    const liveOnly = buildPerformanceSummary([live], STORE, '2026-07-01', '2026-07-31', 'day');
    expect(withBoth.totalRevenueAgorot).toBe(liveOnly.totalRevenueAgorot);
    expect(withBoth.totalRevenueAgorot).toBe(100); // not 350
    expect(withBoth.totalOrders).toBe(liveOnly.totalOrders);
  });

  it('is excluded from the admin platform overview', () => {
    // `gmv` is the money figure; `totalOrders` is deliberately every row whatever
    // its state, so only paidOrders/gmv may shed the cancelled one.
    const overview = getPlatformOverview([], [], [live, cancelled]);
    expect(overview.gmvAgorot).toBe(100); // not 350
    expect(overview.paidOrders).toBe(1);
  });

  it('is excluded from the admin per-store revenue breakdown', () => {
    // The other admin surface — the store table's revenue column and the
    // GMV/commission split both read this map.
    // Per-store revenue is the store's NET (its subtotal less its own discount),
    // not the order's gross total — so the live order contributes its subtotal.
    const map = getStoreRevenueMap([live, cancelled]);
    expect(map.get(STORE)?.totalRevenueAgorot ?? 0).toBe(100); // not 350
  });
});

describe('units sold obeys the same rule as revenue', () => {
  // Not just a dashboard column: this number orders the public storefront by
  // popularity and becomes custom_label_1 (performanceTier) in the Merchant/Meta
  // feed, so a product inflated by failed or cancelled orders pulls real ad budget.
  it('counts only genuinely sold units, not pending / failed / cancelled ones', () => {
    const mixed = [
      baseOrder('sold', 10, { items: [{ productId: 'p1', storeSlug: STORE, qty: 2, priceAgorot: 10, productName: 'P', storeName: 'S', image: '' }] }),
      baseOrder('cancelled', 10, { shippingStatus: 'cancelled', items: [{ productId: 'p1', storeSlug: STORE, qty: 5, priceAgorot: 10, productName: 'P', storeName: 'S', image: '' }] }),
      baseOrder('unpaid', 10, { paymentStatus: 'pending', items: [{ productId: 'p1', storeSlug: STORE, qty: 7, priceAgorot: 10, productName: 'P', storeName: 'S', image: '' }] }),
      baseOrder('failed', 10, { paymentStatus: 'failed', items: [{ productId: 'p1', storeSlug: STORE, qty: 9, priceAgorot: 10, productName: 'P', storeName: 'S', image: '' }] }),
    ];
    // 2 real units — not 23, which is what summing every order gave.
    expect(purchasedCountsFrom(mixed, STORE)['p1']).toBe(2);
  });
});

describe('a legacy order row without storeSubtotals cannot take a reporting surface down', () => {
  // orderNetForStore guards the field with `?.` because rows stored before it existed
  // are real; the loops that ITERATE the same field did not, so one such row threw a
  // TypeError instead of contributing 0 — and it throws inside a whole-panel render
  // (admin Overview, admin store table, the seller's Performance tab), so the legacy
  // row wouldn't have shown a wrong number, it would have blanked the screen.
  const legacy = baseOrder('legacy', 100, { storeSubtotals: undefined });
  const live = baseOrder('o1', 100);

  it('the admin overview and per-store map skip it and still report the live order', () => {
    expect(getPlatformOverview([], [], [live, legacy]).gmvAgorot).toBe(100);
    expect(getStoreRevenueMap([live, legacy]).get(STORE)?.totalRevenueAgorot ?? 0).toBe(100);
  });

  it('the seller Performance tab skips it', () => {
    const summary = buildPerformanceSummary([live, legacy], STORE, '2026-07-01', '2026-07-31', 'day');
    expect(summary.totalRevenueAgorot).toBe(100);
  });
});

describe('the predicate has no bypass left behind', () => {
  it('no revenue module carries its own paymentStatus check', () => {
    // The drift this whole fix exists to prevent: a second copy of the rule that
    // forgets cancellations. Revenue modules must ask countsAsRevenue instead.
    for (const file of ['src/lib/seller-performance.ts', 'src/lib/admin-stats.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/paymentStatus\s*[!=]==\s*'paid'/);
    }
  });
});
