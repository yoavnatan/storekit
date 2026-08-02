import { describe, it, expect } from 'vitest';
import { normalizeSlug, computeNextPreviousSlugs, MAX_PREVIOUS_SLUGS, findStoreBySlugOrPrevious, storeClaimsSlug } from '../src/lib/stores.js';
import type { Store } from '../src/lib/stores.js';

describe('normalizeSlug', () => {
  it('lowercases, converts spaces to hyphens, keeps only latin/digits/hyphen', () => {
    expect(normalizeSlug('My Store')).toBe('my-store');
    expect(normalizeSlug('Cool Shop 123')).toBe('cool-shop-123');
  });

  it('collapses repeated hyphens and trims edge hyphens', () => {
    expect(normalizeSlug('  --my   store--  ')).toBe('my-store');
    expect(normalizeSlug('a__b')).toBe('ab'); // underscores stripped
  });

  // Changed 2026-08-02: Hebrew is now ACCEPTED. It used to strip to '' — which was defensible while
  // the field promised "latin only", but the seller picks this value himself, so the form now states
  // the trade-off (a Hebrew link pastes long in some apps) and lets him choose. Products made the
  // same move for a stronger reason: nobody types a product slug, so the strip was silent data loss.
  it('keeps an all-Hebrew name instead of emptying it', () => {
    expect(normalizeSlug('כלים של אליקים')).toBe('כלים-של-אליקים');
    expect(normalizeSlug('חנות')).toBe('חנות');
  });

  it('keeps both halves of a mixed name rather than salvaging one', () => {
    expect(normalizeSlug('חנות Cool')).toBe('חנות-cool');
    expect(normalizeSlug('Nike נייקי')).toBe('nike-נייקי');
  });

  // The store slug is an identity: uniqueness is checked on it (isSlugTaken) and orders are bound
  // to a store by it (orders.ts#orderBelongsToStore). Two Unicode spellings of one word must
  // therefore land on ONE slug, or a second store could hold a pixel-identical address.
  it('folds Unicode spellings so two stores cannot hold the same-looking slug', () => {
    expect(normalizeSlug('אַון')).toBe(normalizeSlug('און'));
    expect(normalizeSlug('עִבְרִית')).toBe('עברית');
  });
});

describe('computeNextPreviousSlugs (SEO-safe rename history for 301 redirects)', () => {
  it('appends the old slug to the history', () => {
    expect(computeNextPreviousSlugs(undefined, 'old', 'new')).toEqual(['old']);
    expect(computeNextPreviousSlugs(['a'], 'old', 'new')).toEqual(['a', 'old']);
  });

  it('drops the new slug from history when reverting (no self-redirect)', () => {
    // was old→a, now a→old: the current slug 'old' must not remain a 301 source.
    expect(computeNextPreviousSlugs(['old'], 'a', 'old')).toEqual(['a']);
  });

  it('dedupes repeated old slugs', () => {
    expect(computeNextPreviousSlugs(['old'], 'old', 'new')).toEqual(['old']);
  });

  it('caps history to the most recent MAX_PREVIOUS_SLUGS', () => {
    const many = Array.from({ length: MAX_PREVIOUS_SLUGS + 5 }, (_, k) => `s${k}`);
    const out = computeNextPreviousSlugs(many, 'old', 'new');
    expect(out.length).toBe(MAX_PREVIOUS_SLUGS);
    expect(out[out.length - 1]).toBe('old'); // newest kept
  });
});

describe('findStoreBySlugOrPrevious (stale-slug tolerance for seller APIs)', () => {
  const stores = [
    { id: '1', slug: 'new-name', previousSlugs: ['old-name', 'older'] },
    { id: '2', slug: 'other' },
  ] as Store[];

  it('matches the current slug', () => {
    expect(findStoreBySlugOrPrevious(stores, 'new-name')?.id).toBe('1');
  });
  it('matches a previous slug (a client that cached the old URL still resolves)', () => {
    expect(findStoreBySlugOrPrevious(stores, 'old-name')?.id).toBe('1');
    expect(findStoreBySlugOrPrevious(stores, 'older')?.id).toBe('1');
  });
  it('returns undefined for an unknown slug', () => {
    expect(findStoreBySlugOrPrevious(stores, 'nope')).toBeUndefined();
  });
});

describe('storeClaimsSlug (old slugs stay reserved so 301s never break)', () => {
  const store = { slug: 'bar', previousSlugs: ['foo', 'baz'] } as { slug: string; previousSlugs?: string[] };
  it('claims its current slug', () => {
    expect(storeClaimsSlug(store, 'bar')).toBe(true);
  });
  it('still claims a PREVIOUS slug (another store cannot reuse it and break the 301)', () => {
    expect(storeClaimsSlug(store, 'foo')).toBe(true);
    expect(storeClaimsSlug(store, 'baz')).toBe(true);
  });
  it('does not claim an unrelated slug', () => {
    expect(storeClaimsSlug(store, 'other')).toBe(false);
    expect(storeClaimsSlug({ slug: 'x' }, 'foo')).toBe(false);
  });
});
