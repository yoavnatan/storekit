import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';

// Money/stock guarantee: cancelling an order must return every reserved unit to
// stock (variant-aware), only from a still-cancellable status, and never twice.

type StockAdjustResult = { ok: boolean; before: number; after: number };
const restockProduct = vi.fn(async (_id: string, _qty: number, _sv?: Record<string, string>): Promise<StockAdjustResult> => ({ ok: true, before: 0, after: 0 }));
const notifyOrderStatusChanged = vi.fn((..._args: unknown[]) => {});

const STORE = { id: 's1', slug: 'test-store', name: 'Test Store', sellerId: 'seller-1' };

interface OrderFixture {
  id: string;
  buyerId?: string;
  shippingStatus: string;
  items: { productId: string; qty: number; selectedVariants?: Record<string, string> }[];
}
let ORDER: OrderFixture;

const getOrderById = vi.fn((id: string) => (id === ORDER.id ? { ...ORDER } : null));
const updateOrder = vi.fn((id: string, updates: Partial<OrderFixture>) => {
  if (id !== ORDER.id) return null;
  ORDER = { ...ORDER, ...updates };
  return { ...ORDER };
});

vi.mock('../src/lib/seller-auth.js', () => ({ getSellerSession: () => 'seller-1' }));
vi.mock('../src/lib/stores.js', () => ({
  getStoresBySellerId: () => [STORE],
  findStoreBySlugOrPrevious: (stores: { slug: string; previousSlugs?: string[] }[], slug: string) =>
    stores.find((s) => s.slug === slug || s.previousSlugs?.includes(slug)),
  // A status change now also settles a pending store closure (store-lifecycle.ts), which reads
  // the store back by slug. Left REAL rather than stubbing settleStoreClosure away: this fixture
  // store has no pending closure, so the real function must return on its first check — that it
  // is a genuine no-op for an ordinary store is worth exercising, not mocking out.
  getStoreBySlug: (slug: string) => (slug === STORE.slug ? STORE : null),
}));
vi.mock('../src/lib/orders.js', () => ({
  getOrdersByStoreSlug: () => [],
  getOrderById: (id: string) => getOrderById(id),
  updateOrder: (id: string, u: Partial<OrderFixture>) => updateOrder(id, u),
  // Faithful stand-in for the real pure reader (orders.ts) — the seller orders API scopes each
  // order's per-store notes through it, so the mock must export it too.
  orderStoreNotes: (o: OrderFixture, slug: string): string[] => {
    const v = (o as { sellerNotes?: Record<string, unknown> }).sellerNotes?.[slug];
    if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
    if (typeof v === 'string' && v.trim() !== '') return [v];
    return [];
  },
}));
vi.mock('../src/lib/order-notify.js', () => ({
  notifyOrderStatusChanged: (...args: unknown[]) => notifyOrderStatusChanged(...args),
}));
vi.mock('../src/lib/store-products.js', () => ({
  restockProduct: (id: string, qty: number, sv?: Record<string, string>) => restockProduct(id, qty, sv),
}));

const { PATCH } = await import('../src/pages/api/seller/orders.js');

function ctx(body: unknown): APIContext {
  const request = new Request('http://localhost/api/seller/orders', { method: 'PATCH', body: JSON.stringify(body) });
  const cookies = { get: () => undefined } as unknown as APIContext['cookies'];
  return { request, cookies } as APIContext;
}

const cancelBody = { orderId: 'order-1', storeSlug: 'test-store', shippingStatus: 'cancelled' };

beforeEach(() => {
  restockProduct.mockClear();
  notifyOrderStatusChanged.mockClear();
  ORDER = {
    id: 'order-1',
    buyerId: 'buyer-1',
    shippingStatus: 'processing',
    items: [
      { productId: 'p1', qty: 2, selectedVariants: { size: 'M' } },
      { productId: 'p2', qty: 1 },
    ],
  };
});

describe('PATCH /api/seller/orders — cancellation', () => {
  it('restocks every item (variant-aware) and notifies the buyer when cancelling a processing order', async () => {
    const res = await PATCH(ctx(cancelBody));
    expect(res.status).toBe(200);
    expect(ORDER.shippingStatus).toBe('cancelled');
    expect(restockProduct).toHaveBeenCalledTimes(2);
    expect(restockProduct).toHaveBeenCalledWith('p1', 2, { size: 'M' });
    expect(restockProduct).toHaveBeenCalledWith('p2', 1, undefined);
    expect(notifyOrderStatusChanged).toHaveBeenCalledOnce();
  });

  it('refuses to cancel an already-shipped order and restocks nothing', async () => {
    ORDER.shippingStatus = 'shipped';
    const res = await PATCH(ctx(cancelBody));
    expect(res.status).toBe(409);
    expect(ORDER.shippingStatus).toBe('shipped');
    expect(restockProduct).not.toHaveBeenCalled();
  });

  it('cancellation is terminal — a re-cancel restocks nothing (no double refund)', async () => {
    ORDER.shippingStatus = 'cancelled';
    const res = await PATCH(ctx(cancelBody));
    expect(res.status).toBe(409);
    expect(restockProduct).not.toHaveBeenCalled();
  });

  it('refuses to move a cancelled order back into an active status', async () => {
    ORDER.shippingStatus = 'cancelled';
    const res = await PATCH(ctx({ orderId: 'order-1', storeSlug: 'test-store', shippingStatus: 'processing' }));
    expect(res.status).toBe(409);
    expect(ORDER.shippingStatus).toBe('cancelled');
    expect(restockProduct).not.toHaveBeenCalled();
  });
});
