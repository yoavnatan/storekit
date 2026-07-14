import { describe, expect, it } from 'vitest';
import { isStoreIncomplete } from '../src/lib/admin-stats.js';
import type { Store } from '../src/lib/stores.js';

function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    id: 's1',
    sellerId: 'seller1',
    slug: 'my-store',
    name: 'My Store',
    tagline: '',
    description: '',
    colors: { primary: '#000', accent: '#000' },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isStoreIncomplete', () => {
  it('is complete when it has products and shipping configured', () => {
    const store = makeStore({ shipping: { flatRate: 20, freeAbove: 200, processingDays: 2 } });
    expect(isStoreIncomplete(store, 5)).toBe(false);
  });

  it('is incomplete when it has zero products, even with shipping configured', () => {
    const store = makeStore({ shipping: { flatRate: 20, freeAbove: 200, processingDays: 2 } });
    expect(isStoreIncomplete(store, 0)).toBe(true);
  });

  it('is incomplete when shipping was never configured, even with products', () => {
    const store = makeStore();
    expect(isStoreIncomplete(store, 5)).toBe(true);
  });
});
