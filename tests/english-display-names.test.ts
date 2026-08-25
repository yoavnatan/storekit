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
 * A missing translation is the NORMAL case, not an error — the table is empty today by design
 * (`lib/category-translations.ts` says who is expected to fill it and why the seller-facing input
 * was cut). So the fallback path is tested as hard as the hit: an untranslated category renders as
 * the seller wrote it, never as a blank.
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
    expect(resolveCategoryLabel('בגדים', 'he', seller)).toBe('בגדים');
  });

  it('uses the seller translation for a category the platform never seeded', () => {
    expect(resolveCategoryLabel('אקלקטי', 'en', seller)).toBe('Eclectic');
  });

  it('lets the seed map win over a seller row for a platform category', () => {
    // Otherwise one seller renames the shelf every other store sits on.
    const hostile = new Map([['בגדים', 'Totally Different Shelf']]);
    expect(resolveCategoryLabel('בגדים', 'en', hostile)).toBe('Fashion');
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

  /**
   * The one that actually got through. The two scans above check the LIBRARIES, and both
   * passed while `index.astro` handed the translated title to `CategoryIcon` — so in
   * English every homepage shelf drew the fallback glyph, because the icon map is keyed
   * by the Hebrew value. Grouping was right, the icon module was right; the wiring
   * between them was not, which is where this class lives.
   */
  it('keys the homepage shelf icon off the stored value, not the heading', () => {
    const source = read('pages/index.astro');
    // Anchored on the categoryShelves loop — every other HomeShelf on the page is a
    // fixed tab (liked, buy-again, new) whose title is a translation string and which
    // draws no category icon at all.
    const shelf = source.slice(source.indexOf('categoryShelves.map'));
    const line = shelf.slice(0, shelf.indexOf('/>'));
    expect(line).toContain('<HomeShelf');
    expect(
      /categoryLabel=\{s\.title\}/.test(line),
      'CategoryIcon looks its glyph up by the stored Hebrew value. `s.title` is the reader-facing\n' +
        'label, so passing it here gives every category shelf the fallback icon in English only.\n' +
        'Pass `s.value` — the two live side by side on the shelf object precisely so they cannot\n' +
        'be confused.',
    ).toBe(false);
    expect(line).toMatch(/categoryLabel=\{s\.value\}/);
  });

});
