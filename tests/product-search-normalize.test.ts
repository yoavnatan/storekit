/**
 * The Hebrew search normalisation exists TWICE, and this is what keeps the two copies one rule.
 *
 * `product-listing.ts#normalizeHe` is the JS definition — nikud stripped, the five final letters
 * folded (ןףךםץ → נפכמצ), geresh/quotes dropped, punctuation turned into spaces, whitespace
 * collapsed. Migration 0006 ports it into `product_search_text()` so the platform search can be an
 * indexed query instead of a scan of every product in the mall (§3).
 *
 * A port is only worth having if it cannot drift. The fold in particular is not cosmetic: it is
 * what makes a search for "טלפון" find "ספר טלפונים", and a raw `ILIKE '%טלפון%'` would not —
 * so a divergence here does not throw, it quietly stops finding Hebrew products.
 *
 * Same shape as `tests/product-visibility-guard.test.ts`: one rule, two implementations, pinned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { normalizeHe, matchesQueryWords } from '../src/lib/product-listing.js';
import { productSearchSource } from '../src/lib/product-search-text.js';
import { searchVisibleProducts } from '../src/lib/store-products.js';
import { searchSite } from '../src/lib/site-search.js';

/** Every trap the normaliser handles, plus the plain cases that must survive it. The `variants`
 *  half is migration 0027's: which option values join the search text, and which are noise the
 *  stored column must keep out (see product-search-text.ts for the argument). */
type Variants = Array<{ name: string; options: string[] }> | null;
const CORPUS: Array<{ name: string; tags: string[]; variants?: Variants }> = [
  { name: 'חוּלְצָה כְּחֻלָּה', tags: ['בגדים', 'קיץ'] },          // nikud on both words
  { name: 'ספר טלפונים', tags: ['טלפון'] },                        // final mem inside the haystack
  { name: 'כלך אל הגן', tags: ['ץ', 'ף', 'ן'] },                    // every final letter, alone
  { name: "ג'ינס ״מקורי״ 32", tags: [] },                          // geresh + gershayim
  { name: 'Blue-Shirt, Large', tags: ['tops'] },                    // latin + punctuation
  { name: 'ABC{x}[y](z)!?;:', tags: [] },                           // the whole punctuation class
  { name: 'סֵפֶר/מַחְבֶּרֶת', tags: ['כתיבה'] },                    // slash between two words
  { name: '  double   spaces  ', tags: ['a,b'] },                   // collapse + trim
  { name: 'מוצר בלי תגיות', tags: [] },                             // empty tag array
  { name: 'שולחן עץ 100X200', tags: ['ריהוט', 'סלון'] },            // digits and an X

  // ── variants ──────────────────────────────────────────────────────────────
  // The whole point: none of these colours appears in the name or the tags, which is exactly how
  // a real seller fills the form — on the product page they are swatches, so repeating them in
  // the title would be noise.
  { name: 'טישרט בייסיק', tags: ['בגדים'],
    variants: [{ name: 'צבע', options: ['צהוב', 'אדום', 'שחור'] }] },
  // Sizes are the noise class: numeric values must NOT make this answer to "38", and the single
  // letters must not either, while XL survives the two-character floor.
  { name: 'מכנסי דגמ״ח', tags: [],
    variants: [{ name: 'מידה', options: ['36', '38', '40'] },
               { name: 'גודל', options: ['S', 'M', 'XL'] }] },
  // A dimension the synonym table has never heard of, whose values are exactly what a shopper
  // types — the case a whitelist of dimension NAMES would silently drop.
  { name: 'נר ריחני', tags: [],
    variants: [{ name: 'ניחוח', options: ['לבנדר', 'וניל'] }] },
  // Nikud and punctuation inside an option value, and a unit that must stay searchable.
  { name: 'בושם', tags: [],
    variants: [{ name: 'נפח', options: ['50ml', '100ml'] }, { name: 'גוון', options: ['וָרֹד'] }] },
  // Malformed JSONB — the shape is what we wrote, not what is guaranteed. A dimension with no
  // name, one whose options are not an array, and a null column: all must yield no values and
  // no error, on BOTH sides.
  { name: 'מוצר עם וריאציות שבורות', tags: [],
    variants: [{ name: '', options: ['רפאים'] },
               { name: 'צבע', options: [] },
               { name: 'צורה' } as unknown as { name: string; options: string[] }] },
  { name: 'מוצר בלי וריאציות בכלל', tags: ['בדיקה'], variants: null },
];

