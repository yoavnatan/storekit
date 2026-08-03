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
import { searchVisibleProducts } from '../src/lib/store-products.js';
import { searchSite } from '../src/lib/site-search.js';

/** Every trap the normaliser handles, plus the plain cases that must survive it. */
const CORPUS: Array<{ name: string; tags: string[] }> = [
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
];

const STORE = '22222222-2222-4222-8222-000000000001'; // fixture store — see tests/fixtures/db-data
const ids: string[] = [];

beforeAll(async () => {
  for (const { name, tags } of CORPUS) {
    const id = crypto.randomUUID();
    ids.push(id);
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, tags)
       VALUES ($1, $2, $3, $4, 1000, $5::text[])`,
      [id, STORE, `search-fixture-${ids.length}`, name, tags],
    );
  }
});

describe('product_search_text() is normalizeHe()', () => {
  it('agrees character for character on every trap in the corpus', async () => {
    const { rows } = await query<{ id: string; name: string; tags: string[]; search_text: string }>(
      `SELECT id, name, tags, search_text FROM store_products WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(rows).toHaveLength(CORPUS.length);
    for (const row of rows) {
      expect(row.search_text).toBe(normalizeHe(`${row.name} ${(row.tags ?? []).join(' ')}`));
    }
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
    const { rows } = await query<{ name: string; tags: string[] }>(
      `SELECT name, tags FROM store_products
        WHERE store_id = $1 AND NOT hidden AND NOT blocked
        ORDER BY created_at DESC, id`,
      [STORE],
    );
    return rows
      .filter((r) => matchesQueryWords(q, `${r.name} ${(r.tags ?? []).join(' ')}`))
      .map((r) => r.name);
  }

  for (const q of ['בגדים', 'חולצה כחולה', 'shirt', 'tops', 'ריהוט סלון', 'כתיבה', 'מוצר']) {
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
