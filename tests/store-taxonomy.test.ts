import { describe, expect, it } from 'vitest';
import {
  MAX_CATEGORIES_PER_STORE,
  MAX_CATEGORY_LENGTH,
  SEED_CATEGORIES,
  buildVocabulary,
  categoryLabel,
  categoryTokens,
  findSimilarCategories,
  normalizeCategory,
  proposeCategory,
  sanitizeStoreCategories,
} from '../src/lib/store-taxonomy.js';

describe('normalizeCategory', () => {
  it('trims, collapses whitespace and strips edge punctuation', () => {
    expect(normalizeCategory('  אופנה  ')).toBe('אופנה');
    expect(normalizeCategory('כלי   עבודה')).toBe('כלי עבודה');
    expect(normalizeCategory('-אופנה,')).toBe('אופנה');
  });

  it('unifies latin case so Fashion and fashion are one category', () => {
    expect(normalizeCategory('FASHION')).toBe(normalizeCategory('fashion'));
  });

  it('is empty for input that is only punctuation or space', () => {
    expect(normalizeCategory('   ')).toBe('');
    expect(normalizeCategory('---')).toBe('');
  });
});

describe('near-duplicate detection', () => {
  it('catches the exact pair this feature exists for', () => {
    // "אלקטרוניקה" vs "חשמל ואלקטרוניקה" — different strings, so no amount of
    // case/space normalizing finds them. Word overlap does.
    const hits = findSimilarCategories('חשמל ואלקטרוניקה', ['אלקטרוניקה', 'מזון']);
    expect(hits).toContain('אלקטרוניקה');
    expect(hits).not.toContain('מזון');
  });

  it('treats a Hebrew conjunction prefix as the same word', () => {
    expect(categoryTokens('וריהוט')).toContain('ריהוט');
  });

  it('reports an exact match as similar too', () => {
    expect(findSimilarCategories('אופנה', ['אופנה'])).toEqual(['אופנה']);
  });

  it('does not fire on unrelated categories', () => {
    expect(findSimilarCategories('צעצועים', ['אופנה', 'מטבח', 'רכב'])).toEqual([]);
  });

  it('does not treat a short generic word as proof — the "כלי" false positive', () => {
    // Browser-caught 2026-07-28: "כלי נגינה" was offered "כלי עבודה" as a duplicate.
    expect(findSimilarCategories('כלי נגינה', ['כלי עבודה'])).toEqual([]);
  });

  it('still links a short word when it IS the whole label', () => {
    expect(findSimilarCategories('חלקי רכב', ['רכב'])).toContain('רכב');
  });

  it('ignores stopwords so "כל" alone never links two categories', () => {
    expect(findSimilarCategories('כל הבית', ['כל הרכב'])).toEqual([]);
  });
});

describe('proposeCategory', () => {
  const existing = ['אלקטרוניקה', 'אופנה'];

  it('accepts a genuinely new category', () => {
    expect(proposeCategory('כלי נגינה', existing)).toEqual({ ok: true, value: 'כלי נגינה' });
  });

  it('refuses empty and over-long labels', () => {
    expect(proposeCategory('   ', existing)).toMatchObject({ ok: false, reason: 'empty' });
    expect(proposeCategory('א'.repeat(MAX_CATEGORY_LENGTH + 1), existing))
      .toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('hard-refuses unsafe wording, reusing the site-wide spam word list', () => {
    expect(proposeCategory('קזינו', existing)).toMatchObject({ ok: false, reason: 'unsafe' });
    expect(proposeCategory('online casino', existing)).toMatchObject({ ok: false, reason: 'unsafe' });
  });

  it('offers the existing category instead of a near-duplicate, as a soft block', () => {
    const r = proposeCategory('חשמל ואלקטרוניקה', existing);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'similar') expect(r.suggestions).toContain('אלקטרוניקה');
    else throw new Error('expected a similar-category proposal');
  });
});

describe('buildVocabulary', () => {
  it('always contains the seed list', () => {
    const v = buildVocabulary({});
    for (const s of SEED_CATEGORIES) expect(v).toContain(s);
  });

  it('adds seller-created categories and floats the most-used to the front', () => {
    const v = buildVocabulary({ 'כלי נגינה': 9, 'אופנה': 3 });
    expect(v).toContain('כלי נגינה');
    expect(v.indexOf('כלי נגינה')).toBeLessThan(v.indexOf('אופנה'));
  });

  it('folds a differently-spaced duplicate into the seed entry, not a second row', () => {
    const v = buildVocabulary({ '  אופנה ': 5 });
    expect(v.filter((c) => normalizeCategory(c) === 'אופנה')).toHaveLength(1);
  });
});

describe('sanitizeStoreCategories — the server-side rule', () => {
  it('normalizes, de-duplicates and caps', () => {
    const out = sanitizeStoreCategories([' אופנה ', 'אופנה', 'הנעלה', 'מזון', 'רכב']);
    expect(out).toEqual(['אופנה', 'הנעלה', 'מזון']);
    expect(out.length).toBeLessThanOrEqual(MAX_CATEGORIES_PER_STORE);
  });

  it('drops unsafe entries even when the client sent them', () => {
    // The picker is convenience; a hand-crafted POST must not get through.
    expect(sanitizeStoreCategories(['אופנה', 'קזינו'])).toEqual(['אופנה']);
  });

  it('drops empties and over-long entries', () => {
    expect(sanitizeStoreCategories(['', '   ', 'א'.repeat(MAX_CATEGORY_LENGTH + 1)])).toEqual([]);
  });
});

/**
 * A category's Hebrew string is its IDENTITY — the stored `Store.categories` value,
 * the `?category=` parameter, the homepage grouping key and the icon map's key. The
 * English is a label drawn over it, and these two facts are what keep them apart.
 *
 * The parity half mirrors `category-icons.test.ts`: adding a seed without an English
 * twin fails here rather than showing one Hebrew chip in an otherwise English row —
 * which is exactly how this was found (owner, 2026-08-07: "גם באנגלית כל הקטגוריות
 * עדיין מופיעות בעברית").
 */
describe('categoryLabel — display only, never the value', () => {
  it('gives every seed an English twin', () => {
    const missing = SEED_CATEGORIES.filter((c) => categoryLabel(c, 'en') === c);
    expect(missing, `seeds with no English label:\n${missing.join('\n')}`).toEqual([]);
  });

  it('returns the stored value untouched in Hebrew', () => {
    for (const c of SEED_CATEGORIES) expect(categoryLabel(c, 'he')).toBe(c);
  });

  it('passes a seller-added category through rather than inventing a translation', () => {
    // Not in the seed list, so there is no twin to look up and nothing to guess.
    expect(categoryLabel('כלי נגינה', 'en')).toBe('כלי נגינה');
    expect(categoryLabel('כלי נגינה', 'he')).toBe('כלי נגינה');
  });

  it('trims, so a stored value with stray spaces still resolves', () => {
    expect(categoryLabel(' אופנה ', 'en')).toBe('Fashion');
  });
});
