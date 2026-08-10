/**
 * The background scheduler — DB_MIGRATION_PLAN.md §8 stage 4a.
 *
 * Three jobs existed, were tested, and were never called, because nothing triggered them. What this
 * file pins is not that they work — their own files already do that — but the two properties the
 * TRIGGER has to have, and which nothing else in the suite could have caught:
 *
 *  1. **One run per period, however many instances.** The process-local mutex that used to serialise
 *     work is gone (§7.5/§4), so several app instances may run at once. A bare `setInterval` in each
 *     would mean N pulls of every seller's feed and N sweeps of the same campaign rows per period.
 *     The claim in `job_runs` is what makes that one run, and it is asserted here by racing claims
 *     concurrently rather than by reading the SQL — the same way §9.5 proved the stock decrement.
 *
 *  2. **Running a job twice is the same as running it once.** The lease reduces double-runs; it
 *     cannot eliminate them (a process paused past its own lease is enough), so every job has to be
 *     safe under one. Each of the three is run twice below and the second pass must change nothing.
 *
 * The money/stock invariant the standing rule asks for lives in `reporting-invariants.test.ts` §8 —
 * it belongs with the other cross-surface invariants, not here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { claimJob, finishJob, getJobRun } from '../src/lib/jobs/job-runs.js';
import { runDueJobs, runJobIfDue, schedulerEnabled, startScheduler, stopScheduler } from '../src/lib/jobs/scheduler.js';
import { JOBS, type Job } from '../src/lib/jobs/registry.js';
import { purgeExpiredCheckouts } from '../src/lib/checkout-idempotency.js';
import { getCampaignsForStore } from '../src/lib/ad-campaign-health.js';
import { createCampaign } from '../src/lib/ad-campaigns.js';
import { getStoresWithFeedUrl } from '../src/lib/stores.js';

let seq = 0;
function jobName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Rewind a job's schedule so it is due again, without waiting out a real interval. */
async function makeDue(name: string): Promise<void> {
  await query(`UPDATE job_runs SET next_run_at = now() - interval '1 second' WHERE name = $1`, [name]);
}

/** Simulate an instance that died mid-run: the claim is still on the row, but its lease has lapsed. */
async function abandonLease(name: string): Promise<void> {
  await query(
    `UPDATE job_runs SET next_run_at = now() - interval '1 second', lease_until = now() - interval '1 second'
      WHERE name = $1`,
    [name],
  );
}

function fakeJob(name: string, run: () => Promise<string>, intervalSec = 3600): Job {
  return { name, intervalSec, leaseSec: 300, run };
}

