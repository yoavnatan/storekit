import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';
import type { UserCartData } from '../src/lib/user-carts.js';

const PRODUCTS: Record<string, { id: string; slug: string; name: string; price: number; images?: string[]; stock: number; blocked?: boolean; hidden?: boolean }> = {
  widget: { id: 'p1', slug: 'widget', name: 'Widget', price: 50, images: ['w.png'], stock: 100 },
};

type StockAdjustResult = { ok: boolean; before: number; after: number };
// Default mirrors the real decrementStock's before/after semantics off the PRODUCTS fixture,
// so most tests don't need to stub a return value just to get the low-stock math right.
const decrementStock = vi.fn(async (id: string, qty: number, _selectedVariants?: Record<string, string>): Promise<StockAdjustResult> => {
  const before = Object.values(PRODUCTS).find((p) => p.id === id)?.stock ?? 0;
  return { ok: true, before, after: before - qty };
});
const restockProduct = vi.fn(async (_id: string, _qty: number, _selectedVariants?: Record<string, string>): Promise<StockAdjustResult> => ({ ok: true, before: 0, after: 0 }));

const STORES: Record<string, { id: string; slug: string; name: string; sellerId: string; address?: string; shipping?: { selfPickup?: boolean }; blocked?: boolean; demo?: boolean; previousSlugs?: string[] }> = {
  'test-store': {
    id: 's1',
    slug: 'test-store',
    name: 'Test Store',
    sellerId: 'seller-1',
    address: 'Herzl 1, Tel Aviv', // present so self-pickup is offerable
    shipping: { selfPickup: true },
  },
};

const createOrder = vi.fn((input: Record<string, unknown>) => ({ id: 'order-1', ...input }));
const createNotification = vi.fn();
const getSellerSession = vi.fn(() => null as string | null);
const getUserCart = vi.fn((_id: string): UserCartData => ({ cart: {}, wishlist: [], favoriteStores: [] }));
const saveUserCart = vi.fn();
const logError = vi.fn();

vi.mock('../src/lib/stores.js', () => ({
  getStoreBySlug: (slug: string) => STORES[slug] ?? null,
  getStoreBySlugOrPrevious: (slug: string) =>
    STORES[slug] ?? Object.values(STORES).find((s) => s.previousSlugs?.includes(slug)) ?? null,
  isStoreVisible: (store: { blocked?: boolean }) => !store.blocked,
}));
vi.mock('../src/lib/store-products.js', () => ({
  getProductBySlug: (_storeId: string, slug: string) => PRODUCTS[slug] ?? null,
  decrementStock: (id: string, qty: number, selectedVariants?: Record<string, string>) => decrementStock(id, qty, selectedVariants),
  restockProduct: (id: string, qty: number, selectedVariants?: Record<string, string>) => restockProduct(id, qty, selectedVariants),
  isProductVisible: (product: { blocked?: boolean; hidden?: boolean }) => !product.blocked && !product.hidden,
  LOW_STOCK_THRESHOLD: 3,
}));
vi.mock('../src/lib/orders.js', () => ({ createOrder: (input: Record<string, unknown>) => createOrder(input) }));
vi.mock('../src/lib/notifications.js', () => ({ createNotification: (input: Record<string, unknown>) => createNotification(input) }));
vi.mock('../src/lib/seller-auth.js', () => ({ getSellerSession: () => getSellerSession() }));
vi.mock('../src/lib/user-carts.js', () => ({
  getUserCart: (id: string) => getUserCart(id),
  saveUserCart: (id: string, data: unknown) => saveUserCart(id, data),
}));
// Without this mock, the "order creation fails" test below performed a real
// fs.writeFileSync into the actual dev data/error-log.json on every test run
// — polluting the admin dashboard's error log with a fake "disk write failed"
// entry that looked like a real production incident.
vi.mock('../src/lib/error-log.js', () => ({ logError: (entry: Record<string, unknown>) => logError(entry) }));

// Same reasoning as error-log above: the real recordAnalyticsEvent does an
// fs.writeFileSync into the dev data/analytics-events.json on every purchase, so
// stub it out — the funnel-capture side effect isn't what these tests exercise.
vi.mock('../src/lib/analytics.js', () => ({ recordAnalyticsEvent: () => {} }));

const { POST } = await import('../src/pages/api/checkout.js');

