import { describe, expect, it } from 'vitest';
import {
  DEMO_HIDE_AT_REAL_STORES,
  countRealStores,
  filterShopperStores,
  isDemoStore,
  realStores,
  showDemoStores,
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
