/**
 * Guards for the external inventory sync — the class, not the cases.
 *
 * The three properties below are the ones whose failure is INVISIBLE. Nobody watches an hourly job:
 * a sync that quietly stops matching, or stops speaking, looks exactly like a sync with nothing to
 * do. Every one of them was a real bug on 2026-08-19 (a feed keyed by per-combo skus matched
 * nothing at all; three of the four failure shapes returned before the alert could ever see them),
 * and each one passed every existing test on the way in. So these scan the SOURCE for the shape
 * rather than testing one more example — a future refusal, or a future early return, fails here
 * instead of shipping silent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyFeedSyncOutcome, isPlatformWideFeedFailure } from '../src/lib/feed-sync-alert.js';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const SYNC = read('src/lib/store-feed-sync.ts');
const IMPORT = read('src/lib/store-products-import.ts');

/** Every `error: 'x'` a pull can come back with, from both modules on the path. */
function refusalCodes(): string[] {
  const codes = [...SYNC.matchAll(/error:\s*'([a-z-]+)'/g), ...IMPORT.matchAll(/error:\s*'([a-z-]+)'/g)]
    .map((m) => m[1]!);
  return [...new Set(codes)];
}

/**
 * The one code a scheduled run may end on WITHOUT telling anybody, and why: the job only ever picks
 * up stores that have a feed URL, so this is unreachable there — and a seller who cleared their URL
 * asked for the sync to stop. Anything else appearing in this list is a decision someone has to
 * defend in review, which is the whole point of it being a literal here.
 */
const MAY_BE_SILENT = ['no-feed-url'];

describe('every way the pull can refuse must reach the seller', () => {
  it('finds the refusal codes at all — a rewrite that renames them must not empty this test', () => {
    const codes = refusalCodes();
    expect(codes).toContain('no-matcher-column');
    expect(codes.length).toBeGreaterThanOrEqual(4);
  });

  it('classifies each one as something the seller is told', () => {
    for (const code of refusalCodes()) {
      const problem = classifyFeedSyncOutcome(400, { ok: false, error: code });
      if (MAY_BE_SILENT.includes(code)) {
        expect(problem, `${code} is on the silent list`).toBeUndefined();
      } else {
        expect(problem, `${code} would fail an hourly sync with nothing said`).toBeDefined();
      }
    }
  });

  it('covers the fetch failure, whose code is built at runtime and cannot be grepped', () => {
    // `feed-${fetched.error}` — one code per failure the fetcher can have, none of them literals.
    expect(SYNC).toContain('feed-${fetched.error}');
    expect(classifyFeedSyncOutcome(502, { ok: false, error: 'feed-anything-at-all' })).toBe('unreachable');
  });

  it('treats a run that succeeded with refused ROWS as a problem, not a success', () => {
    // The partial case the log line hides: `ok: true`, lastSyncAt stamped, products never touched.
    expect(classifyFeedSyncOutcome(200, { ok: true, results: [{ action: 'update' }, { action: 'error' }] }))
      .toBe('rows-refused');
    expect(classifyFeedSyncOutcome(200, { ok: true, results: [{ action: 'update' }] })).toBeUndefined();
  });
});

describe('the alert sits on EVERY exit of the pull, not beside the write', () => {
  it('is raised by the exported entry point, before the body that returns early', () => {
    // Three of the four failures worth reporting — a dead URL, an empty file, a missing sku column —
    // return long before the import runs. An alert placed beside the write cannot see any of them,
    // which is exactly the bug this pins: the call must come from `syncStoreFeed` itself, which is
    // the only place every one of those returns passes through.
    const alertAt = SYNC.indexOf('alertOnScheduledSync(store');
    const innerAt = SYNC.indexOf('async function runSync');
    expect(alertAt, 'the pull no longer alerts at all').toBeGreaterThan(-1);
    expect(innerAt, 'the single-exit wrapper is gone').toBeGreaterThan(-1);
    expect(alertAt, 'the alert moved inside the body, past the early returns').toBeLessThan(innerAt);
  });

  it('says nothing on the trigger a person is watching', () => {
    expect(SYNC).toMatch(/trigger === 'scheduled'[\s\S]{0,200}alertOnScheduledSync/);
  });

  it('can never fail the sync it reports on', () => {
    expect(SYNC).toMatch(/alertOnScheduledSync\([^)]*\)\s*\.catch\(/);
  });
});

describe('when a failing sync becomes the PLATFORM\'s problem', () => {
  it('is silent about the ordinary case — one seller\'s broken link', () => {
    // They have been told, by the notification. An admin entry per dead vendor URL is how the
    // Alerts tab becomes unreadable at a thousand sellers, which costs the entries that do matter.
    expect(isPlatformWideFeedFailure(200, 1)).toBe(false);
    expect(isPlatformWideFeedFailure(10, 4)).toBe(false);
  });

  it('reports most of them failing at once — two hundred vendors do not go down together', () => {
    expect(isPlatformWideFeedFailure(200, 100)).toBe(true);
    expect(isPlatformWideFeedFailure(10, 5)).toBe(true);
  });

  it('will not page anyone over a single store expressed as a percentage', () => {
    // "1 of 1 failed" is 100% and is still just one broken link.
    expect(isPlatformWideFeedFailure(1, 1)).toBe(false);
    expect(isPlatformWideFeedFailure(2, 2)).toBe(false);
    expect(isPlatformWideFeedFailure(0, 0)).toBe(false);
  });

  it('is wired into the job, on the surface an admin actually reads', () => {
    const REGISTRY = read('src/lib/jobs/registry.ts');
    expect(REGISTRY).toMatch(/isPlatformWideFeedFailure\(stores\.length, failed\)/);
    // `logError` is what fills the admin Alerts tab (scheduler.ts does the same for a thrown job),
    // and it must stay fire-and-forget so a failed alert cannot fail the run it describes.
    expect(REGISTRY).toMatch(/void logError\(\{[\s\S]{0,200}job:feed-sync/);
  });
});

describe('a feed row keyed by a per-combo sku still resolves', () => {
  it('runs the combo-sku pass on every import, not only on the scheduled one', () => {
    // An external system counts blue-L and names it by ITS code, which lives in `variantSku`. With
    // this pass gone, such a feed matches nothing, every row reads as a create, and the run comes
    // back `sku-duplicate` on the seller's whole catalogue — hourly, with nobody reading it.
    expect(IMPORT).toContain('resolveComboSkuRows(rawRows, buildComboSkuIndex(existingProducts))');
  });

  it('applies such a group as a PATCH, so a feed can never delete a combo it did not mention', () => {
    expect(IMPORT).toContain('variantStockPartial');
    const BULK = read('src/lib/store-products-bulk.ts');
    // Merged against the row read inside the write transaction — not against the importer's
    // snapshot, which is minutes old on a scheduled run and would write a sale back out of existence.
    expect(BULK).toMatch(/row\.variantStockPartial && existing\.variants\?\.length/);
    expect(BULK).toContain('...(existing.variantStock ?? {}), ...(row.variantStock ?? {})');
  });
});
