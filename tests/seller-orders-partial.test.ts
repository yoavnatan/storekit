import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';

// Money guarantee for a PARTIAL order edit: a request that doesn't mention a field must
// leave that field — and the money riding on it — exactly as it stands. This is what lets
// the edit-order modal send only what the seller changed, so a second tab editing the same
// order can't carry a stale value along and undo the first one (see scripts/dashboard/
// orders.ts + the multi-tab work in lib/record-rev.ts).

const STORE = { id: 's1', slug: 'test-store', name: 'Test Store', sellerId: 'seller-1' };

interface OrderFixture {
  id: string;
  shippingStatus: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  buyerAddress: { city: string; street: string; zip?: string };
  items: { productId: string; qty: number; price: number; storeSlug: string; productName: string }[];
  storeSubtotals: Record<string, { subtotal: number; shipping: number; discount?: { type: string; value: number; applied: number } }>;
  totalAmount: number;
}
let ORDER: OrderFixture;

vi.mock('../src/lib/seller-auth.js', () => ({ getSellerSession: () => 'seller-1' }));
vi.mock('../src/lib/stores.js', () => ({
  getStoresBySellerId: () => [STORE],
  findStoreBySlugOrPrevious: (stores: { slug: string }[], slug: string) => stores.find((s) => s.slug === slug),
}));
vi.mock('../src/lib/orders.js', () => ({
  getOrdersByStoreSlug: () => [],
  getOrderById: (id: string) => (id === ORDER.id ? { ...ORDER } : null),
  updateOrder: (id: string, u: Partial<OrderFixture>) => {
    if (id !== ORDER.id) return null;
    ORDER = { ...ORDER, ...u };
    return { ...ORDER };
  },
  orderStoreNotes: (): string[] => [],
}));
vi.mock('../src/lib/order-notify.js', () => ({ notifyOrderStatusChanged: () => {} }));
vi.mock('../src/lib/store-products.js', () => ({ restockProduct: async () => ({ ok: true, before: 0, after: 0 }) }));

const { PATCH } = await import('../src/pages/api/seller/orders.js');

function ctx(body: unknown): APIContext {
  const request = new Request('http://localhost/api/seller/orders', { method: 'PATCH', body: JSON.stringify(body) });
  const cookies = { get: () => undefined } as unknown as APIContext['cookies'];
  return { request, cookies } as APIContext;
}

const base = { orderId: 'order-1', storeSlug: 'test-store' };

beforeEach(() => {
  ORDER = {
    id: 'order-1',
    shippingStatus: 'processing',
    buyerName: 'דנה כהן',
    buyerEmail: 'dana@example.com',
    buyerPhone: '050-1111111',
    buyerAddress: { city: 'חיפה', street: 'הרצל 1', zip: '3100000' },
    items: [
      { productId: 'p1', qty: 2, price: 100, storeSlug: 'test-store', productName: 'א' },
      { productId: 'p2', qty: 1, price: 50, storeSlug: 'test-store', productName: 'ב' },
    ],
    storeSubtotals: { 'test-store': { subtotal: 250, shipping: 20, discount: { type: 'percent', value: 10, applied: 27 } } },
    totalAmount: 243,
  };
});

describe('PATCH /api/seller/orders — a partial edit touches only what it names', () => {
  it('changes the one field sent and leaves the rest of the buyer block alone', async () => {
    const res = await PATCH(ctx({ ...base, buyerPhone: '052-2222222' }));
    expect(res.status).toBe(200);
    expect(ORDER.buyerPhone).toBe('052-2222222');
    // The fields another tab may have just fixed:
    expect(ORDER.buyerName).toBe('דנה כהן');
    expect(ORDER.buyerEmail).toBe('dana@example.com');
    expect(ORDER.buyerAddress).toEqual({ city: 'חיפה', street: 'הרצל 1', zip: '3100000' });
  });

  it('keeps an existing discount when the request never mentions one — and re-applies it to the new total', async () => {
    // Deleting the 2×100₪ line: subtotal 250→50, so the same 10% is now 5₪.
    //
    // The base is the SUBTOTAL, not subtotal + shipping (which would make this 7₪).
    // Two reasons it changed: shipping is the platform's rate and never the seller's
    // to discount, and revenue is read as `subtotal − discount`, so discounting
    // against a base that included shipping let a large discount push a store's
    // reported revenue NEGATIVE. See the orders API and tests/reporting-fuzz.test.ts.
    const res = await PATCH(ctx({ ...base, itemDeletes: ['p1'] }));
    expect(res.status).toBe(200);
    expect(ORDER.storeSubtotals['test-store']!.discount).toEqual({ type: 'percent', value: 10, applied: 5 });
    expect(ORDER.totalAmount).toBe(65); // 50 + 20 − 5
  });

  it('still clears the discount when the seller explicitly clears it', async () => {
    const res = await PATCH(ctx({ ...base, itemDeletes: ['p1'], discount: null }));
    expect(res.status).toBe(200);
    expect(ORDER.storeSubtotals['test-store']!.discount).toBeUndefined();
    expect(ORDER.totalAmount).toBe(70); // 50 + 20, nothing off
  });

  it('still applies a discount the seller does send', async () => {
    const res = await PATCH(ctx({ ...base, discount: { type: 'amount', value: 30 } }));
    expect(res.status).toBe(200);
    expect(ORDER.storeSubtotals['test-store']!.discount).toEqual({ type: 'amount', value: 30, applied: 30 });
    expect(ORDER.totalAmount).toBe(240); // 250 + 20 − 30
  });

  it('a request naming nothing is refused rather than writing an empty update', async () => {
    const res = await PATCH(ctx({ ...base }));
    expect(res.status).toBe(400);
  });
});
