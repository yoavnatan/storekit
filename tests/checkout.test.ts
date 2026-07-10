import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';
import type { UserCartData } from '../src/lib/user-carts.js';

const PRODUCTS: Record<string, { id: string; slug: string; name: string; price: number; images?: string[] }> = {
  widget: { id: 'p1', slug: 'widget', name: 'Widget', price: 50, images: ['w.png'] },
};

const STORES: Record<string, { id: string; slug: string; name: string; sellerId: string; shipping?: { flatRate: number; freeAbove: number | null; processingDays: number } }> = {
  'test-store': {
    id: 's1',
    slug: 'test-store',
    name: 'Test Store',
    sellerId: 'seller-1',
    shipping: { flatRate: 20, freeAbove: 100, processingDays: 2 },
  },
};

const createOrder = vi.fn((input: Record<string, unknown>) => ({ id: 'order-1', ...input }));
const createNotification = vi.fn();
const getSellerSession = vi.fn(() => null as string | null);
const getUserCart = vi.fn((_id: string): UserCartData => ({ cart: {}, wishlist: [], favoriteStores: [] }));
const saveUserCart = vi.fn();

vi.mock('../src/lib/stores.js', () => ({
  getStoreBySlug: (slug: string) => STORES[slug] ?? null,
}));
vi.mock('../src/lib/store-products.js', () => ({
  getProductBySlug: (_storeId: string, slug: string) => PRODUCTS[slug] ?? null,
}));
vi.mock('../src/lib/orders.js', () => ({ createOrder: (input: Record<string, unknown>) => createOrder(input) }));
vi.mock('../src/lib/notifications.js', () => ({ createNotification: (input: Record<string, unknown>) => createNotification(input) }));
vi.mock('../src/lib/seller-auth.js', () => ({ getSellerSession: () => getSellerSession() }));
vi.mock('../src/lib/user-carts.js', () => ({
  getUserCart: (id: string) => getUserCart(id),
  saveUserCart: (id: string, data: unknown) => saveUserCart(id, data),
}));

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
    // real price (50) + flat shipping (20), never the spoofed price of 1
    expect(order.storeSubtotals['test-store']!.subtotal).toBe(50);
    expect(order.totalAmount).toBe(70);
  });

  it('waives shipping once the store subtotal reaches its freeAbove threshold', async () => {
    await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'widget', qty: 2 }], // 100, hits freeAbove
    }));
    const order = createOrder.mock.calls[0]![0] as { totalAmount: number; shippingAmount: number };
    expect(order.shippingAmount).toBe(0);
    expect(order.totalAmount).toBe(100);
  });

  it('rejects an unknown product instead of trusting client-supplied item data', async () => {
    const res = await POST(makeContext({
      ...validBuyer,
      items: [{ storeSlug: 'test-store', productSlug: 'does-not-exist', qty: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
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
