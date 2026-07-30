import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';

/** Stock is the one field the seller writes as an ABSOLUTE number while the server writes it too:
 *  every sale decrements it. A number typed over a stale cell would put a sold unit back on the
 *  shelf — so the inline edits send the figure the cell displayed, and the write is refused when
 *  the stored value moved since. The full edit form is covered elsewhere (mergeByFieldRev).
 */

interface TestProduct {
  id: string; storeId: string; slug: string; name: string; price: number; stock: number;
  variants?: Array<{ name: string; options: string[] }>;
  variantStock?: Record<string, number>;
}

let PRODUCT: TestProduct;

const updateProduct = vi.fn((id: string, updates: Partial<TestProduct>) => {
  if (id !== PRODUCT.id) return null;
  PRODUCT = { ...PRODUCT, ...updates };
  return PRODUCT;
});

vi.mock('../src/lib/seller-auth.js', () => ({ getSellerSession: () => 'seller-1' }));
vi.mock('../src/lib/stores.js', () => ({
  getStoresBySellerId: () => [{ id: 's1', slug: 'test-store', sellerId: 'seller-1' }],
  getStoreBySlug: () => ({ id: 's1', slug: 'test-store', sellerId: 'seller-1' }),
}));
vi.mock('../src/lib/store-products.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/store-products.js')>()),
  getProductById: (id: string) => (id === PRODUCT.id ? PRODUCT : null),
  updateProduct: (id: string, updates: Partial<TestProduct>) => updateProduct(id, updates),
  isSkuTaken: () => false,
  countStockAlerts: () => 0,
  readProducts: () => [PRODUCT],
}));
vi.mock('../src/lib/notifications.js', () => ({
  createNotification: () => {},
  deleteNotificationsByRelatedIds: () => {},
}));
vi.mock('../src/lib/indexnow.js', () => ({ pingIndexNow: () => {} }));

const { POST } = await import('../src/pages/api/product.js');

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await POST({
    request: new Request('http://localhost/api/product', { method: 'POST', body: form }),
    cookies: { get: () => undefined },
  } as unknown as APIContext);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  PRODUCT = { id: 'p1', storeId: 's1', slug: 'widget', name: 'Widget', price: 10, stock: 19 };
});

describe('/api/product inline stock — compare-and-set', () => {
  it('writes the new stock when nothing moved since the cell was rendered', async () => {
    const { status, body } = await post({ _action: 'patch-product-fields', productId: 'p1', stock: '20', prevStock: '19' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(PRODUCT.stock).toBe(20);
  });

  // The bug this exists for: a purchase took stock 19 → 18 while the seller had the cell open. His
  // "20" describes a shelf that no longer exists, and writing it resurrects the sold unit.
  it('refuses the write when a sale moved stock in between, and reports the real number', async () => {
    PRODUCT.stock = 18;
    const { status, body } = await post({ _action: 'patch-product-fields', productId: 'p1', stock: '20', prevStock: '19' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, conflict: true, conflictFields: ['stock'], currentStock: 18 });
    expect(updateProduct).not.toHaveBeenCalled();
    expect(PRODUCT.stock).toBe(18); // untouched — the sold unit stays sold
  });

  it('still accepts a save from a client that sends no baseline (older bundle, additive change)', async () => {
    PRODUCT.stock = 18;
    const { status } = await post({ _action: 'patch-product-fields', productId: 'p1', stock: '20' });
    expect(status).toBe(200);
    expect(PRODUCT.stock).toBe(20);
  });

  it('does not gate a name or price inline edit — the server never writes those', async () => {
    const { status } = await post({ _action: 'patch-product-fields', productId: 'p1', price: '12' });
    expect(status).toBe(200);
    expect(PRODUCT.price).toBe(12);
  });
});

describe('/api/product per-combo stock — compare-and-set', () => {
  beforeEach(() => {
    PRODUCT = {
      id: 'p1', storeId: 's1', slug: 'shirt', name: 'Shirt', price: 20, stock: 7,
      variants: [{ name: 'Size', options: ['S', 'M'] }],
      variantStock: { 'Size=S': 4, 'Size=M': 3 },
    };
  });

  it('writes the combo and the recomputed total when nothing moved', async () => {
    const { status, body } = await post({ _action: 'patch-variant-stock', productId: 'p1', comboKey: 'Size=S', stock: '6', prevStock: '4' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, comboStock: 6, stock: 9 });
    expect(PRODUCT.variantStock).toEqual({ 'Size=S': 6, 'Size=M': 3 });
  });

  it('refuses when THAT combo sold in between, leaving the map untouched', async () => {
    PRODUCT.variantStock = { 'Size=S': 3, 'Size=M': 3 };
    const { status, body } = await post({ _action: 'patch-variant-stock', productId: 'p1', comboKey: 'Size=S', stock: '6', prevStock: '4' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ conflict: true, comboKey: 'Size=S', currentStock: 3 });
    expect(PRODUCT.variantStock).toEqual({ 'Size=S': 3, 'Size=M': 3 });
  });

  it('is not disturbed by a DIFFERENT combo selling in between', async () => {
    PRODUCT.variantStock = { 'Size=S': 4, 'Size=M': 1 };
    const { status } = await post({ _action: 'patch-variant-stock', productId: 'p1', comboKey: 'Size=S', stock: '6', prevStock: '4' });
    expect(status).toBe(200);
    expect(PRODUCT.variantStock).toEqual({ 'Size=S': 6, 'Size=M': 1 });
  });
});
