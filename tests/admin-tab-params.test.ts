import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_TAB_PARAMS, stripForeignTabParams } from '../src/lib/admin-nav.js';

// Every admin tab's filter/sort/pager state shares ONE `/admin?` URL, and the tab
// controller only rewrites `panel`. So a param with no registered owner never gets
// cleaned up when its tab is left — it trails into every other tab and comes back
// on the next reload as a filter nobody asked for (the money journal's `mtype` did
// exactly this, סשן ד׳). The map in admin-nav.ts is what makes the cleanup possible;
// this scan is what stops the next filter param from quietly skipping it.
const ADMIN_PAGE = join(process.cwd(), 'src/pages/admin/index.astro');
// The parsers admin/index.astro delegates its query reading to — each owns a slice
// of the same URL, so a param added inside one of them is just as leaky.
const QUERY_PARSERS = [
  'src/lib/admin-stats.ts',
  'src/lib/admin-orders-filter.ts',
  'src/lib/admin-threads-query.ts',
  'src/lib/platform-performance.ts',
].map((p) => join(process.cwd(), p));

// `panel` is the tab selector itself — owned by no single tab, and the one param
// the cleanup must always keep.
const NOT_A_FILTER = new Set(['panel']);

function paramsReadIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const names = new Set<string>();
  // `sp.get('x')` / `params.get('x')` / `searchParams.get('x')` / `parsePage(sp, 'x')`
  for (const m of src.matchAll(/(?:searchParams|params|sp)\.get\(\s*'([^']+)'/g)) names.add(m[1]);
  for (const m of src.matchAll(/parsePage\(\s*\w+\s*,\s*'([^']+)'\s*\)/g)) names.add(m[1]);
  return [...names].filter((n) => !NOT_A_FILTER.has(n));
}

describe('admin tab query-param ownership', () => {
  const owned = new Set(Object.values(ADMIN_TAB_PARAMS).flat());

  it('claims every query param the admin dashboard actually reads', () => {
    const read = [...new Set([ADMIN_PAGE, ...QUERY_PARSERS].flatMap(paramsReadIn))];
    // Sanity: if the scan finds nothing, the regexes rotted, not the code.
    expect(read.length).toBeGreaterThan(15);
    const unclaimed = read.filter((p) => !owned.has(p));
    expect(unclaimed, `add these to ADMIN_TAB_PARAMS in src/lib/admin-nav.ts: ${unclaimed.join(', ')}`).toEqual([]);
  });

  it('gives each param exactly one owning tab', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [tab, params] of Object.entries(ADMIN_TAB_PARAMS)) {
      for (const p of params) {
        if (seen.has(p)) dupes.push(`${p} (${seen.get(p)} + ${tab})`);
        seen.set(p, tab);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('registers a tab for every tab the admin page renders', () => {
    const src = readFileSync(ADMIN_PAGE, 'utf8');
    const tabsBlock = src.slice(src.indexOf('const tabs = ['), src.indexOf('] as const;'));
    const ids = [...tabsBlock.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.filter((id) => !(id in ADMIN_TAB_PARAMS))).toEqual([]);
  });
});

describe('stripForeignTabParams', () => {
  it('drops the params of every other tab', () => {
    const url = stripForeignTabParams(new URL('https://x.test/admin?panel=sellers&sq=dani&mtype=order_created&opage=3'), 'sellers');
    expect(url.searchParams.get('sq')).toBe('dani');
    expect(url.searchParams.get('mtype')).toBeNull();
    expect(url.searchParams.get('opage')).toBeNull();
  });

  it('keeps the active tab selector itself', () => {
    const url = stripForeignTabParams(new URL('https://x.test/admin?panel=moneylog&mtype=order_created&sq=dani'), 'moneylog');
    expect(url.searchParams.get('panel')).toBe('moneylog');
    expect(url.searchParams.get('mtype')).toBe('order_created');
    expect(url.searchParams.get('sq')).toBeNull();
  });

  it('leaves an unknown panel with nothing but the selector', () => {
    const url = stripForeignTabParams(new URL('https://x.test/admin?panel=nope&sq=dani&mtype=order_created'), 'nope');
    expect([...url.searchParams.keys()]).toEqual(['panel']);
  });
});
