import { describe, it, expect } from 'vitest';
import { buildSellerFunnel } from '../src/lib/seller-funnel.js';

describe('buildSellerFunnel', () => {
  const sellers = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
  const stores = [
    { id: 'st1', sellerId: 's1', slug: 'shopa' },
    { id: 'st2', sellerId: 's2', slug: 'shopb' },
  ];
  const products = [{ storeId: 'st1' }]; // only st1 has a product
  const orders = [{ items: [{ storeSlug: 'shopa' }] }]; // only shopa made a sale

  it('counts how many sellers reached each onboarding stage', () => {
    const f = buildSellerFunnel(sellers, stores, products, orders, 10);
    expect(f).toEqual({
      registerViews: 10,
      registered: 3, // all seller accounts
      withStore: 2,  // s1, s2 (s3 never opened a store)
      withProduct: 1, // s1 (st2 is empty)
      withSale: 1,    // s1 (shopa sold; shopb never did)
    });
  });

  it('is monotonically non-increasing down the funnel (each stage ⊆ the one above)', () => {
    const f = buildSellerFunnel(sellers, stores, products, orders, 10);
    expect(f.registered).toBeGreaterThanOrEqual(f.withStore);
    expect(f.withStore).toBeGreaterThanOrEqual(f.withProduct);
    expect(f.withProduct).toBeGreaterThanOrEqual(f.withSale);
  });

  it('a seller with several stores counts once per stage, not once per store', () => {
    const multi = buildSellerFunnel(
      [{ id: 's1' }],
      [{ id: 'a', sellerId: 's1', slug: 'a' }, { id: 'b', sellerId: 's1', slug: 'b' }],
      [{ storeId: 'a' }, { storeId: 'b' }],
      [{ items: [{ storeSlug: 'a' }] }, { items: [{ storeSlug: 'b' }] }],
      0,
    );
    expect(multi).toMatchObject({ registered: 1, withStore: 1, withProduct: 1, withSale: 1 });
  });

  it('zero-fills an empty platform', () => {
    expect(buildSellerFunnel([], [], [], [], 0)).toEqual({
      registerViews: 0, registered: 0, withStore: 0, withProduct: 0, withSale: 0,
    });
  });
});
