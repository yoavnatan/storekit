import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIContext } from 'astro';
import { orderBelongsToStore } from '../src/lib/orders';

// Authorization guarantee for the seller Orders tab: a seller session says which STORES the
// seller owns, never which ORDERS. Pairing someone else's order id with your own storeSlug used
// to be accepted — cancelling that order (restocking the other seller's stock, mailing their
// buyer), rewriting the buyer's details, or deleting items and recomputing the total.

const MY_STORE    = { id: 's1', slug: 'my-store',    name: 'My Store',    sellerId: 'seller-1' };
const OTHER_STORE = { id: 's2', slug: 'other-store', name: 'Other Store', sellerId: 'seller-2' };

interface OrderFixture {
  id: string;
  shippingStatus: string;
  items: { productId: string; qty: number; storeSlug: string }[];
  storeSubtotals: Record<string, { subtotalAgorot: number; shippingAgorot: number }>;
  buyerName?: string;
}
let ORDERS: Record<string, OrderFixture>;

const restockProduct = vi.fn(async () => ({ ok: true, before: 0, after: 0 }));
const notifyOrderStatusChanged = vi.fn(() => {});
const updateOrder = vi.fn((id: string, updates: Partial<OrderFixture>) => {
  const o = ORDERS[id];
  if (!o) return null;
  ORDERS[id] = { ...o, ...updates };
  return { ...ORDERS[id]! };
});

vi.mock('../src/lib/seller-auth.js', () => ({ getSellerSession: () => 'seller-1', getSellerById: () => null }));
vi.mock('../src/lib/stores.js', () => ({
  // seller-1 owns MY_STORE only — OTHER_STORE is never in their list.
  getStoresBySellerId: () => [MY_STORE],
  findStoreBySlugOrPrevious: (stores: { slug: string }[], slug: string) => stores.find((s) => s.slug === slug),
  getStoreBySlug: (slug: string) => (slug === MY_STORE.slug ? MY_STORE : slug === OTHER_STORE.slug ? OTHER_STORE : null),
}));
vi.mock('../src/lib/orders.js', async () => {
  const real = await vi.importActual<typeof import('../src/lib/orders')>('../src/lib/orders');
  return {
    getOrdersByStoreSlug: () => [],
    getOrderById: (id: string) => (ORDERS[id] ? { ...ORDERS[id]! } : null),
    updateOrder: (id: string, u: Partial<OrderFixture>) => updateOrder(id, u),
    orderStoreNotes: () => [],
    // The predicate under test stays REAL — mocking it would mock away the fix.
    orderBelongsToStore: real.orderBelongsToStore,
  };
});
vi.mock('../src/lib/order-notify.js', () => ({ notifyOrderStatusChanged: () => notifyOrderStatusChanged() }));
vi.mock('../src/lib/store-products.js', () => ({ restockProduct: () => restockProduct() }));

const { PATCH } = await import('../src/pages/api/seller/orders.js');

function ctx(body: unknown): APIContext {
  return {
    request: new Request('http://localhost/api/seller/orders', { method: 'PATCH', body: JSON.stringify(body) }),
    cookies: { get: () => undefined } as unknown as APIContext['cookies'],
  } as APIContext;
}

beforeEach(() => {
  restockProduct.mockClear();
  notifyOrderStatusChanged.mockClear();
  ORDERS = {
    mine: {
      id: 'mine', shippingStatus: 'processing', buyerName: 'Buyer A',
      items: [{ productId: 'p1', qty: 1, storeSlug: MY_STORE.slug }],
      storeSubtotals: { [MY_STORE.slug]: { subtotalAgorot: 100, shippingAgorot: 0 } },
    },
    theirs: {
      id: 'theirs', shippingStatus: 'processing', buyerName: 'Buyer B',
      items: [{ productId: 'p9', qty: 3, storeSlug: OTHER_STORE.slug }],
      storeSubtotals: { [OTHER_STORE.slug]: { subtotalAgorot: 500, shippingAgorot: 0 } },
    },
  };
});

describe('PATCH /api/seller/orders — the order must belong to the caller\'s store', () => {
  it('cancels its own order (control: the same request shape does work)', async () => {
    const res = await PATCH(ctx({ orderId: 'mine', storeSlug: MY_STORE.slug, shippingStatus: 'cancelled' }));
    expect(res.status).toBe(200);
    expect(ORDERS['mine']!.shippingStatus).toBe('cancelled');
  });

  it("refuses another store's order id — no status change, no restock, no buyer mail", async () => {
    const res = await PATCH(ctx({ orderId: 'theirs', storeSlug: MY_STORE.slug, shippingStatus: 'cancelled' }));
    expect(res.status).toBe(404);
    expect(ORDERS['theirs']!.shippingStatus).toBe('processing');
    expect(updateOrder).not.toHaveBeenCalledWith('theirs', expect.anything());
    expect(restockProduct).not.toHaveBeenCalled();
    expect(notifyOrderStatusChanged).not.toHaveBeenCalled();
  });

  it("refuses to rewrite another store's buyer details", async () => {
    const res = await PATCH(ctx({ orderId: 'theirs', storeSlug: MY_STORE.slug, buyerName: 'Attacker', buyerEmail: 'a@b.com' }));
    expect(res.status).toBe(404);
    expect(ORDERS['theirs']!.buyerName).toBe('Buyer B');
  });

  it("refuses to delete items off another store's order", async () => {
    const res = await PATCH(ctx({ orderId: 'theirs', storeSlug: MY_STORE.slug, itemDeletes: ['p9'] }));
    expect(res.status).toBe(404);
    expect(ORDERS['theirs']!.items).toHaveLength(1);
  });

  it("refuses to write private notes into another store's order", async () => {
    const res = await PATCH(ctx({ orderId: 'theirs', storeSlug: MY_STORE.slug, sellerNotes: ['hello'] }));
    expect(res.status).toBe(404);
  });

  it('an unknown order id is refused the same way', async () => {
    expect((await PATCH(ctx({ orderId: 'nope', storeSlug: MY_STORE.slug, shippingStatus: 'shipped' }))).status).toBe(404);
  });
});

describe('orderBelongsToStore', () => {
  const order = {
    items: [{ storeSlug: 'a' }],
    storeSubtotals: { a: { subtotalAgorot: 1, shippingAgorot: 0 } },
  } as unknown as Parameters<typeof orderBelongsToStore>[0];

  it('matches the store that owns the items', () => {
    expect(orderBelongsToStore(order, 'a')).toBe(true);
    expect(orderBelongsToStore(order, 'b')).toBe(false);
  });

  it('still matches after the seller deleted the last item (subtotal key survives)', () => {
    const emptied = { items: [], storeSubtotals: { a: { subtotalAgorot: 0, shippingAgorot: 0 } } } as unknown as Parameters<typeof orderBelongsToStore>[0];
    expect(orderBelongsToStore(emptied, 'a')).toBe(true);
  });

  it('an empty slug never matches', () => {
    expect(orderBelongsToStore(order, '')).toBe(false);
  });
});

// The class guard, not just this one route: any API route that mutates an order by id has to
// bind that id to the caller's store. A new endpoint that forgets fails here instead of shipping.
describe('every order-mutating API route binds the order to a store', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  }

  it('calls orderBelongsToStore wherever it calls updateOrder', () => {
    const offenders = walk('src/pages/api')
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        // Admin routes act platform-wide by design and are authorized by an admin session.
        return /\bupdateOrder\(/.test(src) && !f.includes('/admin') && !/orderBelongsToStore/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
