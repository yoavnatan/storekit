import { describe, it, expect } from 'vitest';
import { buildSellerFunnel } from '../src/lib/seller-funnel.js';

describe('buildSellerFunnel', () => {
  const sellers = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
  const stores = [
    { id: 'st1', sellerId: 's1', slug: 'shopa', publishedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'st2', sellerId: 's2', slug: 'shopb' },
  ];
  const products = [{ storeId: 'st1' }]; // only st1 has a product
  const orders = [{ items: [{ storeSlug: 'shopa' }] }]; // only shopa made a sale
  /** The paying half. s2 sent his details and is still waiting; s1 went the whole way. */
  const money = {
    sentClearing: new Set(['s1', 's2']),
    approved: new Set(['s1']),
    subscribed: new Set(['s1']),
  };

  it('counts how many sellers reached each onboarding stage', () => {
    const f = buildSellerFunnel(sellers, stores, products, orders, 10, money);
    expect(f).toEqual({
      registerViews: 10,
      registered: 3, // all seller accounts
      withStore: 2,  // s1, s2 (s3 never opened a store)
      withProduct: 1, // s1 (st2 is empty)
      sentClearing: 2, // s1, s2 — both sent PayMe their details
      approved: 1,     // s1 only; s2 is inside the seven-day wait
      subscribed: 1,   // s1
      live: 1,         // shopa is on the site, shopb is not
      withSale: 1,     // s1 (shopa sold; shopb never did)
    });
  });

  /**
   * The money half is asked of the SELLER and answered as three independent sets, which is why the
   * builder cannot infer one from another: a seller can be approved and not subscribed, and — mid
   * dunning — subscribed and not approved. So a seller who is in a lower set but not a higher one
   * is a real state, and the only thing the funnel guarantees is that nobody counts who never
   * opened a store.
   */
  it('counts nobody at a money stage who never opened a store', () => {
    const f = buildSellerFunnel(sellers, stores, products, orders, 0, {
      sentClearing: new Set(['s1', 's2', 's3']),
      approved: new Set(['s3']),
      subscribed: new Set(['s3']),
    });
    // s3 registered and stopped. Whatever a merchant table says about him, he is not in this funnel
    // past "opened a store" — otherwise a stage below the one above it would read higher than it.
    expect(f.sentClearing).toBe(2);
    expect(f.approved).toBe(0);
    expect(f.subscribed).toBe(0);
  });

  it('is monotonically non-increasing down the funnel (each stage ⊆ the one above)', () => {
    const f = buildSellerFunnel(sellers, stores, products, orders, 10, money);
    expect(f.registered).toBeGreaterThanOrEqual(f.withStore);
    expect(f.withStore).toBeGreaterThanOrEqual(f.withProduct);
    expect(f.withStore).toBeGreaterThanOrEqual(f.sentClearing);
    expect(f.sentClearing).toBeGreaterThanOrEqual(f.approved);
    expect(f.withStore).toBeGreaterThanOrEqual(f.live);
    expect(f.withStore).toBeGreaterThanOrEqual(f.withSale);
  });

  it('a seller with several stores counts once per stage, not once per store', () => {
    const multi = buildSellerFunnel(
      [{ id: 's1' }],
      [
        { id: 'a', sellerId: 's1', slug: 'a', publishedAt: '2026-08-01T00:00:00.000Z' },
        { id: 'b', sellerId: 's1', slug: 'b', publishedAt: '2026-08-02T00:00:00.000Z' },
      ],
      [{ storeId: 'a' }, { storeId: 'b' }],
      [{ items: [{ storeSlug: 'a' }] }, { items: [{ storeSlug: 'b' }] }],
      0,
      { sentClearing: new Set(['s1']), approved: new Set(['s1']), subscribed: new Set(['s1']) },
    );
    // Two shops, two plans, two lines on one standing order (`lib/store-plan.ts`) — and still ONE
    // seller at every stage of this funnel, because the funnel's subject is the person.
    expect(multi).toMatchObject({ registered: 1, withStore: 1, withProduct: 1, subscribed: 1, live: 1, withSale: 1 });
  });

  it('zero-fills an empty platform', () => {
    expect(buildSellerFunnel([], [], [], [], 0)).toEqual({
      registerViews: 0, registered: 0, withStore: 0, withProduct: 0,
      sentClearing: 0, approved: 0, subscribed: 0, live: 0, withSale: 0,
    });
  });
});
