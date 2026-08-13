import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The showcase stores must never reach Google or Meta. Not the stores, and not one product of them.
 *
 * **Why this test exists (owner, 2026-08-12, emphatically).** The three showcase stores are
 * fabricated catalog with generated photography. A fabricated listing in Merchant Center is not an
 * aesthetic problem, it is a policy violation against the ONE Merchant Center account the whole
 * platform shares — so the blast radius of a single leaked product is every seller's ads at once
 * (memory `project_ad_platform_account_risk`).
 *
 * `tests/demo-stores.test.ts` already covers `lib/demo-stores.ts` as a pure module: what
 * `isDemoStore` answers, what the hide-threshold does. It cannot catch the failure that actually
 * matters here, which is a SURFACE that stops asking. That failure is silent by construction —
 * the feed still builds, the sitemap is still valid XML, nothing errors, there are simply extra
 * URLs in it. So this pins the wiring instead: `getIndexableStores` is the single gate, and every
 * outbound surface goes through it.
 */

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('getIndexableStores is the one gate', () => {
  it('excludes every demo store, unconditionally', () => {
    const src = read('lib/stores.ts');
    // Not thresholded, not "unless empty", not a parameter — a bare filter on the flag.
    expect(src).toMatch(/export async function getIndexableStores[\s\S]{0,220}?filter\(\(s\) => !isDemoStore\(s\)\)/);
  });

  it('is distinct from the shopper-facing list, which IS thresholded', () => {
    // The two must not be collapsed: shopper surfaces show demo stores while the mall is thin,
    // outbound surfaces never do. One function serving both is the bug this guards.
    const src = read('lib/stores.ts');
    expect(src).toContain('export async function getShopperStores');
    expect(src).toContain('export async function getIndexableStores');
  });
});

describe('every outbound surface sources demo-free stores', () => {
  const OUTBOUND: [string, string][] = [
    ['lib/feed-document.ts', 'the Google Merchant / Meta product feed'],
    ['lib/sitemap-document.ts', 'the platform sitemap'],
    ['pages/llms.txt.ts', 'llms.txt'],
  ];

  it.each(OUTBOUND)('%s (%s) walks getIndexableStores', (file) => {
    const src = read(file);
    expect(src).toContain('getIndexableStores');
    // …and not the wider lists, either of which would readmit the showcase stores.
    expect(src).not.toMatch(/\bawait\s+get(All|Visible|Shopper)Stores\(/);
  });

  it('the per-store sitemap on a custom domain refuses a demo store too', () => {
    // A store served from its own host bypasses the platform sitemap entirely, so it needs its
    // own check — this is the branch that would otherwise publish one showcase store's whole
    // catalogue from a domain nobody was watching.
    expect(read('pages/sitemap-content.xml.ts')).toMatch(/isDemoStore\(store\)/);
  });

  it('IndexNow refuses to ping for a demo store on every entry point', () => {
    const src = read('lib/indexnow.ts');
    expect(src.match(/isDemoStore\(store\)/g) ?? []).toHaveLength(3);
  });
});

describe('the store and product pages tell a crawler not to index', () => {
  it('a demo store page is noindex', () => {
    expect(read('pages/[storeSlug]/index.astro')).toMatch(/noindex=\{[^}]*isDemo/);
  });

  it('a demo product page is noindex', () => {
    expect(read('pages/[storeSlug]/[productSlug].astro')).toMatch(/noindex=\{[^}]*isDemo/);
  });
});
