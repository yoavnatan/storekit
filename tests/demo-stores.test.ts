import { describe, expect, it } from 'vitest';
import {
  DEMO_HIDE_AT_REAL_STORES,
  countRealStores,
  filterShopperStores,
  isDemoStore,
  realStores,
  showDemoStores,
  splitDemoCarts,
} from '../src/lib/demo-stores.js';
import { LAUNCH_MODE_MAX_STORES, isLaunchMode } from '../src/lib/launch-mode.js';

// `demo` is spelled out on both so the fixtures share one type — `DemoFlagged` has
// only optional members, so a bare `{ id }` trips TS's weak-type check.
interface Fixture { id: string; demo?: boolean }
const demo = (id: string): Fixture => ({ id, demo: true });
const real = (id: string): Fixture => ({ id, demo: false });

describe('demo-store identification', () => {
  it('only an explicit flag counts', () => {
    expect(isDemoStore({ demo: true })).toBe(true);
    expect(isDemoStore({ demo: false })).toBe(false);
    expect(isDemoStore({})).toBe(false);
  });
});

describe('threshold counting', () => {
  it('never counts a showcase store toward the store count', () => {
    const stores = [demo('d1'), demo('d2'), demo('d3'), real('r1')];
    expect(countRealStores(stores)).toBe(1);
    expect(realStores(stores).map((s) => s.id)).toEqual(['r1']);
  });

  it('three showcase stores alone do not switch launch mode off', () => {
    // The bug this guards: counting them would take the mall out of launch mode,
    // which would then hide the very stores that were filling it.
    const onlyDemo = [demo('d1'), demo('d2'), demo('d3')];
    expect(isLaunchMode(countRealStores(onlyDemo))).toBe(true);
    expect(showDemoStores(countRealStores(onlyDemo))).toBe(true);
  });

  it('hides showcase stores at exactly the launch-mode threshold', () => {
    // Two independent numbers would leave a gap where the mall is out of launch
    // mode but the demo stores are still on the homepage.
    expect(DEMO_HIDE_AT_REAL_STORES).toBe(LAUNCH_MODE_MAX_STORES);
    expect(showDemoStores(DEMO_HIDE_AT_REAL_STORES - 1)).toBe(true);
    expect(showDemoStores(DEMO_HIDE_AT_REAL_STORES)).toBe(false);
    expect(showDemoStores(50)).toBe(false);
  });
});

describe('shopper discovery filter', () => {
  it('keeps showcase stores while the mall is thin', () => {
    const stores = [real('r1'), demo('d1'), demo('d2')];
    expect(filterShopperStores(stores).map((s) => s.id)).toEqual(['r1', 'd1', 'd2']);
  });

  it('drops them once there are enough real stores, preserving order', () => {
    const stores = [demo('d1'), ...Array.from({ length: DEMO_HIDE_AT_REAL_STORES }, (_, i) => real(`r${i}`))];
    expect(filterShopperStores(stores).every((s) => !isDemoStore(s))).toBe(true);
    expect(filterShopperStores(stores)).toHaveLength(DEMO_HIDE_AT_REAL_STORES);
  });

  it('decides from the real count, not the total — demo stores never hide themselves', () => {
    // Enough entries to clear the threshold, but every one of them is a demo store.
    const stores = Array.from({ length: DEMO_HIDE_AT_REAL_STORES + 2 }, (_, i) => demo(`d${i}`));
    expect(filterShopperStores(stores)).toHaveLength(stores.length);
  });

  it('is a copy, never the caller’s array', () => {
    const stores = [demo('d1')];
    expect(filterShopperStores(stores)).not.toBe(stores);
  });

  it('handles an empty mall', () => {
    expect(filterShopperStores([])).toEqual([]);
    expect(countRealStores([])).toBe(0);
  });
});