function makeContext(body: unknown): APIContext {
  const request = new Request('http://localhost/api/checkout', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const cookies = { get: () => undefined } as unknown as APIContext['cookies'];
  return { request, cookies } as APIContext;
}

const validBuyer = {
  buyerName: 'Dana',
  buyerEmail: 'dana@example.com',
  buyerPhone: '0500000000',
  buyerAddress: { city: 'Tel Aviv', street: 'Rothschild 1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSellerSession.mockReturnValue(null);
});

describe('POST /api/checkout — server-side price re-validation', () => {
  it('ignores a client-sent price and charges the real server-side product price instead', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1, price: 1 }],
    }));
    expect(res.status).toBe(201);
    const order = createOrder.mock.calls[0]![0] as { totalAmount: number; storeSubtotals: Record<string, { subtotal: number }> };
    // real price (50) + default platform courier rate (30), never the spoofed price of 1
    expect(order.storeSubtotals['test-store']!.subtotal).toBe(50);
    expect(order.totalAmount).toBe(80);
  });

  it('SEO-safe rename: a cart item sent with the store\'s OLD slug still checks out (resolves via previousSlugs, records the current slug)', async () => {
    STORES['test-store']!.previousSlugs = ['old-slug'];
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'old-slug', productSlug: 'widget', qty: 1 }], // buyer's cart predates the rename
      }));
      expect(res.status).toBe(201); // purchase succeeds — not a 400 "store not found"
      const order = createOrder.mock.calls[0]![0] as { storeSubtotals: Record<string, { subtotal: number }>; items: { storeSlug: string }[] };
      // subtotals + order items key off the CURRENT slug, never the stale one
      expect(order.storeSubtotals['test-store']!.subtotal).toBe(50);
      expect(order.storeSubtotals['old-slug']).toBeUndefined();
      expect(order.items[0]!.storeSlug).toBe('test-store');
    } finally {
      delete STORES['test-store']!.previousSlugs;
    }
  });

  it('charges no shipping for self-pickup (store offers it) and records the method', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      deliveryMethods: { 'test-store': 'pickup' },
    }));
    const order = createOrder.mock.calls[0]![0] as { totalAmount: number; shippingAmount: number; storeSubtotals: Record<string, { deliveryMethod?: string }> };
    expect(order.shippingAmount).toBe(0);
    expect(order.totalAmount).toBe(50);
    expect(order.storeSubtotals['test-store']!.deliveryMethod).toBe('pickup');
  });

  it('re-validates the delivery method: a spoofed/unavailable value falls back to the paid courier rate, never zeroing shipping', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      deliveryMethods: { 'test-store': 'free_lol' }, // not a real method
    }));
    const order = createOrder.mock.calls[0]![0] as { shippingAmount: number; storeSubtotals: Record<string, { deliveryMethod?: string }> };
    expect(order.shippingAmount).toBe(30);
    expect(order.storeSubtotals['test-store']!.deliveryMethod).toBe('courier');
  });

  it('does not offer self-pickup when the store has no address, even if the flag is set', async () => {
    STORES['test-store']!.address = undefined;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
        deliveryMethods: { 'test-store': 'pickup' }, // unavailable without an address
      }));
      const order = createOrder.mock.calls[0]![0] as { shippingAmount: number };
      expect(order.shippingAmount).toBe(30); // falls back to courier
    } finally {
      STORES['test-store']!.address = 'Herzl 1, Tel Aviv';
    }
  });

  it('rejects an unknown product instead of trusting client-supplied item data', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'does-not-exist', qty: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects checkout for an admin-blocked store instead of trusting the item as purchasable', async () => {
    STORES['test-store']!.blocked = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.blocked;
    }
  });

  it('refuses checkout from a showcase (demo) store — server-side, not by hiding a button', async () => {
    // The cart deliberately WORKS for a demo store; only this irreversible step is
    // refused, and it has to be refused here because the cart is client state and
    // this endpoint is directly callable (see lib/demo-stores.ts).
    STORES['test-store']!.demo = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'demo-store' });
      expect(createOrder).not.toHaveBeenCalled();
      // Refused BEFORE any stock is touched — the guard is a pre-pass, so there is
      // nothing to roll back and no window where a demo "sale" moved inventory.
      expect(decrementStock).not.toHaveBeenCalled();
      expect(restockProduct).not.toHaveBeenCalled();
    } finally {
      delete STORES['test-store']!.demo;
    }
  });

  it('refuses the WHOLE cart when only one of its stores is a showcase store', async () => {
    // Otherwise a mixed cart would silently part-charge, and the demo items would
    // land in a real order.
    STORES['demo-store'] = { id: 's2', slug: 'demo-store', name: 'Showcase', sellerId: 'seller-2', demo: true };
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'demo-store', productSlug: 'widget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(403);
      expect(createOrder).not.toHaveBeenCalled();
      expect(decrementStock).not.toHaveBeenCalled();
    } finally {
      delete STORES['demo-store'];
    }
  });

  it('rejects checkout for an admin-blocked product even when its store is fine', async () => {
    PRODUCTS.widget!.blocked = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete PRODUCTS.widget!.blocked;
    }
  });

  it('rejects checkout for a seller-hidden product (the take-down switch keeps it off checkout too)', async () => {
    PRODUCTS.widget!.hidden = true;
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete PRODUCTS.widget!.hidden;
    }
  });

  it('rolls back stock already reserved for an earlier item when a later item turns out to be blocked', async () => {
    PRODUCTS.gadget = { id: 'p2', slug: 'gadget', name: 'Gadget', price: 10, stock: 100, blocked: true };
    try {
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'test-store', productSlug: 'gadget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
      // widget (the first, valid item) already had stock reserved before the
      // second item's blocked-check failed — that reservation must be undone.
      expect(restockProduct).toHaveBeenCalledWith('p1', 1, undefined);
    } finally {
      delete PRODUCTS.gadget;
    }
  });

  it('rejects checkout with an empty cart', async () => {
    const res = await POST(makeContext({ ...validBuyer, items: [] }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid buyer email', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      buyerEmail: 'not-an-email',
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative quantity instead of silently clamping it', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 0 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('notifies the correct seller for the store that owns the order', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'seller-1', type: 'new_order' })
    );
  });

  it('decrements stock for each purchased item by its checkout qty', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
    }));
    expect(decrementStock).toHaveBeenCalledWith('p1', 3, undefined);
  });

  it('rejects checkout and creates no order when stock is insufficient', async () => {
    decrementStock.mockResolvedValueOnce({ ok: false, before: 1, after: 1 });
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));
    expect(res.status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('notifies the seller once stock crosses the low-stock threshold', async () => {
    PRODUCTS.widget!.stock = 5; // 5 - 3 = 2, at/below LOW_STOCK_THRESHOLD (3)
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller-1', type: 'low_stock', relatedId: 'p1' })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('separately notifies the seller when a purchase fully depletes stock', async () => {
    PRODUCTS.widget!.stock = 2;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller-1', type: 'out_of_stock', relatedId: 'p1' })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('names the specific variant combo in the alert body, not just the product', async () => {
    PRODUCTS.widget!.stock = 5;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3, selectedVariants: { Size: 'L', Color: 'Red' } }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'low_stock', body: expect.stringContaining('Size: L, Color: Red') })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('leaves the alert body as just the product name when no variant was selected', async () => {
    PRODUCTS.widget!.stock = 5;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'low_stock', body: expect.stringContaining('"Widget"') })
      );
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('fires only the more severe out-of-stock alert (not also low-stock) when a single order does both in one shot', async () => {
    PRODUCTS.widget!.stock = 5; // 5 -> 0: crosses the low-stock threshold AND fully depletes
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 5 }],
      }));
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'out_of_stock' }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('does not send an out-of-stock alert for a purchase that leaves some stock remaining', async () => {
    PRODUCTS.widget!.stock = 5;
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'out_of_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('does not send a low-stock alert for a purchase that stays above the threshold', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }], // 100 -> 99
    }));
    expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
  });

  it('does not re-notify on a purchase that was already at/below the threshold before this order', async () => {
    PRODUCTS.widget!.stock = 2; // already below threshold — no new crossing
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
      }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('does not send a low-stock alert when the order that would trigger it fails to commit', async () => {
    PRODUCTS.widget!.stock = 5;
    createOrder.mockImplementationOnce(() => { throw new Error('disk write failed'); });
    try {
      await POST(makeContext({
        ...validBuyer,
        items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 3 }],
      }));
      expect(createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'low_stock' }));
    } finally {
      PRODUCTS.widget!.stock = 100;
    }
  });

  it('rolls back stock already reserved for earlier items when a later item is out of stock', async () => {
    PRODUCTS.gadget = { id: 'p2', slug: 'gadget', name: 'Gadget', price: 10, stock: 100 };
    try {
      decrementStock
        .mockResolvedValueOnce({ ok: true, before: 100, after: 99 })
        .mockResolvedValueOnce({ ok: false, before: 100, after: 100 });
      const res = await POST(makeContext({
        ...validBuyer,
        items: [
          { storeSlug: 'test-store', productSlug: 'widget', qty: 1 },
          { storeSlug: 'test-store', productSlug: 'gadget', qty: 1 },
        ],
      }));
      expect(res.status).toBe(409);
      expect(restockProduct).toHaveBeenCalledWith('p1', 1, undefined);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      delete PRODUCTS.gadget;
    }
  });

  it('rolls back all reserved stock and returns 500 if order creation fails after stock was already reserved', async () => {
    createOrder.mockImplementationOnce(() => { throw new Error('disk write failed'); });
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }],
    }));
    expect(res.status).toBe(500);
    expect(restockProduct).toHaveBeenCalledWith('p1', 2, undefined);
  });

  it('for a signed-in buyer, stamps buyerId and removes only the purchased item from their server-side cart', async () => {
    getSellerSession.mockReturnValue('buyer-1');
    getUserCart.mockReturnValue({
      cart: {
        'test-store': {
          storeName: 'Test Store',
          storeSlug: 'test-store',
          items: { widget: { cartKey: 'widget', slug: 'widget', name: 'Widget', price: 50, image: 'w.png', qty: 1 } },
        },
      },
      wishlist: [],
      favoriteStores: ['other-store'],
    });

    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 1 }],
    }));

    const order = createOrder.mock.calls[0]![0] as { buyerId?: string };
    expect(order.buyerId).toBe('buyer-1');
    expect(saveUserCart).toHaveBeenCalledWith('buyer-1', {
      cart: {}, // the store's only item was purchased, so the whole store entry is dropped
      wishlist: [],
      favoriteStores: ['other-store'], // untouched by checkout
    });
  });
});
