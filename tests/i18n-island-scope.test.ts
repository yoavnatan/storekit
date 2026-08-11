import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsDashboardI18n } from '../src/lib/i18n-island.js';

/**
 * `#i18n-data` (BaseLayout.astro) is the JSON island client scripts read strings
 * from. Its `dashboard` slice is 34.9KB — 95% of the whole island — and since
 * 2026-08-03 it is emitted ONLY on the `/seller`, `/admin` and `/buyer` areas,
 * because those are the only places anything reads it. Everywhere else it was
 * 34.9KB of HTML on the pages whose weight is the SEO surface.
 *
 * The gate is a path prefix, so it fails SILENTLY in one direction: a consumer that
 * ends up on some other route reads `.dashboard`, gets `undefined`, falls back to
 * its English literal and shows it inside a Hebrew UI rather than throwing. Nobody
 * notices until a shopper does. Hence a mechanical rule.
 *
 * It is checked by FILE LOCATION, not by walking the import graph. Following
 * imports was tried first and is the wrong instrument here: it answers "can this
 * module be reached", while the actual question is "can the code path that reads
 * the dict be reached" — and the two differ (see the ui.ts note below), so the
 * graph version reported the whole site. Location is exact and needs no model.
 *
 * The reverse direction needs no test: a dashboard route that stops needing the
 * strings just ships a few KB it doesn't use.
 */

// fileURLToPath, not `.pathname` — this repo's own directory name is Hebrew, and
// `.pathname` hands back the percent-encoded form, which `readdirSync` cannot open.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Directories whose files only ever load on a route BaseLayout emits `dashboard` on. */
const DASHBOARD_ONLY_DIRS = [
  'scripts/dashboard',
  'scripts/admin',
  'components/dashboard',
  'components/admin',
  'pages/seller',
  'pages/admin',
  'pages/buyer',
];

/**
 * `scripts/dashboard/ui.ts` is the one file outside those directories' guarantee,
 * and it is deliberate: the HOMEPAGE imports `initDashTabs` from it for its own tab
 * strip (see pages/index.astro). That is safe only because the dict is read inside
 * `initSettingsForm`, which the homepage never calls — a function-level fact no
 * file-location rule can see, so the assertion below pins it instead.
 */
const UI_TS = join('scripts', 'dashboard', 'ui.ts');

/** Reads `.dashboard` off the island — the exact shape every consumer uses today. */
const READS_DASHBOARD = /getElementById\(\s*['"]i18n-data['"]\s*\)[\s\S]{0,80}?\.dashboard\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('#i18n-data dashboard slice stays inside the routes that ship it', () => {
  const readers = walk(SRC)
    .filter((f) => READS_DASHBOARD.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f));

  it('finds the known consumers, so a broken matcher cannot pass by matching nothing', () => {
    expect(readers.length).toBeGreaterThan(5);
  });

  it('the three areas are still the whole list, and the slice is still conditional', () => {
    const gate = readFileSync(join(SRC, 'lib', 'i18n-island.ts'), 'utf8');
    expect(gate).toMatch(/DASHBOARD_AREAS\s*=\s*\['\/seller',\s*'\/admin',\s*'\/buyer'\]/);
    const layout = readFileSync(join(SRC, 'layouts', 'BaseLayout.astro'), 'utf8');
    expect(layout).toMatch(/needsDashboardStrings\s*\?\s*\{\s*dashboard:\s*t\.dashboard\s*\}/);
  });

  it('every consumer lives where only a dashboard route can load it', () => {
    const stranded = readers.filter(
      (f) => f !== UI_TS && !DASHBOARD_ONLY_DIRS.some((d) => f.startsWith(d.split('/').join(sep) + sep)),
    );
    expect(
      stranded,
      `these read #i18n-data.dashboard but sit outside the dashboard-only directories, so a ` +
        `shopper-facing route can load them and they would silently read undefined. Either move ` +
        `the strings out of the dashboard dict, or widen DASHBOARD_ROUTES in BaseLayout.astro ` +
        `AND the list here.`,
    ).toEqual([]);
  });

  it('the gate fires for every dashboard route, INCLUDING each area root', () => {
    // The half this file never checked. It proves each reader sits on a dashboard route; nothing
    // proved the gate matches that route, and it did not: `'/admin/'` as a prefix, with a trailing
    // slash, against a site configured `trailingSlash: 'never'`. So `/admin` — the admin dashboard
    // itself, where the performance, advertising and data panels all read the dict — shipped none
    // of its strings and every client-built label fell back to English inside a Hebrew UI.
    for (const path of ['/admin', '/seller', '/buyer']) {
      expect(needsDashboardI18n(path), `${path} — the area root is a real page`).toBe(true);
      expect(needsDashboardI18n(`${path}/`), `${path}/ — and its slashed form`).toBe(true);
    }
    for (const path of ['/admin/store/keramika/performance', '/seller/dashboard', '/buyer/orders']) {
      expect(needsDashboardI18n(path), path).toBe(true);
    }
    // And it must stay a gate: these are the shopper-facing pages the 34.9KB was removed from.
    for (const path of ['/', '/stores', '/checkout', '/keramika', '/administrators', '/sellers-guide']) {
      expect(needsDashboardI18n(path), `${path} must NOT carry the dashboard dict`).toBe(false);
    }
  });

  it('BaseLayout decides with that function rather than a second copy of the rule', () => {
    // A prefix list re-typed in the layout is how the first one drifted from the router.
    const layout = readFileSync(join(SRC, 'layouts', 'BaseLayout.astro'), 'utf8');
    expect(layout).toMatch(/needsDashboardI18n\(/);
    expect(layout, 'no inline path-prefix list beside the call').not.toMatch(/DASHBOARD_ROUTES/);
  });

  it('the homepage\'s borrowed ui.ts export still cannot reach the dict', () => {
    const ui = readFileSync(join(SRC, UI_TS), 'utf8');
    // The dict is read through this one accessor; every call site must be inside a
    // function the homepage does not call. Today that is initSettingsForm alone.
    const callers = [...ui.matchAll(/export function (\w+)[\s\S]*?(?=\nexport function |\n?$)/g)]
      .filter(([body]) => /getI18nDict\(/.test(body))
      .map(([, name]) => name);
    expect(
      callers,
      'a second ui.ts export now reads the dashboard dict. pages/index.astro imports ' +
        'initDashTabs from this file, so anything it can reach runs on the homepage, where ' +
        'BaseLayout does not emit those strings.',
    ).toEqual(['initSettingsForm']);
  });
});
