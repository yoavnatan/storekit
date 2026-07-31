import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getDailyPageViews, recordPageView } from '../src/lib/store-pageviews.js';
import { businessDayISO } from '../src/lib/business-day.js';

// getDailyPageViews reads through a process-local cache of the whole pageviews
// file (see store-pageviews.ts — it is called once per store by the admin
// performance aggregation, and re-parsing a multi-MB file 45 times per request
// was 600ms of a 664ms dashboard render).
//
// A read cache over a file that is also WRITTEN has exactly one way to be wrong:
// serving a copy from before the write. These tests pin that down — a reported
// visitor number that is quietly one write stale is the kind of bug nobody sees
// until the totals stop reconciling.

// `data/*.json` is gitignored runtime state: every dev machine has this file, a fresh CI
// checkout does not, and reading it at import time failed the whole file there. An empty
// store is a perfectly good starting point for a cache test — so create one when it is
// missing, and take it away again rather than leaving a stray file behind.
const PATH = path.join(process.cwd(), 'data/store-pageviews.json');
const preexisting = fs.existsSync(PATH);
if (!preexisting) {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  fs.writeFileSync(PATH, '{}');
}
const original = fs.readFileSync(PATH, 'utf8');
const SLUG = '__cache-test-store__';
const today = businessDayISO(new Date());

afterAll(() => {
  if (preexisting) fs.writeFileSync(PATH, original);
  else fs.rmSync(PATH, { force: true });
});

/** recordPageView is fire-and-forget behind a mutex — let its write land. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('store-pageviews read cache', () => {
  it('sees a write made through this module', async () => {
    const before = getDailyPageViews(SLUG, today, today)[0]!.views;
    recordPageView(SLUG, 'visitor-a');
    await settle();
    expect(getDailyPageViews(SLUG, today, today)[0]!.views).toBe(before + 1);
  });

  it('sees a write made behind its back (another process editing the file)', async () => {
    getDailyPageViews(SLUG, today, today); // warm the cache
    const raw = JSON.parse(fs.readFileSync(PATH, 'utf8')) as Record<string, Record<string, unknown>>;
    raw[SLUG] = { ...(raw[SLUG] ?? {}), [today]: { total: 999, visitors: ['visitor-a', 'visitor-b'] } };
    fs.writeFileSync(PATH, JSON.stringify(raw, null, 2));

    const day = getDailyPageViews(SLUG, today, today)[0]!;
    expect(day.views).toBe(999);
    expect(day.visitors).toEqual(['visitor-a', 'visitor-b']);
  });

  it('a cached read returns the same values as an uncached one', () => {
    const first = getDailyPageViews(SLUG, today, today);
    const second = getDailyPageViews(SLUG, today, today);
    expect(second).toEqual(first);
  });
});
