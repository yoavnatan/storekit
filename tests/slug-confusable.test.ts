import { describe, expect, it } from 'vitest';
import { confusableSkeleton } from '../src/lib/slug-confusable.js';
import { isReservedSlug, normalizeSlug } from '../src/lib/stores.js';
import { REDOS_BUDGET_MS, elapsedMs } from './helpers/redos-budget.js';

describe('confusableSkeleton', () => {
  it('folds Cyrillic and Greek lookalikes onto their Latin twin', () => {
    expect(confusableSkeleton('аdmin')).toBe('admin');   // Cyrillic а
    expect(confusableSkeleton('арі')).toBe('api');       // all three Cyrillic
    expect(confusableSkeleton('ѕhор')).toBe('shop');     // mixed Cyrillic spelling
  });

  it('leaves a slug with no Latin lookalikes exactly as it is', () => {
    expect(confusableSkeleton('חנות-הבגדים')).toBe('חנות-הבגדים');
    expect(confusableSkeleton('shop-ישראל')).toBe('shop-ישראל');
    expect(confusableSkeleton('gal-gallery')).toBe('gal-gallery');
  });
});

describe('reserved routes cannot be impersonated by spelling', () => {
  // The one harm a report cannot undo in time: a store sitting on a platform route's address.
  it('catches a lookalike spelling of every reserved word', () => {
    expect(isReservedSlug(normalizeSlug('аdmin'))).toBe(true);   // Cyrillic а
    expect(isReservedSlug(normalizeSlug('арi'))).toBe(true);     // Cyrillic а + р
    expect(isReservedSlug(normalizeSlug('сheckout'))).toBe(true); // Cyrillic с
    expect(isReservedSlug(normalizeSlug('ассount'))).toBe(true);  // two Cyrillic с
  });

  it('still catches the plain spelling', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('api')).toBe(true);
  });

  // Owner decision 2026-08-02: mixing scripts is LEGITIMATE and must not be blocked. These are the
  // slugs the rejected mixed-script rule would have cost, and they must all stay usable.
  it('does not touch an ordinary Israeli slug, mixed script or not', () => {
    for (const slug of ['shop-ישראל', 'gal-gallery', 'חנות-abc', 'nike-נייקי', 'магазин', 'متجر']) {
      expect(isReservedSlug(normalizeSlug(slug)), slug).toBe(false);
    }
  });

  it('does not reject a Latin word that merely contains a reserved one', () => {
    expect(isReservedSlug('administrator')).toBe(false);
    expect(isReservedSlug('api-tools')).toBe(false);
  });

  it('answers instantly on a hostile path segment — the middleware calls it with a raw one', () => {
    // Real cost measured 2026-08-02: 0.00ms. The ceiling is the shared one and deliberately far
    // above that — see helpers/redos-budget.ts for why a tight one is noise, not a stronger test.
    const elapsed = elapsedMs(() => { expect(isReservedSlug('a'.repeat(500_000))).toBe(false); });
    expect(elapsed).toBeLessThan(REDOS_BUDGET_MS);
  });
});
