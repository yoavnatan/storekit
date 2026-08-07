/**
 * An English label is something a reader SEES. It is never what anything identifies a category by.
 *
 * The Hebrew value a seller picked is the identity in four separate places at once — the
 * `stores.categories` value, the `?category=` parameter, the key the homepage shelves group on, and
 * the key `category-icons.ts` looks its icon up with. Substituting the English anywhere in that
 * list forks the catalogue by language: a store an English visitor can reach and a Hebrew visitor
 * cannot, or the same store on two shelves.
 *
 * It would also reach the ad feed, where the store's own categories ride in `custom_label_4` and
 * its name becomes `brand` when a product has none — and Merchant Center matches listings across
 * the market on brand. **Checked 2026-08-07 against Google's published spec rather than assumed,
 * because an earlier note here overstated it:** a brand mismatch between feed and landing page is
 * NOT a listed disapproval or suspension reason (only price and availability are), but conflicting
 * brand values are documented as causing "limited performance". So the cost of getting this wrong
 * is degraded reach, not a dead account — worth holding the line for, not worth panic.
 *
 * Nothing about that is enforced by types — both sides are `string` — so it is enforced here.
 *
 * The other half is the requirement that made this optional in the first place (owner, 2026-08-07:
 * "אסור שזה יהיה חובה כי צריך לצאת מנקודת הנחה שהרבה מוכרים לא יודעים אנגלית"). A seller who reads
 * no English must be able to finish every form. So a missing translation is the NORMAL case and
 * must never surface as an error, a rejection, or an empty label.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveCategoryLabel } from '../src/lib/category-translations.js';
import { SEED_CATEGORIES } from '../src/lib/store-taxonomy.js';

const read = (rel: string) => readFileSync(new URL(rel, new URL('../src/', import.meta.url)), 'utf8');

describe('resolveCategoryLabel — a label, never an identity', () => {
  const seller = new Map([['אקלקטי', 'Eclectic']]);

  it('hands back the stored value untouched in Hebrew, translation or not', () => {
    expect(resolveCategoryLabel('אקלקטי', 'he', seller)).toBe('אקלקטי');
    expect(resolveCategoryLabel('אופנה', 'he', seller)).toBe('אופנה');
  });

  it('uses the seller translation for a category the platform never seeded', () => {
    expect(resolveCategoryLabel('אקלקטי', 'en', seller)).toBe('Eclectic');
  });

  it('lets the seed map win over a seller row for a platform category', () => {
    // Otherwise one seller renames the shelf every other store sits on.
    const hostile = new Map([['אופנה', 'Totally Different Shelf']]);
    expect(resolveCategoryLabel('אופנה', 'en', hostile)).toBe('Fashion');
  });

  it('falls back to the Hebrew rather than to an empty label', () => {
    const none = new Map<string, string>();
    expect(resolveCategoryLabel('אקלקטי', 'en', none)).toBe('אקלקטי');
    for (const c of SEED_CATEGORIES) {
      expect(resolveCategoryLabel(c, 'en', none)).not.toBe('');
    }
  });

  it('trims, so a stored value with stray spaces still resolves', () => {
    expect(resolveCategoryLabel('  אקלקטי  ', 'en', seller)).toBe('Eclectic');
  });
});

describe('the English label never becomes an identity', () => {
  it('groups the homepage shelves by the stored value, not by a label', () => {
    // home-feed.ts builds `byCategory` — the map whose keys become shelf identities.
    const source = read('lib/home-feed.ts');
    expect(source).toMatch(/byCategory/);
    expect(
      /resolveCategoryLabel|categoryLabel/.test(source),
      'home-feed.ts groups stores into shelves. Grouping by a LABEL would put one store on two\n' +
        'shelves in one language and one in the other. The page translates the heading after the\n' +
        'grouping (index.astro); the grouping key stays the stored Hebrew value.',
    ).toBe(false);
  });

  it('keys the category icon off the stored value, not off a label', () => {
    const source = read('lib/category-icons.ts');
    expect(
      /resolveCategoryLabel/.test(source),
      'category-icons.ts maps a category to an icon. Its keys are the Hebrew values; looking up an\n' +
        'English label would give every seller-added category the fallback icon in English only.',
    ).toBe(false);
  });

  it('never writes an English label into the store record or a URL', () => {
    // The one writer. It must put the seller's label in `category_translations` and nowhere near
    // `stores.categories`, which is what `?category=` and the grouping both read.
    const source = read('pages/api/store.ts');
    // The IDENTIFIER, not the literal: the prefix is declared once in
    // category-translations.ts, and a retyped copy here is the thing that silently
    // stops matching — the save still succeeds and the label is simply never stored.
    expect(source).toContain('CATEGORY_EN_FIELD_PREFIX');
    // `categories` is still built from sanitizeStoreCategories alone.
    expect(source).toMatch(/categories:\s*sanitizeStoreCategories\(/);
    const merged = source.slice(source.indexOf('const saved = await updateStore'));
    expect(
      /categoryEn|name_en|nameEn/.test(merged),
      'An English label reached updateStore(). It belongs in category_translations only — the store\n' +
        "record holds the identity, and `?category=` reads it.",
    ).toBe(false);
  });
});

describe('an untranslated category is the normal case, not an error', () => {
  it('has no code path that rejects a save for a missing English label', () => {
    const source = read('pages/api/store.ts');
    const block = source.slice(source.indexOf('CATEGORY_EN_FIELD_PREFIX)'));
    const untilNextReturn = block.slice(0, block.indexOf('pingStoreChange'));
    expect(
      /return json\(\{\s*ok:\s*false/.test(untilNextReturn),
      'The English label is optional by requirement (owner, 2026-08-07). Nothing in the block that\n' +
        'stores it may fail the save — a seller who reads no English has to be able to finish the form.',
    ).toBe(false);
  });
});
