/**
 * A public route may not assemble the whole platform catalogue.
 *
 * **The failure this is a guard against actually shipped, and it shipped as a note.**
 * `/api/feed/products.xml` and `/sitemap-content.xml` each walked every indexable store, every
 * visible product and every category tree into one string, per request. Measured here: 45 stores put
 * the feed at 6.1 seconds. Node serves one event loop, so for those seconds every other request in
 * the process waits — a shopper at checkout included — and at a thousand sellers the same code is a
 * several-hundred-megabyte allocation in one process, which is an OOM rather than a slow page. The
 * code carried a comment saying it should become a pre-built artifact "at DB-migration time"; the
 * migration landed 2026-08-03 and the change did not happen for six days. A comment is not a gate.
 *
 * **What this asserts is a SHAPE, not a file.** It scans `src/pages/` rather than checking the two
 * routes that were fixed, because the next one will be a different route — a bulk export, an
 * admin CSV, a second feed for a different network. The rule: a page or endpoint may not both
 * enumerate every indexable store AND read a catalogue keyed by that list. Work that needs the
 * whole mall belongs in a builder a job runs (`lib/*-document.ts` → `lib/artifacts.ts`).
 *
 * **What it deliberately allows.** Reading the store LIST alone is fine — one row per store, no
 * catalogue attached, and `llms.txt` does exactly that to name fifty of them. Reading a catalogue
 * for a BOUNDED set of stores is fine too: the homepage draws product cards for the five stores its
 * spotlight chose. The failure is the join of the two, which is the only shape that grows with the
 * platform.
 *
 * Area audit row 9 (`review-diff` skill) named this test as the condition for closing "Behaviour
 * under load". GO_LIVE §7.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAGES = path.join(ROOT, 'src/pages');

/** Enumerates every indexable store on the platform, with no limit and no caller-supplied list. */
const PLATFORM_WIDE_STORES = 'getIndexableStores(';

/** Reads a catalogue for however many stores it is handed — bounded only by its argument. */
const CATALOGUE_BY_STORE_IDS = [
  'getVisibleProductsByStoreIds(',
  'getVisibleProductRefsByStoreIds(',
  'getCategoriesByStoreIds(',
  'getPurchasedCountsByStoreSlugs(',
];

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return /\.(ts|astro)$/.test(entry.name) ? [full] : [];
  });
}

describe('no public route builds an unbounded document', () => {
  it('never joins "every indexable store" to a catalogue read, anywhere under src/pages', () => {
    const offenders: string[] = [];
    for (const file of routeFiles(PAGES)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes(PLATFORM_WIDE_STORES)) continue;
      const reads = CATALOGUE_BY_STORE_IDS.filter((reader) => source.includes(reader));
      if (reads.length) offenders.push(`${path.relative(ROOT, file)} → ${reads.join(', ')}`);
    }
    expect(
      offenders,
      'a route that fans out over every store belongs in a builder a job runs — see lib/artifacts.ts',
    ).toEqual([]);
  });

  it('the documents that used to do it are served, not built', () => {
    const routes = {
      'api/feed/products.xml.ts': 'serveCatalogArtifact',
      'sitemap-content.xml.ts': 'serveCatalogArtifact',
      'sitemap-content-[shard].xml.ts': 'serveSitemapShard',
    };
    for (const [route, handoff] of Object.entries(routes)) {
      const source = fs.readFileSync(path.join(PAGES, route), 'utf8');
      expect(source, `${route} must hand off to the artifact layer`).toContain(handoff);
      // The walks themselves. A route that imports one is a route that is assembling something,
      // whatever it enumerates to do it.
      expect(source, `${route} must not serialise a feed`).not.toContain('toMerchantXml');
      expect(source, `${route} must not run the platform sitemap walk`).not.toContain('platformSitemapEntries');
    }
  });

  it('both documents are on the schedule, so "pre-built" is a fact and not an intention', async () => {
    // A builder nothing calls is the state this whole change replaced: correct code, never run.
    const { JOBS } = await import('../src/lib/jobs/registry.js');
    const names = JOBS.map((j) => j.name);
    expect(names).toContain('feed-artifact');
    expect(names).toContain('sitemap-artifact');
  });
});
