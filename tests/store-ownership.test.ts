import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Authorization guarantee for a seller's catalogue: a session says which STORES the account owns,
// never which store id or product id it may name in a form.
//
// The hole this closes (found 2026-08-06): `/api/product` bound both ids, but the no-JS fallback
// POST handlers in `seller/dashboard.astro` — kept alive on purpose by FormFallbackGuard — did
// not. `add-product` filed a product into whatever `storeId` the body carried; `edit-product`
// rewrote the name, PRICE and STOCK of whatever `productId` it carried; `delete-product` deleted
// it. Every one of those is cross-tenant, and the last two are reachable by any signed-in seller
// with nothing more than another store's product id.

const MY_STORE    = { id: 's1', slug: 'mine',   sellerId: 'seller-1' };
const OTHER_STORE = { id: 's2', slug: 'theirs', sellerId: 'seller-2' };

const PRODUCTS: Record<string, { id: string; storeId: string }> = {
  'p-mine':   { id: 'p-mine',   storeId: MY_STORE.id },
  'p-theirs': { id: 'p-theirs', storeId: OTHER_STORE.id },
};

vi.mock('../src/lib/stores.js', () => ({
  // seller-1 owns MY_STORE only; seller-2's store is never in their list.
  getStoresBySellerId: (id: string) => (id === 'seller-1' ? [MY_STORE] : id === 'seller-2' ? [OTHER_STORE] : []),
}));
vi.mock('../src/lib/store-products.js', () => ({
  getProductById: (id: string) => PRODUCTS[id] ?? null,
}));

const { ownedStore, ownedProduct } = await import('../src/lib/store-ownership.js');

describe('ownedStore', () => {
  it('returns the seller’s own store', async () => {
    expect(await ownedStore('seller-1', MY_STORE.id)).toEqual(MY_STORE);
  });

  it('refuses another seller’s store id', async () => {
    expect(await ownedStore('seller-1', OTHER_STORE.id)).toBeNull();
  });

  it('refuses a blank id instead of falling back to the first store', async () => {
    // The `?? stores[0]` this replaces meant a form that lost its storeId silently overwrote a
    // DIFFERENT shop of the same seller's — data loss with nothing on screen to explain it.
    expect(await ownedStore('seller-1', '')).toBeNull();
  });

  it('refuses an unknown id and a signed-out caller', async () => {
    expect(await ownedStore('seller-1', 'nope')).toBeNull();
    expect(await ownedStore('', MY_STORE.id)).toBeNull();
  });
});

describe('ownedProduct', () => {
  it('returns the product AND the store it lives in', async () => {
    const claim = await ownedProduct('seller-1', 'p-mine');
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.product.id).toBe('p-mine');
      expect(claim.store).toEqual(MY_STORE);
    }
  });

  it('refuses another seller’s product — this is the price/stock rewrite', async () => {
    expect(await ownedProduct('seller-1', 'p-theirs')).toEqual({ ok: false, reason: 'not-owned' });
  });

  it('keeps "missing" and "not yours" apart, because the callers answer 404 vs 403', async () => {
    expect(await ownedProduct('seller-1', 'ghost')).toEqual({ ok: false, reason: 'not-found' });
    expect(await ownedProduct('seller-1', '')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('is symmetric — seller-2 cannot reach seller-1’s product either', async () => {
    expect(await ownedProduct('seller-2', 'p-mine')).toEqual({ ok: false, reason: 'not-owned' });
    expect((await ownedProduct('seller-2', 'p-theirs')).ok).toBe(true);
  });
});

// The class guard, not just the three handlers that were broken: any page that writes to a
// catalogue has to settle ownership through the one module, so the NEXT surface added — another
// fallback form, a new route — fails here instead of shipping without a check.
describe('every catalogue-mutating page goes through store-ownership', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|astro)$/.test(e.name) ? [join(dir, e.name)] : []);
  }

  it('imports ownedStore/ownedProduct wherever it creates, updates or deletes a product', () => {
    const offenders = walk('src/pages').filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Admin routes act platform-wide by design and are authorized by the admin cookie.
      if (f.includes(`${join('pages', 'api', 'admin')}`)) return false;
      const mutates = /\b(createProduct|updateProduct|deleteProduct)\(/.test(src);
      return mutates && !/store-ownership\.js/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('never re-implements the check as an inline scan of the seller’s store list', () => {
    // The shape that rotted: the same three lines copy-pasted into every branch of every route,
    // so the branch that omitted them looked exactly like the branches that had them. Matching on
    // `getStoresBySellerId(…)` followed by a `.find`/`.some` on an id catches the copy coming back.
    // Resolving a store by SLUG (findStoreBySlugOrPrevious) is a different question and untouched.
    const offenders = walk('src/pages').filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /getStoresBySellerId\([^)]*\)\)?\s*\.(find|some)\(/.test(src)
        || /\.(find|some)\(\(s\) => s\.id === (storeId|product\.storeId)\)/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