describe('checkout cart split (a demo item must not block a real one)', () => {
  const isDemoSlug = (slug: string) => slug.startsWith('showcase-');
  const cart = (storeSlug: string) => ({ storeSlug });

  it('keeps a real store payable when a showcase store sits next to it', () => {
    const { payable, viewOnly } = splitDemoCarts(
      [cart('showcase-fashion'), cart('yoavs-store')],
      isDemoSlug,
    );
    expect(payable).toEqual([cart('yoavs-store')]);
    expect(viewOnly).toEqual([cart('showcase-fashion')]);
  });

  it('leaves nothing payable when the cart is showcase-only — the one case that still refuses', () => {
    const { payable, viewOnly } = splitDemoCarts([cart('showcase-tech'), cart('showcase-home')], isDemoSlug);
    expect(payable).toEqual([]);
    expect(viewOnly).toHaveLength(2);
  });

  it('touches nothing when no showcase store is involved', () => {
    const carts = [cart('a'), cart('b')];
    const { payable, viewOnly } = splitDemoCarts(carts, isDemoSlug);
    expect(payable).toEqual(carts);
    expect(viewOnly).toEqual([]);
  });

  it('preserves order within each side, so the rendered cart keeps its store order', () => {
    const { payable, viewOnly } = splitDemoCarts(
      [cart('b'), cart('showcase-x'), cart('a'), cart('showcase-y')],
      isDemoSlug,
    );
    expect(payable.map((c) => c.storeSlug)).toEqual(['b', 'a']);
    expect(viewOnly.map((c) => c.storeSlug)).toEqual(['showcase-x', 'showcase-y']);
  });

  it('handles an empty cart', () => {
    expect(splitDemoCarts([], isDemoSlug)).toEqual({ payable: [], viewOnly: [] });
  });
});

describe('a real store with nothing to sell does not count toward "enough real stores"', () => {
  const demo = (id: string) => ({ id, demo: true });
  const real = (id: string) => ({ id, demo: false });

  it('keeps the showcase stores when the five real ones are all empty', () => {
    // The bug this pins, seen live on 2026-08-18: seven product-less stores appeared in the dev
    // database and the homepage emptied out. `filterShopperStores` counted stores that EXIST while
    // launch mode counted stores with PRODUCTS, so the showcase stores — which are there to fill a
    // thin mall — left, and five empty ones stayed in their place.
    const stores = [demo('d1'), demo('d2'), real('r1'), real('r2'), real('r3'), real('r4'), real('r5')];
    expect(filterShopperStores(stores, 0).map((s) => s.id)).toContain('d1');
    expect(filterShopperStores(stores, 1).map((s) => s.id)).toContain('d1');
  });

  it('drops them once that many real stores can actually sell', () => {
    const stores = [demo('d1'), real('r1'), real('r2'), real('r3'), real('r4'), real('r5')];
    expect(filterShopperStores(stores, 5).map((s) => s.id)).not.toContain('d1');
  });

  it('falls back to counting stores when no live count is given', () => {
    // The parameter is optional so a caller with no product data degrades to the old behaviour
    // instead of crashing — but every discovery surface passes it.
    const stores = [demo('d1'), real('r1'), real('r2'), real('r3'), real('r4'), real('r5')];
    expect(filterShopperStores(stores).map((s) => s.id)).not.toContain('d1');
  });
});

describe('a store needs a shelf, not a single item, to count as live', () => {
  it('is five visible products (owner, 2026-08-18)', async () => {
    const { LIVE_STORE_MIN_PRODUCTS, isLiveStore } = await import('../src/lib/demo-stores.js');
    expect(LIVE_STORE_MIN_PRODUCTS).toBe(5);
    expect(isLiveStore({ productCount: 4 })).toBe(false);
    expect(isLiveStore({ productCount: 5 })).toBe(true);
  });

  it('does not count a store with one product', async () => {
    // The bar used to be `hasProducts`, which is the right question for drawing a CARD and the
    // wrong one for "is the mall full enough to drop the showcase stores". Five stores holding one
    // item each would have emptied the homepage while technically filling it.
    const { isLiveStore } = await import('../src/lib/demo-stores.js');
    expect(isLiveStore({ productCount: 1 })).toBe(false);
  });

  it('treats a missing preview as not live rather than crashing', async () => {
    const { isLiveStore } = await import('../src/lib/demo-stores.js');
    expect(isLiveStore(undefined)).toBe(false);
    expect(isLiveStore({})).toBe(false);
  });

  it('is the ONE definition — no discovery page compares productCount itself', async () => {
    // Two pages with their own literal is how they start disagreeing about what a real store is,
    // which is the bug this whole thread began with.
    const fs = await import('node:fs');
    for (const page of ['src/pages/index.astro', 'src/pages/stores.astro']) {
      const src = fs.readFileSync(page, 'utf8');
      expect(src, `${page} should ask isLiveStore()`).toMatch(/isLiveStore\(/);
      expect(src, `${page} compares productCount by hand`).not.toMatch(/productCount\s*[><]=?\s*\d/);
    }
  });

  it('and both thresholds on a page read the same number', async () => {
    // launch mode and the demo-hiding rule counted different things until 2026-08-18; five empty
    // stores fell into the gap between them.
    const fs = await import('node:fs');
    for (const page of ['src/pages/index.astro', 'src/pages/stores.astro']) {
      expect(fs.readFileSync(page, 'utf8')).toMatch(/const liveStoreCount = liveRealCount;/);
    }
  });
});
