import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreProduct } from '../src/lib/store-products.js';

let db: StoreProduct[] = [];

vi.mock('node:fs', () => ({
  default: {
    readFileSync: () => JSON.stringify(db),
    writeFileSync: (_path: string, data: string) => { db = JSON.parse(data); },
  },
}));

const { decrementStock, restockProduct, getEffectiveStock, isProductVisible, countStockAlerts } = await import('../src/lib/store-products.js');

beforeEach(() => {
  db = [
    { id: 'p1', storeId: 's1', slug: 'widget', name: 'Widget', description: '', price: 10, stock: 5, createdAt: '2026-01-01T00:00:00.000Z' },
    {
      id: 'p2', storeId: 's1', slug: 'shirt', name: 'Shirt', description: '', price: 20, stock: 3, createdAt: '2026-01-01T00:00:00.000Z',
      variants: [{ name: 'Size', options: ['S', 'M'] }],
      variantStock: { 'Size=S': 2 },
    },
  ];
});

describe('decrementStock', () => {
  it('decrements a plain (non-variant) product stock and returns ok with before/after', async () => {
    const result = await decrementStock('p1', 2);
    expect(result).toEqual({ ok: true, before: 5, after: 3 });
    expect(db.find((p) => p.id === 'p1')!.stock).toBe(3);
  });

  it('returns ok:false and leaves stock untouched when qty exceeds available stock', async () => {
    const result = await decrementStock('p1', 6);
    expect(result.ok).toBe(false);
    expect(db.find((p) => p.id === 'p1')!.stock).toBe(5);
  });

  it('decrements exactly to zero when qty equals available stock', async () => {
    const result = await decrementStock('p1', 5);
    expect(result).toEqual({ ok: true, before: 5, after: 0 });
    expect(db.find((p) => p.id === 'p1')!.stock).toBe(0);
  });

  it('decrements the matching variant-combo bucket when one exists, not the shared stock pool', async () => {
    const result = await decrementStock('p2', 1, { Size: 'S' });
    expect(result).toEqual({ ok: true, before: 2, after: 1 });
    const product = db.find((p) => p.id === 'p2')!;
    expect(product.variantStock).toEqual({ 'Size=S': 1 });
    expect(product.stock).toBe(3); // shared pool untouched
  });

  it('falls back to the shared stock pool for a combo with no variantStock override', async () => {
    const result = await decrementStock('p2', 1, { Size: 'M' });
    expect(result).toEqual({ ok: true, before: 3, after: 2 });
    const product = db.find((p) => p.id === 'p2')!;
    expect(product.stock).toBe(2);
    expect(product.variantStock).toEqual({ 'Size=S': 2 }); // untouched
  });

  it('returns ok:false for an unknown product id', async () => {
    const result = await decrementStock('does-not-exist', 1);
    expect(result.ok).toBe(false);
  });

  it('serializes concurrent decrements so they never oversell a product with stock for only one', async () => {
    const [a, b] = await Promise.all([decrementStock('p1', 5), decrementStock('p1', 5)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(db.find((p) => p.id === 'p1')!.stock).toBe(0);
  });
});

describe('restockProduct', () => {
  it('reverses a decrement back onto the same bucket it came from', async () => {
    await decrementStock('p2', 1, { Size: 'S' });
    const result = await restockProduct('p2', 1, { Size: 'S' });
    expect(result).toEqual({ ok: true, before: 1, after: 2 });
    expect(db.find((p) => p.id === 'p2')!.variantStock).toEqual({ 'Size=S': 2 });
  });
});

describe('getEffectiveStock', () => {
  it('reads the flat stock field for a non-variant product', () => {
    expect(getEffectiveStock(db.find((p) => p.id === 'p1')!)).toBe(5);
  });

  it('reads the variantStock override for a selected combo that has one', () => {
    const product = db.find((p) => p.id === 'p2')!;
    expect(getEffectiveStock(product, { Size: 'S' })).toBe(2);
  });

  it('falls back to the shared stock pool for a combo with no override', () => {
    const product = db.find((p) => p.id === 'p2')!;
    expect(getEffectiveStock(product, { Size: 'M' })).toBe(3);
  });
});

describe('isProductVisible', () => {
  it('is visible for a plain product', () => {
    expect(isProductVisible({ id: 'x', storeId: 's1', slug: 'x', name: 'X', description: '', price: 1, stock: 1, createdAt: '' })).toBe(true);
  });

  it('is hidden for an admin-blocked product', () => {
    expect(isProductVisible({ id: 'x', storeId: 's1', slug: 'x', name: 'X', description: '', price: 1, stock: 1, createdAt: '', blocked: true })).toBe(false);
  });

  it('is hidden for a seller-hidden product (the new take-down switch)', () => {
    expect(isProductVisible({ id: 'x', storeId: 's1', slug: 'x', name: 'X', description: '', price: 1, stock: 1, createdAt: '', hidden: true })).toBe(false);
  });
});

describe('countStockAlerts', () => {
  beforeEach(() => {
    db = [
      { id: 'a', storeId: 's1', slug: 'a', name: 'A', description: '', price: 1, stock: 0, createdAt: '' },   // out of stock → alert
      { id: 'b', storeId: 's1', slug: 'b', name: 'B', description: '', price: 1, stock: 2, createdAt: '' },   // low (<=3) → alert
      { id: 'c', storeId: 's1', slug: 'c', name: 'C', description: '', price: 1, stock: 50, createdAt: '' },  // healthy → no alert
      { id: 'd', storeId: 's1', slug: 'd', name: 'D', description: '', price: 1, stock: 0, createdAt: '', hidden: true },  // out but hidden → excluded
      { id: 'e', storeId: 's1', slug: 'e', name: 'E', description: '', price: 1, stock: 0, createdAt: '', blocked: true }, // out but blocked → excluded
      { id: 'f', storeId: 's2', slug: 'f', name: 'F', description: '', price: 1, stock: 0, createdAt: '' },   // other store → excluded
    ];
  });

  it('counts only on-sale products of the store that are out of / low on stock', () => {
    expect(countStockAlerts('s1', 3)).toBe(2); // a + b
  });

  it('drops to zero once the low/out products are hidden', () => {
    db.forEach((p) => { if (p.storeId === 's1' && p.stock <= 3) p.hidden = true; });
    expect(countStockAlerts('s1', 3)).toBe(0);
  });
});
