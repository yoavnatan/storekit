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

  /**
   * The brand prompts, checked for a hole rather than for taste.
   *
   * `bannerPrompt()` interpolates four per-store fields. A missing one does not throw — it writes
   * the word "undefined" into the middle of a prompt and the run pays full price for whatever
   * comes back, which at Pro/2K is a real charge against a real budget with nothing to show for
   * it. That is the class this guards; what the strings SAY is a matter for the eye.
   *
   * The medium moved out of `bannerPrompt` and into `bannerStyle` on 2026-08-14 precisely so the
   * four stores could stop looking alike, so it is now a required field on every store rather
   * than a shared default that could quietly absorb an omission.
   */
  it.each(SHOWCASE_STORES.map((s: { slug: string; name: string }) => [s.name, s.slug]))(
    '%s carries every field the banner and logo prompts interpolate',
    (_name, slug) => {
      const store: Record<string, unknown> = SHOWCASE_STORES
        .find((s: { slug: string }) => s.slug === slug)!;
      for (const field of ['bannerStyle', 'bannerSubject', 'bannerLettering', 'logoStyle', 'logoConcept', 'tagline']) {
        const value = store[field];
        expect(typeof value, `${slug}.${field}`).toBe('string');
        expect((value as string).trim().length, `${slug}.${field} is empty`).toBeGreaterThan(0);
      }
    },
  );

  it('a banner that names a reference image names one that exists', () => {
    // `bannerRefKey` is resolved against the manifest as `<slug>:<key>` and a miss means the banner
    // is silently HELD BACK rather than generated — a run that reports success and produces
    // nothing. Only `__logo` and `__banner` are brand keys, so a typo is catchable here.
    for (const store of SHOWCASE_STORES as { slug: string; bannerRefKey?: string }[]) {
      if (!store.bannerRefKey) continue;
      expect(['__logo', '__banner'], `${store.slug}.bannerRefKey`).toContain(store.bannerRefKey);
    }
  });
});