const STORE = '22222222-2222-4222-8222-000000000001'; // fixture store — see tests/fixtures/db-data
const ids: string[] = [];

beforeAll(async () => {
  for (const { name, tags, variants } of CORPUS) {
    const id = crypto.randomUUID();
    ids.push(id);
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, tags, variants)
       VALUES ($1, $2, $3, $4, 1000, $5::text[], $6::jsonb)`,
      [id, STORE, `search-fixture-${ids.length}`, name, tags, JSON.stringify(variants ?? [])],
    );
  }
});

describe('product_search_text() is normalizeHe()', () => {
  it('agrees character for character on every trap in the corpus', async () => {
    const { rows } = await query<{ id: string; name: string; tags: string[]; variants: Variants; search_text: string }>(
      `SELECT id, name, tags, variants, search_text FROM store_products WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(rows).toHaveLength(CORPUS.length);
    for (const row of rows) {
      // `productSearchSource` is the JS definition of the haystack — name, tags, then the
      // searchable variant values — and `search_text` is migration 0027's port of it. Whole
      // strings, so the ORDER of the three parts is pinned too, not just their contents.
      expect(row.search_text).toBe(normalizeHe(productSearchSource({
        name: row.name, tags: row.tags ?? [], variants: row.variants ?? undefined,
      })));
    }
  });

  it('makes a product findable by a colour that appears nowhere else on it', async () => {
    // The defect this migration exists for: before it, every one of these returned zero rows in a
    // store that plainly sells the thing.
    for (const q of ['צהוב', 'אדום', 'לבנדר', 'וניל']) {
      expect(await searchVisibleProducts(q, [STORE], 20)).not.toHaveLength(0);
    }
    expect((await searchVisibleProducts('צהוב', [STORE], 20)).map((p) => p.name))
      .toContain('טישרט בייסיק');
    expect((await searchVisibleProducts('וניל', [STORE], 20)).map((p) => p.name))
      .toContain('נר ריחני');
  });

  it('keeps numeric sizes OUT, so a clothing store does not answer to every number', async () => {
    // '38' and '36' are a size rubric and nothing else on that product says them. If they entered
    // the search text, every garment in a real store would match a bare number.
    expect((await searchVisibleProducts('38', [STORE], 50)).map((p) => p.name))
      .not.toContain('מכנסי דגמ״ח');
    expect((await searchVisibleProducts('36', [STORE], 50)).map((p) => p.name))
      .not.toContain('מכנסי דגמ״ח');
  });

  it('keeps single-letter sizes out and two-character ones in', async () => {
    expect((await searchVisibleProducts('xl', [STORE], 50)).map((p) => p.name))
      .toContain('מכנסי דגמ״ח');
    // 'S' alone would be a substring of half the catalogue under LIKE — that is why the floor is
    // two characters and not one. Asserted through the stored column, where it would show up.
    const { rows } = await query<{ search_text: string }>(
      `SELECT search_text FROM store_products WHERE store_id = $1 AND name = $2`,
      [STORE, 'מכנסי דגמ״ח'],
    );
    expect(rows[0].search_text).not.toMatch(/(^| )s( |$)/);
    expect(rows[0].search_text).not.toMatch(/(^| )m( |$)/);
  });

  it('never indexes the dimension NAME, only its values', async () => {
    // "צבע" as a query must not return every product that happens to have colours.
    expect((await searchVisibleProducts('צבע', [STORE], 50)).map((p) => p.name))
      .not.toContain('טישרט בייסיק');
    expect((await searchVisibleProducts('ניחוח', [STORE], 50)).map((p) => p.name))
      .not.toContain('נר ריחני');
  });

  it('survives malformed variant JSON on both sides instead of raising', async () => {
    const { rows } = await query<{ search_text: string }>(
      `SELECT search_text FROM store_products WHERE store_id = $1 AND name = $2`,
      [STORE, 'מוצר עם וריאציות שבורות'],
    );
    // A dimension with no name, one with no options and one with no `options` key at all
    // contribute nothing — same rule as variant-combo.ts#realDimensions.
    expect(rows[0].search_text).toBe('מוצר עמ וריאציות שבורות');
    expect(rows[0].search_text).not.toContain('רפאימ');
  });

  it('folds a final letter so a query without it still matches', async () => {
    // The case the whole port exists for — "טלפון" normalises to "טלפונ", which IS a substring of
    // "טלפונימ". Without the fold on the stored side this returns nothing.
    const hits = await searchVisibleProducts('טלפון', [STORE], 20);
    expect(hits.map((p) => p.name)).toContain('ספר טלפונים');
  });

  it('ignores nikud on either side of the match', async () => {
    // Unpointed, the stored "כְּחֻלָּה" is spelled "כחלה" — the nikud carries the vowel the
    // letter does not, which is exactly why both sides have to be stripped before comparing.
    const bare = await searchVisibleProducts('חולצה כחלה', [STORE], 20);
    const pointed = await searchVisibleProducts('חוּלְצָה', [STORE], 20);
    expect(bare.map((p) => p.name)).toContain('חוּלְצָה כְּחֻלָּה');
    expect(pointed.map((p) => p.name)).toContain('חוּלְצָה כְּחֻלָּה');
  });
});

