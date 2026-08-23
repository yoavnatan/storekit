import { describe, expect, it, vi } from 'vitest';

/** /api/cart/prices is what lets a stored cart correct itself before the pay button: it answers
 *  each line with the price /api/checkout would charge AND the stock it would decrement. Both
 *  answers have the same requirement — they must describe the exact line asked about, because a
 *  number belonging to a sibling variant is worse than no number at all. */

const PRODUCTS: Record<string, {
  id: string; slug: string; name: string; price: number; stock: number;
  // `options`, not `values` — the field `VariantDimension` actually declares. The fixture said
  // `values` and nothing noticed, because until the route resolved a selection against the product
  // nothing here read the option list at all; it only ever counted the dimensions.
  variants?: Array<{ name: string; options: string[] }>;
  variantStock?: Record<string, number>;
  hidden?: boolean;
}> = {
  widget: { id: 'p1', slug: 'widget', name: 'Widget', price: 50, stock: 7 },
  shirt: {
    id: 'p2', slug: 'shirt', name: 'Shirt', price: 80, stock: 99,
    variants: [{ name: 'Color', options: ['Red', 'Blue'] }],
    variantStock: { 'Color=Red': 2, 'Color=Blue': 0 }, // comboKey's format (variant-combo.ts)
  },
};

// `publishedAt` is stated: `store-status.ts` reads its absence as "built and never published", and
// every case here is about a cart line in a store a shopper can actually buy from.
const STORE = { id: 's1', slug: 'test-store', name: 'Test Store', sellerId: 'seller-1', publishedAt: '2026-01-01T00:00:00.000Z' };

// Lookup stubbed, lifecycle rule REAL (store-status.js is pure) — same reason as the
// store-products mock below: a hand-written `() => true` would have kept this suite green after
// the route moved from "is the store reachable" to "may it still sell".
vi.mock('../src/lib/stores.js', async () => {
  const status = await import('../src/lib/store-status.js');
  return {
    ...status,
    getStoreBySlugOrPrevious: (slug: string) => (slug === STORE.slug ? STORE : null),
    isStoreVisible: status.isStoreReachable,
  };
});
// Only the file-reading lookups are replaced. `getEffectiveStock` stays REAL: it is the pure
// function that decides which bucket a line reads, and re-implementing it here would let this test
// keep passing after the real resolution changed — which is the one thing it exists to catch.
vi.mock('../src/lib/store-products.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/store-products.js')>()),
  getProductBySlug: (_storeId: string, slug: string) => PRODUCTS[slug] ?? null,
  isProductVisible: (p: { hidden?: boolean }) => !p.hidden,
}));

const { POST } = await import('../src/pages/api/cart/prices.js');

async function ask(items: unknown[]) {
  const res = await POST({
    request: new Request('http://localhost/api/cart/prices', { method: 'POST', body: JSON.stringify({ items }) }),
  } as Parameters<typeof POST>[0]);
  return (await res.json()) as { ok: boolean; items: Array<Record<string, unknown>> };
}

describe('POST /api/cart/prices — stock alongside price', () => {
  it('answers a plain line with the units actually available', async () => {
    const body = await ask([{ storeSlug: STORE.slug, slug: 'widget' }]);
    expect(body.items[0]).toMatchObject({ slug: 'widget', price: 50, stock: 7 });
  });

  it('answers a variant line from ITS combo bucket, not the shared pool', async () => {
    const body = await ask([{ storeSlug: STORE.slug, slug: 'shirt', selectedVariants: { Color: 'Red' } }]);
    expect(body.items[0]).toMatchObject({ stock: 2, selectedVariants: { Color: 'Red' } });
  });

  it('reports zero for a combo that sold out while the rest of the product is still in stock', async () => {
    const body = await ask([{ storeSlug: STORE.slug, slug: 'shirt', selectedVariants: { Color: 'Blue' } }]);
    expect(body.items[0]!.stock).toBe(0);
  });

  // The shared pool (99 here) is not any one combo's ceiling. Sending it would let the cart offer
  // units that don't exist for the line the buyer actually holds.
  it('withholds stock entirely for a variant product the request did not identify', async () => {
    const body = await ask([{ storeSlug: STORE.slug, slug: 'shirt' }]);
    expect(body.items[0]).toMatchObject({ price: 80 });
    expect(body.items[0]!.stock).toBeUndefined();
  });

  it('still says nothing but `gone` for a product that is no longer purchasable', async () => {
    PRODUCTS.widget!.hidden = true;
    try {
      const body = await ask([{ storeSlug: STORE.slug, slug: 'widget' }]);
      expect(body.items[0]).toEqual({ storeSlug: STORE.slug, slug: 'widget', price: 0, gone: true });
    } finally {
      delete PRODUCTS.widget!.hidden;
    }
  });

  it('ignores a malformed selectedVariants instead of trusting it as a combo', async () => {
    const body = await ask([{ storeSlug: STORE.slug, slug: 'shirt', selectedVariants: ['Color', 'Red'] }]);
    expect(body.items[0]!.stock).toBeUndefined(); // treated as "no combo named", not as a bucket
    expect(body.items[0]!.selectedVariants).toBeUndefined();
  });
});
