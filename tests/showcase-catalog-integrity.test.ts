/**
 * The showcase catalogs, checked for the things that only break silently.
 *
 * ── Why the duplicate-name check exists ─────────────────────────────────────
 * A product's NAME is its identity in two places that matter. `image-manifest.json` is keyed by
 * `<store>:<name>`, so two products sharing a name share one photograph — and whichever is
 * generated second overwrites the first, which looks like a working catalog until somebody notices
 * two different garments wearing the same picture. It is also what `toSlug` turns into the public
 * URL.
 *
 * This is not hypothetical: twelve menswear rows were added on 2026-08-13 and one of them,
 * "מעיל טרנץ׳ קליל", already existed in the womenswear block forty rows above. Nothing failed. The
 * catalog imported, the seeder would have written both rows, and the two would have quietly shared
 * an image. A hundred-row flat table is exactly the shape where a human cannot see a collision.
 *
 * The LIVE app is safe from this independently — `store-products.ts` settles a slug against a
 * per-store unique index and retries `name-2`, `name-3` on collision — so this test is about the
 * seeded catalog and its images, not about the platform's correctness for real sellers.
 */
import { describe, it, expect } from 'vitest';
import { SHOWCASE_STORES } from '../scripts/lib/showcase/identity.mjs';
import { FASHION_PRODUCTS } from '../scripts/lib/showcase/catalog-fashion.mjs';
import { HOME_PRODUCTS } from '../scripts/lib/showcase/catalog-home.mjs';
import { TECH_PRODUCTS } from '../scripts/lib/showcase/catalog-tech.mjs';
import { PLANT_PRODUCTS } from '../scripts/lib/showcase/catalog-plants.mjs';

interface Row { n: string; d: string; c: number; sub?: string; p: number; w: number; s: string }

const CATALOGS: Record<string, Row[]> = {
  'showcase-fashion': FASHION_PRODUCTS as Row[],
  'showcase-home': HOME_PRODUCTS as Row[],
  'showcase-tech': TECH_PRODUCTS as Row[],
  'showcase-plants': PLANT_PRODUCTS as Row[],
};

describe('showcase catalogs', () => {
  for (const store of SHOWCASE_STORES) {
    const rows = CATALOGS[store.slug]!;

    describe(store.name, () => {
      it('has no two products with the same name', () => {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const row of rows) {
          if (seen.has(row.n)) duplicates.push(row.n);
          seen.add(row.n);
        }
        expect(duplicates, `duplicate product names would share one image and one URL`).toEqual([]);
      });

      it('gives every product a category that the store actually has', () => {
        const bad = rows.filter((r) => !store.categories[r.c]).map((r) => `${r.n} (c:${r.c})`);
        expect(bad).toEqual([]);
      });

      it('gives every product an English image subject', () => {
        // `s` is what the image generator is handed. A row without one produces a picture of
        // nothing in particular, and costs the same as one that works.
        const missing = rows.filter((r) => !r.s || !r.s.trim()).map((r) => r.n);
        expect(missing).toEqual([]);
      });

      it('either gives a category sub-shelves throughout, or not at all', () => {
        // A category where only some rows carry `sub` renders a two-level menu with a half-empty
        // second level — which is how גברים looked before 2026-08-13, and it reads as broken
        // rather than as deliberate.
        for (const [index, name] of store.categories.entries()) {
          const inCategory = rows.filter((r) => r.c === index);
          if (inCategory.length === 0) continue;
          const withSub = inCategory.filter((r) => r.sub).length;
          expect(
            withSub === 0 || withSub === inCategory.length,
            `${name}: ${withSub} of ${inCategory.length} rows have a sub-category`,
          ).toBe(true);
        }
      });
    });
  }
});
