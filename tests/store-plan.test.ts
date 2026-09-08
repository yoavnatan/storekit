/**
 * A plan per shop, one charge — the arithmetic and the lapse.
 *
 * Both halves of the ruling of 2026-08-24 (*"כל חנות צריכה לעלות כסף בנפרד"*) fail QUIETLY if they
 * fail, which is why they are pinned here rather than left to the endpoint tests:
 *
 *  · a sum that drops a shop is a seller running a shop we never charge for, and every screen he
 *    and we look at still agrees with itself;
 *  · a cancellation that ends on the click takes back days somebody paid for;
 *  · a cancellation with no end at all is what the platform did until today — the card stopped and
 *    the shop stayed on the site, selling, for nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildStoreFeeLines, commissionPercentForStore, storeTier, totalFeeAgorot } from '../src/lib/store-plan.js';
import { DEFAULT_TIER, commissionPercentForTier, monthlyFeeForTier } from '../src/lib/pricing.js';
import { toAgorot } from '../src/lib/money.js';

describe('what a shop is on', () => {
  // ── One plan since 2026-09-08, and these two tests used to assert the opposite ──
  // `storeTier` answered the column and `commissionPercentForStore` answered that shop's own rate,
  // because a higher fee bought a lower rate. The commission went with the split (the seller clears
  // into his own account), and with it the only thing the four tiers differed in. What SURVIVES is
  // per-shop BILLING — every shop is a line and the standing order is their sum — which is the half
  // of the 2026-08-24 ruling that was never about the ladder.
  it('answers the one plan whatever the column holds, including a retired name', () => {
    // Real rows still carry `growth`/`pro`/`enterprise`. Falling back rather than throwing was
    // already the rule; it is now the only path, and a shop must still render and still be charged.
    for (const store of [{ tier: 'enterprise' }, { tier: 'growth' }, { tier: 'platinum' }, {}]) {
      expect(storeTier(store)).toBe(DEFAULT_TIER);
      expect(monthlyFeeForTier(storeTier(store))).toBeGreaterThan(0);
    }
  });

  it('charges no share of a sale, on any shop', () => {
    // The direction that used to be dangerous was a silent ZERO — a shop we forgot to take
    // commission from. It is now the rule, so the assertion is inverted and stated once, loudly:
    // nothing the platform bills is a percentage of what a buyer paid.
    for (const store of [{ tier: 'enterprise' }, {}, { tier: 'platinum' }]) {
      expect(commissionPercentForStore(store)).toBe(0);
    }
    expect(commissionPercentForTier('enterprise')).toBe(0);
  });
});

describe('the monthly charge', () => {
  const SHOPS = [
    { id: 'a', name: 'א', tier: 'growth' },
    { id: 'b', name: 'ב', tier: 'starter' },
    { id: 'c', name: 'ג' },
  ];

  it('is one line per shop, and every line is the one plan', () => {
    // The line-per-shop half of the ruling is what survives; "at that shop's own price" does not,
    // because there is one price. A shop dropped from this list is still a shop we never charge
    // for, with every screen agreeing with itself — which is why the count is asserted too.
    const lines = buildStoreFeeLines(SHOPS);
    expect(lines).toHaveLength(SHOPS.length);
    expect(lines.map((l) => l.tier)).toEqual([DEFAULT_TIER, DEFAULT_TIER, DEFAULT_TIER]);
    expect(lines[0]!.feeAgorot).toBe(toAgorot(monthlyFeeForTier(DEFAULT_TIER)));
  });

  // **The whole ruling, as one assertion.** Before it, three shops cost what one costs.
  it('is the SUM of them, not the price of one', () => {
    const total = totalFeeAgorot(buildStoreFeeLines(SHOPS));
    expect(total).toBe(SHOPS.length * toAgorot(monthlyFeeForTier(DEFAULT_TIER)));
    expect(total).toBeGreaterThan(toAgorot(monthlyFeeForTier(DEFAULT_TIER)));
  });

  // Agorot integers all the way, never a sum of shekel floats — the rounding `lib/money.ts` exists
  // to keep out of a figure a card is charged.
  it('sums in agorot, so the total is exact', () => {
    const total = totalFeeAgorot(buildStoreFeeLines(SHOPS));
    expect(Number.isInteger(total)).toBe(true);
  });

  it('is nothing at all for a seller with no shop on the site', () => {
    // Not a ₪0 charge — no charge. `startSubscription` answers `no-store-to-bill` rather than
    // opening a standing order PayMe would refuse anyway.
    expect(totalFeeAgorot(buildStoreFeeLines([]))).toBe(0);
  });
});

// ── The lapse ────────────────────────────────────────────────────────────────────────────────
const rig = vi.hoisted(() => ({
  stores: [] as { id: string; slug: string; name: string; publishedAt?: string; closedAt?: string; pausedAt?: string }[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  notified: [] as Record<string, unknown>[],
}));

vi.mock('../src/lib/db.js', () => ({ rows: async () => [], isUuid: () => true }));
vi.mock('../src/lib/stores.js', () => ({
  getStoresBySellerId: async () => rig.stores,
  updateStore: async (id: string, patch: Record<string, unknown>) => {
    rig.updates.push({ id, patch });
    const store = rig.stores.find((s) => s.id === id);
    // `publishedAt: undefined` is how `updateStore` is told to CLEAR the column — a present key
    // with an undefined value, which is not the same as an absent one (see its header).
    if (store && 'publishedAt' in patch) delete store.publishedAt;
    return store;
  },
}));
vi.mock('../src/lib/notifications.js', () => ({
  createNotification: async (n: Record<string, unknown>) => { rig.notified.push(n); return n; },
}));
vi.mock('../src/lib/ad-campaigns.js', () => ({ archiveCampaignsForStore: async () => 0 }));

const { lapseSellerStores } = await import('../src/lib/subscription-lapse.js');

beforeEach(() => {
  rig.stores = [{ id: 's1', slug: 'shop', name: 'החנות', publishedAt: '2026-01-01T00:00:00.000Z' }];
  rig.updates = [];
  rig.notified = [];
});

describe('when the paid period runs out', () => {
  /**
   * Back to `unpublished`, which is the state the shop was in before it was ever paid for: the
   * seller still previews it, the public does not see it, and one payment brings it back through
   * the sweep that already exists. A seventh lifecycle state would have said what the second says.
   */
  it('takes the shop off the site and tells the seller why', async () => {
    expect(await lapseSellerStores('seller-1')).toEqual(['shop']);
    expect(rig.updates).toEqual([{ id: 's1', patch: { publishedAt: undefined } }]);
    expect(rig.notified[0]).toMatchObject({ type: 'store_unpublished', role: 'seller', storeSlug: 'shop' });
  });

  // A paused shop is still ON the site — the storefront is up and says it is on hold
  // (`store-status.ts`), so it is still occupying the thing he stopped paying for.
  it('takes a paused shop down too', async () => {
    rig.stores[0]!.pausedAt = '2026-06-01T00:00:00.000Z';
    expect(await lapseSellerStores('seller-1')).toEqual(['shop']);
  });

  // It runs from a timer that can overlap itself, and a shop already down must not be reported
  // down again — nor notified again, which is what a seller would actually notice.
  it('is idempotent — a second pass does nothing at all', async () => {
    await lapseSellerStores('seller-1');
    rig.updates = [];
    rig.notified = [];
    expect(await lapseSellerStores('seller-1')).toEqual([]);
    expect(rig.updates).toEqual([]);
    expect(rig.notified).toEqual([]);
  });

  // A closed shop left of its own accord and is not on the site. Touching it would re-notify a
  // seller about a shop he shut himself, months ago.
  it('leaves a closed shop alone', async () => {
    rig.stores = [{ id: 's1', slug: 'shop', name: 'החנות', publishedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-05-01T00:00:00.000Z' }];
    expect(await lapseSellerStores('seller-1')).toEqual([]);
    expect(rig.updates).toEqual([]);
  });
});
