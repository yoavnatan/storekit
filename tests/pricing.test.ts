import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blendedCommissionRate, commissionPercentForTier, DEFAULT_TIER, monthlyFeeForTier, resolveTier, SELLER_TIERS, boostFeePercent, AD_PLATFORM_MARGIN_PERCENT } from '../src/lib/pricing.js';
import { buildPlatformStoreInputs } from '../src/lib/platform-performance.js';

describe('tier table shape', () => {
  it('keeps the decided model: a higher fixed fee always buys a lower commission', () => {
    for (let i = 1; i < SELLER_TIERS.length; i++) {
      const prev = SELLER_TIERS[i - 1]!;
      const curr = SELLER_TIERS[i]!;
      expect(curr.monthlyFee).toBeGreaterThan(prev.monthlyFee);
      expect(curr.commissionPercent).toBeLessThan(prev.commissionPercent);
    }
  });

  it('gives every tier a revenue band where it wins — upgrade break-evens must rise', () => {
    // Break-even between neighbouring tiers = (fee delta) / (commission delta). If a later
    // break-even were LOWER than an earlier one, the middle tier would be strictly dominated:
    // every seller rich enough to leave it should already have skipped past it. See pricing.ts.
    const breakEvens: number[] = [];
    for (let i = 1; i < SELLER_TIERS.length; i++) {
      const prev = SELLER_TIERS[i - 1]!;
      const curr = SELLER_TIERS[i]!;
      breakEvens.push((curr.monthlyFee - prev.monthlyFee) / ((prev.commissionPercent - curr.commissionPercent) / 100));
    }
    for (let i = 1; i < breakEvens.length; i++) {
      expect(breakEvens[i]).toBeGreaterThan(breakEvens[i - 1]!);
    }
  });

  it('has a default tier that actually exists in the table', () => {
    expect(SELLER_TIERS.some((t) => t.id === DEFAULT_TIER)).toBe(true);
  });
});

describe('resolveTier', () => {
  it('resolves a known tier', () => {
    expect(resolveTier('pro').id).toBe('pro');
  });

  it('falls back to the default for absent / unknown / junk values rather than throwing', () => {
    for (const bad of [undefined, null, '', 'platinum', 'STARTER']) {
      expect(resolveTier(bad).id).toBe(DEFAULT_TIER);
    }
  });
});

describe('commissionPercentForTier / monthlyFeeForTier', () => {
  it('reads both numbers off the seller tier', () => {
    const pro = SELLER_TIERS.find((t) => t.id === 'pro')!;
    expect(commissionPercentForTier('pro')).toBe(pro.commissionPercent);
    expect(monthlyFeeForTier('pro')).toBe(pro.monthlyFee);
  });

  it('a seller with no tier recorded is charged the default tier, not zero', () => {
    const def = resolveTier(DEFAULT_TIER);
    expect(commissionPercentForTier(undefined)).toBe(def.commissionPercent);
    expect(monthlyFeeForTier(undefined)).toBe(def.monthlyFee);
  });
});

describe('blendedCommissionRate', () => {
  it('reports the revenue-weighted actual, not any single tier rate', () => {
    // 1000₪ at 12% (120) + 1000₪ at 4% (40) = 160 of 2000 → 8%.
    expect(blendedCommissionRate(2000, 160)).toBe(8);
  });

  it('returns 0 on zero revenue instead of NaN', () => {
    expect(blendedCommissionRate(0, 0)).toBe(0);
    expect(blendedCommissionRate(-5, 10)).toBe(0);
  });
});

describe('buildPlatformStoreInputs', () => {
  // `id` is carried through because page-view statistics are gathered under it, not under the
  // slug — a store that renames its URL must not lose its traffic history.
  const stores = [
    { id: 'id-a', slug: 'a', name: 'A', sellerId: 's1' },
    { id: 'id-b', slug: 'b', name: 'B', sellerId: 's2', blocked: true },
    { id: 'id-c', slug: 'c', name: 'C', sellerId: 'ghost' },
  ];
  const sellers = [{ id: 's1', tier: 'enterprise' }, { id: 's2' }];

  it('gives each store its OWN seller tier rate', () => {
    const out = buildPlatformStoreInputs(stores, sellers);
    expect(out[0]!.commissionPercent).toBe(commissionPercentForTier('enterprise'));
    expect(out[1]!.commissionPercent).toBe(commissionPercentForTier(DEFAULT_TIER));
  });

  it('falls back to the default tier for a store whose seller record is missing', () => {
    expect(buildPlatformStoreInputs(stores, sellers)[2]!.commissionPercent)
      .toBe(commissionPercentForTier(DEFAULT_TIER));
  });

  it('carries slug/name/blocked through untouched', () => {
    const out = buildPlatformStoreInputs(stores, sellers);
    expect(out[1]).toMatchObject({ slug: 'b', name: 'B', blocked: true });
  });

  it('two sellers on different tiers produce different rates — the whole point', () => {
    const out = buildPlatformStoreInputs(stores, sellers);
    expect(out[0]!.commissionPercent).not.toBe(out[1]!.commissionPercent);
  });
});

/** The fee a seller is TOLD about and the fee the platform BOOKS have to be one number. They were
 *  two: the books took AD_PLATFORM_MARGIN_PERCENT while the dashboard read a config field left
 *  `null` for "not decided", so the seller saw a vague sentence while 15% was already charged. */
describe('boostFeePercent', () => {
  it('falls back to the percentage the platform actually books', () => {
    expect(boostFeePercent(null)).toBe(AD_PLATFORM_MARGIN_PERCENT);
    expect(boostFeePercent(undefined)).toBe(AD_PLATFORM_MARGIN_PERCENT);
  });

  it('lets a configured override win — that is what the config field is for', () => {
    expect(boostFeePercent(9)).toBe(9);
    expect(boostFeePercent(0)).toBe(0);
  });

  it('ignores a nonsense override rather than showing it to a seller', () => {
    expect(boostFeePercent(-3)).toBe(AD_PLATFORM_MARGIN_PERCENT);
    expect(boostFeePercent(Number.NaN)).toBe(AD_PLATFORM_MARGIN_PERCENT);
  });
});

describe('the tier prices are quoted BEFORE VAT, and the two conventions disagree on purpose', () => {
  it('states the convention where the numbers live', () => {
    // Worth 18% of the platform's revenue and written down nowhere until 2026-08-18. The decision
    // (owner): a seller reclaims the VAT, so it costs him nothing and it is ours to keep — which is
    // also how our own suppliers quote us.
    const src = readFileSync('src/lib/pricing.ts', 'utf8');
    expect(src).toMatch(/BEFORE VAT/);
  });

  it('keeps lib/vat.ts saying the OPPOSITE, because it governs a different payer', () => {
    // vat.ts is about CONSUMER prices — an Israeli shopper is quoted what they will pay. pricing.ts
    // is a B2B fee. Anyone who "unifies" the two makes one of them wrong, and which one depends on
    // who is being charged. This pins that the disagreement is deliberate.
    expect(readFileSync('src/lib/vat.ts', 'utf8')).toMatch(/VAT-INCLUSIVE/);
  });
});
