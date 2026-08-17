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

      it('every product named in cardProducts is in the catalog, and there are at most four', () => {
        // The card draws STORE_PREVIEW_SLOTS thumbnails (4). A fifth name here would be dated as
        // the newest product in the store and then never shown — which looks like the staging
        // silently failing rather than like a list that is one too long.
        const named: string[] = (store as { cardProducts?: string[] }).cardProducts ?? [];
        const names = new Set(rows.map((r) => r.n));
        expect(named.filter((n) => !names.has(n))).toEqual([]);
        expect(named.length).toBeLessThanOrEqual(4);
        expect(new Set(named).size).toBe(named.length);
      });

      it('every product named in backdropAccentAlways is actually in the catalog', () => {
        // A name list fails SILENTLY: rename the product and the entry simply stops matching, the
        // run still costs the same, and the only symptom is a store card that quietly went back to
        // plain grey — which nobody would connect to a rename weeks earlier.
        const named: string[] = (store as { backdropAccentAlways?: string[] }).backdropAccentAlways ?? [];
        const names = new Set(rows.map((r) => r.n));
        expect(named.filter((n) => !names.has(n))).toEqual([]);
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

  it('a store never points its banner and its logo at each other', () => {
    /**
     * The two brand images may derive one from the other, and the direction is the whole point:
     * whichever is NOT the reference is the source of the store's mark. Set both and there is no
     * source — regenerating either would redefine the other, and the drift would only ever be
     * visible as "the avatar and the banner face different ways", which is the exact defect this
     * pairing was introduced to fix (סהר, 2026-08-14).
     *
     * It is also a real generation-order hazard: the banner job runs before the logo job, so a
     * store with both set would hand the logo a banner drawn from last round's logo.
     */
    for (const store of SHOWCASE_STORES as { slug: string; bannerRefKey?: string; logoRefKey?: string }[]) {
      expect(
        Boolean(store.bannerRefKey && store.logoRefKey),
        `${store.slug}: bannerRefKey and logoRefKey are both set — one picture has to be the source`,
      ).toBe(false);
    }
  });

  it('a logo that names a reference image names one that exists', () => {
    for (const store of SHOWCASE_STORES as { slug: string; logoRefKey?: string }[]) {
      if (!store.logoRefKey) continue;
      expect(['__logo', '__banner'], `${store.slug}.logoRefKey`).toContain(store.logoRefKey);
    }
  });

  /**
   * `logoCut` is the OTHER way an avatar can come to exist — cut out of the banner instead of drawn
   * again (`markCutUrl`, added 2026-08-17 after four rounds of trying to make a redraw match). It
   * arrived with no guard at all, which is what this session's own close-out audit found.
   *
   * Two ways it can be wrong, both silent:
   *
   *   **Both routes at once.** `buildJobs` branches on `logoCut` and simply ignores `logoRefKey`, so
   *   a store carrying both would keep a reference that nothing reads — the same class of dead
   *   declaration that made the mark and the banner disagree for three rounds, since the file would
   *   claim a relationship the pipeline no longer has.
   *
   *   **A cycle.** The cut reads FROM the banner. If that same store also drew its banner from its
   *   logo (`bannerRefKey`), neither picture would be the source and a regeneration of either would
   *   redefine the other — the exact hazard the bannerRefKey/logoRefKey test above exists for,
   *   reachable again through the new field.
   */
  it('a logo that is CUT names one source, and never also a drawn one', () => {
    type Cutter = {
      slug: string;
      bannerRefKey?: string;
      logoRefKey?: string;
      logoCut?: { key?: string; crop?: string; tolerance?: number; pad?: string };
    };
    for (const store of SHOWCASE_STORES as Cutter[]) {
      const { logoCut } = store;
      if (!logoCut) continue;

      expect(['__logo', '__banner'], `${store.slug}.logoCut.key`).toContain(logoCut.key);
      expect(logoCut.crop, `${store.slug}.logoCut.crop`).toMatch(/^c_crop,/);
      // `e_make_transparent` takes 0–100 and the value is the whole risk of this route: too high
      // and the mark's own pale panes go transparent with the wall behind it.
      expect(typeof logoCut.tolerance, `${store.slug}.logoCut.tolerance`).toBe('number');
      expect(logoCut.pad, `${store.slug}.logoCut.pad`).toMatch(/^[0-9a-f]{6}$/);

      expect(
        Boolean(store.logoRefKey),
        `${store.slug}: logoCut and logoRefKey are both set — buildJobs reads only logoCut, so the reference is dead`,
      ).toBe(false);
      expect(
        logoCut.key === '__banner' && Boolean(store.bannerRefKey),
        `${store.slug}: the logo is cut FROM the banner while the banner is drawn from the logo — neither is the source`,
      ).toBe(false);
    }
  });

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
