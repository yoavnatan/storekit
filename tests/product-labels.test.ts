import { describe, expect, it } from 'vitest';
import { deriveProductLabels, LABEL_SLOTS } from '../src/lib/product-labels.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z'; // 5 months before NOW → past the "new" window
const RECENT = '2026-05-20T00:00:00.000Z'; // 12 days before NOW → inside the "new" window

function base(overrides: Record<string, unknown> = {}) {
  return { price: 200, stock: 20, createdAt: OLD, audienceTexts: [], nowMs: NOW, ...overrides } as Parameters<typeof deriveProductLabels>[0];
}

describe('deriveProductLabels — stable positional slots', () => {
  it('always returns one value per slot, in order', () => {
    const out = deriveProductLabels(base());
    expect(out).toHaveLength(LABEL_SLOTS.length);
  });

  it('price_tier: budget / mid / premium by price', () => {
    expect(deriveProductLabels(base({ price: 40 }))[0]).toBe('budget');
    expect(deriveProductLabels(base({ price: 200 }))[0]).toBe('mid');
    expect(deriveProductLabels(base({ price: 900 }))[0]).toBe('premium');
  });

  it('availability: out_of_stock / low_stock / in_stock', () => {
    expect(deriveProductLabels(base({ stock: 0 }))[2]).toBe('out_of_stock');
    expect(deriveProductLabels(base({ stock: 3 }))[2]).toBe('low_stock');
    expect(deriveProductLabels(base({ stock: 50 }))[2]).toBe('in_stock');
  });

  it('performance escalates by units, with recency as the fallback', () => {
    expect(deriveProductLabels(base({ purchasedUnits: 30 }))[1]).toBe('platform_bestseller');
    expect(deriveProductLabels(base({ purchasedUnits: 12 }))[1]).toBe('bestseller');
    expect(deriveProductLabels(base({ purchasedUnits: 4 }))[1]).toBe('popular');
    expect(deriveProductLabels(base({ purchasedUnits: 0, createdAt: RECENT }))[1]).toBe('new');
    expect(deriveProductLabels(base({ purchasedUnits: 0, createdAt: OLD }))[1]).toBe('standard');
  });

  it('a recent product that already sells is described by velocity, not "new"', () => {
    expect(deriveProductLabels(base({ purchasedUnits: 12, createdAt: RECENT }))[1]).toBe('bestseller');
  });

  it('audience: age wins over gender, else unisex', () => {
    expect(deriveProductLabels(base({ audienceTexts: ['ביגוד תינוקות'] }))[3]).toBe('baby');
    expect(deriveProductLabels(base({ audienceTexts: ['נעלי ילדים'] }))[3]).toBe('kids');
    expect(deriveProductLabels(base({ audienceTexts: ['חולצת גברים'] }))[3]).toBe('men');
    expect(deriveProductLabels(base({ audienceTexts: ['שמלת נשים'] }))[3]).toBe('women');
    expect(deriveProductLabels(base({ audienceTexts: ['ספר'] }))[3]).toBe('unisex');
  });

  it('store_type: first flat tag as a clean token, else general', () => {
    expect(deriveProductLabels(base({ storeTags: ['Home Decor', 'x'] }))[4]).toBe('home_decor');
    expect(deriveProductLabels(base({ storeTags: ['אופנה'] }))[4]).toBe('אופנה');
    expect(deriveProductLabels(base({ storeTags: [] }))[4]).toBe('general');
    expect(deriveProductLabels(base())[4]).toBe('general');
  });
});