describe('claiming a job', () => {
  it('gives a never-run job to the first caller, immediately', async () => {
    const name = jobName('first');
    expect(await claimJob(name, 3600, 300)).toBe(true);

    const row = await getJobRun(name);
    // A fresh row is due at once — which is what makes a brand-new deployment run each job on boot.
    expect(row?.runCount).toBe(0);
    expect(row?.leaseUntil).toBeDefined();
    expect(new Date(row!.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a second caller while the first still holds the lease', async () => {
    const name = jobName('held');
    expect(await claimJob(name, 3600, 300)).toBe(true);
    expect(await claimJob(name, 3600, 300)).toBe(false);
  });

  it('refuses a caller after the job finished, until it is due again', async () => {
    const name = jobName('cadence');
    await claimJob(name, 3600, 300);
    await finishJob(name, true, 'done', 5);

    // The lease is gone, so only `next_run_at` is holding the door. This is the clause that survives
    // a restart, and it is the reason a deploy does not re-run every job on every instance.
    expect(await claimJob(name, 3600, 300)).toBe(false);
    await makeDue(name);
    expect(await claimJob(name, 3600, 300)).toBe(true);
  });

  it('takes over a job whose instance died mid-run', async () => {
    const name = jobName('abandoned');
    await claimJob(name, 3600, 300);
    await abandonLease(name);
    // Without the lease clause a crashed process would hold the job for ever; with it, the row
    // becomes claimable again on wall-clock time and nothing has to notice the crash.
    expect(await claimJob(name, 3600, 300)).toBe(true);
  });

  it('EXACTLY ONE of fifty concurrent claims wins', async () => {
    const name = jobName('race');
    // The multi-instance proof. Fifty callers, one row, no lock — the affected-row count is the
    // whole verdict, exactly as in §7.5. Counting successes is the assertion: fifty `true`s would
    // mean fifty feed pulls per hour, and two would mean two.
    const verdicts = await Promise.all(Array.from({ length: 50 }, () => claimJob(name, 3600, 300)));
    expect(verdicts.filter(Boolean)).toHaveLength(1);
  });

  it('stamps the next run from the CLAIM, so a slow run does not push the schedule out', async () => {
    const name = jobName('cadence-drift');
    await claimJob(name, 600, 300);
    const claimedAt = (await getJobRun(name))!.nextRunAt;
    // A long run, then a release. `finishJob` must not touch next_run_at — if it did, the interval
    // would silently become "600s AFTER however long the work took", and a job that takes ten
    // minutes would run half as often as its own configuration says.
    await finishJob(name, true, 'slow', 60_000);
    expect((await getJobRun(name))!.nextRunAt).toBe(claimedAt);
  });
});

describe('recording what a run did', () => {
  it('counts successes and failures separately, and releases the lease either way', async () => {
    const name = jobName('counts');
    await claimJob(name, 3600, 300);
    await finishJob(name, true, 'ok once', 12);
    await makeDue(name);
    await claimJob(name, 3600, 300);
    await finishJob(name, false, 'blew up', 9);

    const row = await getJobRun(name);
    expect(row).toMatchObject({ runCount: 2, failCount: 1, lastStatus: 'failed', lastDetail: 'blew up', lastDurationMs: 9 });
    expect(row?.leaseUntil).toBeUndefined();
  });

  it('cuts an unbounded detail line', async () => {
    // A job's detail can be built from remote input — a feed URL, an HTTP error body — so the
    // column must not be a place a third party can write an arbitrarily long string into.
    const name = jobName('long-detail');
    await claimJob(name, 3600, 300);
    await finishJob(name, false, 'x'.repeat(10_000), 1);
    expect((await getJobRun(name))!.lastDetail!.length).toBe(500);
  });
});

describe('running one', () => {
  it('runs a due job once and records its own summary', async () => {
    const name = jobName('runs');
    let calls = 0;
    const job = fakeJob(name, async () => { calls += 1; return `did ${calls}`; });

    expect(await runJobIfDue(job)).toBe('did 1');
    // Not due again — so a tick every minute does not run an hourly job every minute.
    expect(await runJobIfDue(job)).toBeNull();
    expect(calls).toBe(1);
    expect(await getJobRun(name)).toMatchObject({ lastStatus: 'ok', lastDetail: 'did 1', runCount: 1, failCount: 0 });
  });

  it('a throwing job releases its lease and is retried at its next interval, not sooner', async () => {
    const name = jobName('throws');
    const job = fakeJob(name, async () => { throw new Error('remote feed exploded'); });

    await expect(runJobIfDue(job)).resolves.toBe('remote feed exploded');
    const row = await getJobRun(name);
    // Released — a failure that kept the lease would block the job until the lease expired, which is
    // the failure mode where one bad run silently costs an hour of everything.
    expect(row?.leaseUntil).toBeUndefined();
    expect(row).toMatchObject({ lastStatus: 'failed', failCount: 1 });
  });

  it('does not start a second copy of a job already running in THIS process', async () => {
    // The cross-instance answer is the lease; this is the same-process answer, and it is separate so
    // that a slow job delays only itself and not the whole tick.
    const name = jobName('overlap');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    const job = fakeJob(name, async () => { starts += 1; await gate; return 'once'; });

    const first = runJobIfDue(job);
    await makeDue(name); // due again while the first is still in flight
    expect(await runJobIfDue(job)).toBeNull();
    release();
    await first;
    expect(starts).toBe(1);
  });

  it('reports only the jobs it actually claimed', async () => {
    const due = fakeJob(jobName('due'), async () => 'ran');
    const takenName = jobName('taken');
    await claimJob(takenName, 3600, 300); // another instance holds it
    const taken = fakeJob(takenName, async () => 'should not run');

    expect(await runDueJobs([due, taken])).toEqual({ [due.name]: 'ran' });
  });
});

describe('the registry itself', () => {
  it('names every job uniquely — the name is its primary key', () => {
    expect(new Set(JOBS.map((j) => j.name)).size).toBe(JOBS.length);
  });

  it('gives every job a lease long enough to be worth having', () => {
    for (const job of JOBS) {
      expect(job.intervalSec).toBeGreaterThan(0);
      // A lease shorter than the interval is fine (most runs are quick), but a lease of seconds
      // would let a normal run be taken over mid-flight, which is the overlap it exists to prevent.
      expect(job.leaseSec).toBeGreaterThanOrEqual(60);
    }
  });

  it('wires exactly the registered jobs and nothing else', () => {
    // The three stage-4a consumers, plus `purge-auth-attempts` (added 2026-08-04 with the
    // sign-in rate limiter), `custom-domain-check` (2026-08-06 — a verified domain whose DNS
    // lapsed stayed 'active' forever, so the store 301'd into a dead host and nothing re-read it)
    // and `merchant-status` (2026-08-06 — Google and Meta reject feed rows silently, so a product
    // stops being advertised while the storefront still looks perfectly fine).
    // And `purge-visitor-detail` (2026-08-09) — the only job that deletes rows the application still
    // DISPLAYS inside its window, which is why its idempotency argument and the AUX_EVENTS carve-out
    // it depends on are pinned in a file of their own (`tests/visitor-retention-db.test.ts`) rather
    // than in the double-run pass below.
    // And `feed-artifact` + `sitemap-artifact` (2026-08-09) — the two public documents that used to
    // be assembled inside a request, whole platform catalogue at a time, on the event loop every
    // shopper shares (GO_LIVE §7). They are the only jobs here whose output a route SERVES, so
    // their idempotency argument is about the pointer swap rather than about a delete.
    // The list is asserted whole so a job added without a written idempotency argument above fails
    // here rather than shipping quietly.
    expect(JOBS.map((j) => j.name).sort()).toEqual(
      ['campaign-sweep', 'custom-domain-check', 'feed-artifact', 'feed-sync', 'merchant-status', 'purge-auth-attempts', 'purge-checkouts', 'purge-visitor-detail', 'sitemap-artifact'],
    );
  });
});

describe('the timer', () => {
  afterEach(() => { vi.unstubAllEnvs(); stopScheduler(); });

  it('is off without a database, whatever else is configured', () => {
    // There is no claim table to coordinate through, so a process that started ticking anyway would
    // just log a failure every minute.
    vi.stubEnv('SCHEDULER_ENABLED', '1');
    expect(schedulerEnabled()).toBe(false);
    expect(startScheduler()).toBe(false);
  });

  it('is off in DEV by default, even with real credentials present', () => {
    // The case this default exists for. `.env` on this machine holds the real Neon connection
    // string, so "on wherever DATABASE_URL is set" would have meant `npm run dev` pulling every
    // seller's feed URL from a home network and writing the production catalogue — guarded only by
    // a checklist item, on the one machine where checklist items get skipped.
    vi.stubEnv('DATABASE_URL', 'postgres://x/y');
    expect(import.meta.env.PROD, 'the suite runs as dev, like the dev server').toBe(false);
    expect(schedulerEnabled()).toBe(false);
  });

  it('overrides in BOTH directions, because a one-way switch fits neither case', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://x/y');
    // '1' — run jobs under `astro dev` while working on one.
    vi.stubEnv('SCHEDULER_ENABLED', '1');
    expect(schedulerEnabled()).toBe(true);
    // '0' — a BUILT instance that shares the database without being the server.
    vi.stubEnv('SCHEDULER_ENABLED', '0');
    expect(schedulerEnabled()).toBe(false);
  });

  it('starts at most once and can be stopped', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://x/y');
    vi.stubEnv('SCHEDULER_ENABLED', '1');
    expect(startScheduler()).toBe(true);
    // Idempotent — which is what makes ensureSchedulerStarted safe on the request path.
    expect(startScheduler()).toBe(false);
    stopScheduler();
    expect(startScheduler()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency, per job. The lease makes a double-run unlikely; these make it harmless.
// ---------------------------------------------------------------------------

describe('purge-checkouts is idempotent', () => {
  const job = JOBS.find((j) => j.name === 'purge-checkouts')!;

  beforeEach(async () => {
    await query('DELETE FROM checkout_idempotency');
  });

  it('deletes expired keys on the first pass and nothing on the second', async () => {
    await query(
      `INSERT INTO checkout_idempotency (key, status, at) VALUES
         ('old-1', 'complete', now() - interval '30 hours'),
         ('old-2', 'complete', now() - interval '48 hours'),
         ('fresh', 'complete', now() - interval '1 hour')`,
    );

    expect(await purgeExpiredCheckouts()).toBe(2);
    expect(await purgeExpiredCheckouts()).toBe(0);
    // The one inside the replay window survives both passes — a purge that took it would strip a
    // live buyer of their double-charge protection.
    const { rows } = await query<{ key: string }>('SELECT key FROM checkout_idempotency');
    expect(rows.map((r) => r.key)).toEqual(['fresh']);

    expect(await job.run()).toBe('purged 0');
  });
});

describe('campaign-sweep is idempotent, and does on a timer what only a page view did', () => {
  const job = JOBS.find((j) => j.name === 'campaign-sweep')!;

  async function storeWithCampaign(stock: number): Promise<string> {
    const sellerId = crypto.randomUUID();
    const storeId = crypto.randomUUID();
    const suffix = crypto.randomBytes(4).toString('hex');
    await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
      [sellerId, `${storeId}@example.test`]);
    await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'Sweep test')`,
      [storeId, sellerId, `sweep-${suffix}`]);
    const productId = crypto.randomUUID();
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock) VALUES ($1, $2, $3, 'P', 1000, $4)`,
      [productId, storeId, `p-${suffix}`, stock],
    );
    // With a photo, so the sweep's reason here is the STOCK one these cases are about. Without it
    // the product is not in the Merchant/Catalog feed at all and the campaign pauses as 'no-image'
    // first (ad-campaign-health.ts) — a correct answer to a different question.
    await query(`INSERT INTO product_images (product_id, position, url) VALUES ($1, 0, $2)`,
      [productId, 'https://cdn.example/p.jpg']);
    await createCampaign({
      storeId, storeSlug: `sweep-${suffix}`, scope: 'store', platform: 'both', monthlyBudgetAgorot: 50_000,
    });
    return storeId;
  }

  it('pauses a sold-out campaign, and a second run changes nothing', async () => {
    const storeId = await storeWithCampaign(0);

    await job.run();
    const [afterFirst] = await getCampaignsForStore(storeId);
    // The state the read-time sweep would have reached — except nobody had to open the page.
    expect(afterFirst).toMatchObject({ status: 'paused', pausedReason: 'out-of-stock' });

    await job.run();
    const [afterSecond] = await getCampaignsForStore(storeId);
    // Identical, `pausedAt` included: the sweep is a function of current state, not a transition, so
    // a second pass takes the same decision and finds it already applied.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('resumes by itself once stock returns — which is the promise the card makes', async () => {
    const storeId = await storeWithCampaign(0);
    await job.run();
    expect((await getCampaignsForStore(storeId))[0]).toMatchObject({ status: 'paused', pausedReason: 'out-of-stock' });

    await query('UPDATE store_products SET stock = 4 WHERE store_id = $1', [storeId]);
    await job.run();
    // Before stage 4a this only happened when the seller happened to open their ads page. A seller
    // who restocked and never looked stayed paused indefinitely, which is the opposite of what
    // 'out-of-stock' means (ad-campaign-health.ts).
    expect((await getCampaignsForStore(storeId))[0]).toMatchObject({ status: 'active' });
  });

  it('reports a count without throwing when a store has nothing wrong', async () => {
    const storeId = await storeWithCampaign(9);
    const detail = await job.run();
    expect(detail).toMatch(/failed 0/);
    expect((await getCampaignsForStore(storeId))[0]).toMatchObject({ status: 'active' });
  });
});

describe('feed-sync only touches stores it should', () => {
  const job = JOBS.find((j) => j.name === 'feed-sync')!;

  // Every test here starts from "nobody has a feed", so a store left behind by the previous test
  // cannot make the job reach a real network. A test that fires an outbound request is a test that
  // fails when the machine is offline, and this one would do it from inside the SSRF guard.
  beforeEach(async () => {
    await query('UPDATE stores SET feed_sync = NULL');
  });

  async function storeWithFeed(url: string | null, lifecycle: 'active' | 'blocked' | 'closed'): Promise<string> {
    const sellerId = crypto.randomUUID();
    const storeId = crypto.randomUUID();
    const suffix = crypto.randomBytes(4).toString('hex');
    await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
      [sellerId, `${storeId}@example.test`]);
    await query(
      `INSERT INTO stores (id, seller_id, slug, name, feed_sync, blocked, closed_at)
       VALUES ($1, $2, $3, 'Feed test', $4::jsonb, $5, $6)`,
      [storeId, sellerId, `feed-${suffix}`, url === null ? null : JSON.stringify({ url }),
        lifecycle === 'blocked', lifecycle === 'closed' ? new Date().toISOString() : null],
    );
    return storeId;
  }

  it('finds only the stores that actually have a feed URL', async () => {
    const withUrl = await storeWithFeed('https://vendor.example.com/stock.csv', 'active');
    const blank = await storeWithFeed('   ', 'active');
    const none = await storeWithFeed(null, 'active');

    const ids = (await getStoresWithFeedUrl()).map((s) => s.id);
    expect(ids).toContain(withUrl);
    // A whitespace-only URL is not a URL. Left in, it would be one failed outbound request per store
    // per hour, for ever, reported as a failure nobody can act on.
    expect(ids).not.toContain(blank);
    expect(ids).not.toContain(none);
  });

  it('is bounded, and hands the cap to whoever has waited longest', async () => {
    // This is the one job whose duration grows with the platform — one outbound request per store,
    // in sequence. Unbounded, a thousand feed-syncing stores would outlast the 30-minute lease and a
    // second instance would start a duplicate pass. Nothing breaks (the job is idempotent), but the
    // hour is spent doing the work twice.
    const never = await storeWithFeed('https://vendor.example.com/a.csv', 'active');
    const stale = await storeWithFeed('https://vendor.example.com/b.csv', 'active');
    const recent = await storeWithFeed('https://vendor.example.com/c.csv', 'active');
    await query(`UPDATE stores SET feed_sync = feed_sync || jsonb_build_object('lastSyncAt', $2::text) WHERE id = $1`,
      [stale, '2020-01-01T00:00:00.000Z']);
    await query(`UPDATE stores SET feed_sync = feed_sync || jsonb_build_object('lastSyncAt', $2::text) WHERE id = $1`,
      [recent, '2099-01-01T00:00:00.000Z']);

    // Never-synced first, then oldest — so the cap is a rotation and not a cut-off: a store that did
    // not fit this run is first in the next one, and one that has never synced never starves.
    expect((await getStoresWithFeedUrl()).map((s) => s.id)).toEqual([never, stale, recent]);
    expect((await getStoresWithFeedUrl(2)).map((s) => s.id)).toEqual([never, stale]);
  });

  it('skips a store that may not sell, without a second copy of the lifecycle rules in SQL', async () => {
    await storeWithFeed('https://vendor.example.com/stock.csv', 'blocked');
    await storeWithFeed('https://vendor.example.com/stock.csv', 'closed');

    // Both are in the query's answer — the filter is deliberately NOT in the WHERE clause, so
    // `store-status.ts` stays the only place that says what "may sell" means.
    const found = await getStoresWithFeedUrl();
    expect(found.filter((s) => s.blocked || s.closedAt).length).toBeGreaterThanOrEqual(2);

    // …and the job pulls for neither. Every remaining store in the fixture has no feed URL, so the
    // run reaches no network at all.
    const detail = await job.run();
    expect(detail).toMatch(/^stores 0 · /);
  });
});
