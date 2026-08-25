import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { categoryIconKey } from '../src/lib/category-icons.js';
import { SEED_CATEGORIES } from '../src/lib/store-taxonomy.js';

const ICON_COMPONENT = readFileSync(new URL('../src/components/CategoryIcon.astro', import.meta.url), 'utf8');

/** The non-seed labels category-icons.ts carries artwork for (ALIAS_ICONS is private). */
const ALIAS_LABELS = [
  'צמחים', 'לגינה', 'גינה', 'יודאיקה', 'ציוד מחשבים', 'מחשבים', 'לילדים', 'ילדים',
  'מוזיקה', 'כלי נגינה', 'קוסמטיקה', 'טבע', 'מוצרי טבע', 'נקיון', 'ניקיון',
  'חד פעמי', 'חד פעמיים', 'כלים חד פעמיים',
];

describe('categoryIconKey', () => {
  it('gives every seed category a real icon — never the neutral fallback', () => {
    // This is the guard on the whole premise: the platform vocabulary is closed,
    // so adding a seed without drawing its icon must fail here rather than
    // shipping a tag glyph into the chip row.
    for (const seed of SEED_CATEGORIES) {
      expect(categoryIconKey(seed), seed).not.toBe('default');
    }
  });

  it('gives each seed a DISTINCT icon', () => {
    const keys = SEED_CATEGORIES.map((c) => categoryIconKey(c));
    expect(new Set(keys).size).toBe(SEED_CATEGORIES.length);
  });

  it('has artwork for every key it can return', () => {
    // The map lives in the .astro component (markup belongs there), so it can't be
    // imported — assert the key appears as a property of the ART record instead.
    const returned = new Set([
      ...SEED_CATEGORIES.map(categoryIconKey),
      ...ALIAS_LABELS.map(categoryIconKey),
      'default',
      'all',
    ]);
    for (const key of returned) {
      expect(ICON_COMPONENT, key).toContain(`  ${key}: '<`);
    }
  });

  it('covers the non-seed labels that were added on request', () => {
    // Not seeds (the picker vocabulary is a separate decision) — icon coverage only.
    const expected: Record<string, string> = {
      'צמחים': 'plants',
      'לגינה': 'garden',
      'גינה': 'garden',
      'יודאיקה': 'judaica',
      'ציוד מחשבים': 'computers',
      'מחשבים': 'computers',
      'לילדים': 'kids',
      'ילדים': 'kids',
      'מוזיקה': 'music',
      'כלי נגינה': 'music',
      'טבע': 'nature',
      'מוצרי טבע': 'nature',
      'נקיון': 'cleaning',
      'ניקיון': 'cleaning',
      'חד פעמי': 'disposables',
      'חד פעמיים': 'disposables',
      'כלים חד פעמיים': 'disposables',
    };
    for (const [label, key] of Object.entries(expected)) {
      expect(categoryIconKey(label), label).toBe(key);
    }
  });

  it('points קוסמטיקה at the existing טיפוח icon rather than a second one', () => {
    expect(categoryIconKey('קוסמטיקה')).toBe(categoryIconKey('טיפוח'));
  });

  it('covers both spellings of נקיון/ניקיון', () => {
    // Normalization can't unify these — different strings, not different casing.
    expect(categoryIconKey('נקיון')).toBe(categoryIconKey('ניקיון'));
  });

  it('lets a non-seed label be inherited from too', () => {
    expect(categoryIconKey('צמחים מלאכותיים')).toBe('plants');
  });

  it('resolves an ambiguous label to a seed, not an alias', () => {
    // "צמחי בית" genuinely reads both ways. It does NOT token-match "צמחים"
    // ("צמחי" ≠ "צמחים"), and it DOES match the seed "לבית", so it lands on the
    // house. Asserted so the ordering is a decision on record rather than a
    // surprise if someone reshuffles INHERITABLE.
    expect(categoryIconKey('צמחי בית')).toBe('home');
  });

  it('ignores casing and stray whitespace', () => {
    expect(categoryIconKey('  בגדים  ')).toBe('fashion');
  });

  it('lets a seller-added category inherit the nearest seed icon', () => {
    // The exact pair store-taxonomy.ts was written for.
    expect(categoryIconKey('חשמל ואלקטרוניקה')).toBe('electronics');
    expect(categoryIconKey('חלקי רכב')).toBe('car');
  });

  it('falls back to the neutral tag for a category nothing matches', () => {
    expect(categoryIconKey('שירותי ייעוץ')).toBe('default');
    expect(categoryIconKey('')).toBe('default');
    expect(categoryIconKey('   ')).toBe('default');
  });

  it('does not let a weak shared word drag in a wrong icon', () => {
    // "כלי אוכל" shares only the 3-letter "כלי" with the seed "כלי עבודה" — the same
    // false positive STRONG_TOKEN_LENGTH exists to reject. ("כלי נגינה", the pair
    // store-taxonomy.ts documents, is now an exact ALIAS entry and resolves to
    // music before the similarity pass ever runs — hence a different pair here.)
    expect(categoryIconKey('כלי אוכל')).toBe('default');
  });
});