describe('searchVisibleProducts', () => {
  async function jsAnswer(q: string): Promise<string[]> {
    const { rows } = await query<{ name: string; tags: string[]; variants: Variants }>(
      `SELECT name, tags, variants FROM store_products
        WHERE store_id = $1 AND NOT hidden AND NOT blocked
        ORDER BY created_at DESC, id`,
      [STORE],
    );
    return rows
      .filter((r) => matchesQueryWords(q, productSearchSource({
        name: r.name, tags: r.tags ?? [], variants: r.variants ?? undefined,
      })))
      .map((r) => r.name);
  }

  for (const q of ['בגדים', 'חולצה כחולה', 'shirt', 'tops', 'ריהוט סלון', 'כתיבה', 'מוצר',
                   'צהוב', 'שחור', 'לבנדר', '50ml', 'xl', '38', 'צבע', 'ורוד']) {
    it(`returns exactly what matchesQueryWords would, for "${q}"`, async () => {
      const sql = (await searchVisibleProducts(q, [STORE], 100)).map((p) => p.name);
      expect(sql).toEqual(await jsAnswer(q));
    });
  }

  it('requires EVERY word, not any of them', async () => {
    const both = await searchVisibleProducts('ריהוט סלון', [STORE], 100);
    const impossible = await searchVisibleProducts('ריהוט טלפון', [STORE], 100);
    expect(both.length).toBeGreaterThan(0);
    expect(impossible).toHaveLength(0);
  });

  it('treats LIKE metacharacters as literal text', async () => {
    // Un-escaped, `%` means "anything" and this would return the whole catalogue.
    expect(await searchVisibleProducts('%', [STORE], 100)).toHaveLength(0);
    expect(await searchVisibleProducts('_', [STORE], 100)).toHaveLength(0);
  });

  it('answers nothing for an empty query, an empty store list or a zero limit', async () => {
    expect(await searchVisibleProducts('   ', [STORE], 10)).toHaveLength(0);
    expect(await searchVisibleProducts('בגדים', [], 10)).toHaveLength(0);
    expect(await searchVisibleProducts('בגדים', [STORE], 0)).toHaveLength(0);
  });

  it('honours the limit', async () => {
    const one = await searchVisibleProducts('מוצר', [STORE], 1);
    expect(one.length).toBeLessThanOrEqual(1);
  });

  it('never crosses into a store the caller did not name', async () => {
    const other = '22222222-2222-4222-8222-000000000002';
    const hits = await searchVisibleProducts('חולצה כחלה', [other], 100);
    expect(hits.map((p) => p.name)).not.toContain('חוּלְצָה כְּחֻלָּה');
  });
});

describe('the search term is bounded', () => {
  // `/api/search` is unauthenticated and a query string carries ~16KB, so the length of the term is
  // request-controlled on a single-threaded SSR server — and it now becomes a LIKE pattern probed
  // against a trigram index. Same cap, and the same reasoning, as the money journal's own search.
  it('caps the raw query before it reaches the matcher', async () => {
    const huge = 'א'.repeat(50_000);
    const started = Date.now();
    const { products, stores } = await searchSite(huge);
    expect(products).toHaveLength(0);
    expect(stores).toHaveLength(0);
    // Not a performance assertion — a bound. Without the cap this walks a 50KB pattern.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('caps how many words one search may AND together', async () => {
    // Every extra word is another index probe; past a handful they only narrow.
    const many = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    expect(await searchVisibleProducts(many, [STORE], 10)).toHaveLength(0);
  });
});
