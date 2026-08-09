/**
 * What the scheduler runs, and how often. One entry per job, nothing else.
 *
 * These three are the whole of DB_MIGRATION_PLAN.md §8 stage 4a: code that was written, tested and
 * never called, because there was no periodic trigger. `scheduler.ts` supplies the trigger,
 * `job-runs.ts` decides which instance may act on it, and this file is the list.
 *
 * **Every job here MUST be idempotent** — running it twice must leave the same state as running it
 * once. The lease in migration 0007 makes a double-run unlikely, not impossible (a process paused
 * past its own lease is enough), and none of the three may be allowed to double anything. Each
 * bullet below says why its job is safe, and it is asserted rather than assumed: the purge and the
 * sweep are run twice in `tests/jobs-scheduler.test.ts`, the feed pull in
 * `tests/store-feed-sync.test.ts` (it needs the network stubbed), and `reporting-invariants` §8
 * puts a whole pass over all three between two readings of the platform's money and stock totals.
 *
 * **A job never throws out of `run`.** The scheduler catches, but a job that gives up on the first
 * failing store would leave the rest of the platform unsynced because one seller's feed URL went
 * down. So the two per-store jobs isolate each store and report counts.
 */
import { purgeExpiredCheckouts } from '../checkout-idempotency.js';
import { purgeExpiredAuthAttempts } from '../rate-limit.js';
import { purgeOldAnalyticsVisitors } from '../analytics.js';
import { purgeOldStoreViewVisitors } from '../store-pageviews.js';
import { visitorRetentionCutoffISO } from '../visitor-retention.js';
import { getStoresWithFeedUrl, getStoresWithCustomDomain, canStoreSell } from '../stores.js';
import { reverifyCustomDomains } from '../custom-domain-verify.js';
import { syncStoreFeed, syncedRowCount } from '../store-feed-sync.js';
import { getStoreIdsWithLiveCampaigns } from '../ad-campaigns.js';
import { getCampaignsForStore } from '../ad-campaign-health.js';
import { runMerchantStatusCheck } from '../merchant-status-check.js';

export interface Job {
  /** Primary key in `job_runs`. Never rename one — the row is the schedule's memory, and a renamed
   *  job is a new row, which is due immediately and runs on the next tick. */
  name: string;
  /** How often it should start, in seconds. Measured start-to-start (job-runs.ts#claimJob). */
  intervalSec: number;
  /** How long one run may hold the job before another instance may take it over. Must comfortably
   *  exceed the realistic worst case, or two instances overlap on a slow run. */
  leaseSec: number;
  /** Does the work and returns the one line recorded on the row. Must not throw. */
  run(): Promise<string>;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Drop replayed-checkout records past their 24h window.
 *
 * *Idempotent:* it is a `DELETE … WHERE at < cutoff`. A second pass finds nothing left to delete.
 * Nothing reads a record older than the window either, so an unpurged row and a purged one are
 * indistinguishable to the application — this job manages table size, not correctness, which is why
 * it can afford to run rarely.
 */
const purgeCheckouts: Job = {
  name: 'purge-checkouts',
  intervalSec: 6 * HOUR,
  leaseSec: 5 * MINUTE,
  async run() {
    return `purged ${await purgeExpiredCheckouts()}`;
  },
};

/**
 * Pull every store's external inventory feed and apply it (GO_LIVE §6.1).
 *
 * *Idempotent:* the import matches rows by sku and SETS stock and price — an absolute write, not a
 * delta — and a second pass over an unchanged feed resolves every row as `unchanged` and writes
 * nothing (`store-feed-sync.ts`).
 *
 * *Skips stores that cannot sell*, over the lifecycle predicate rather than a second copy of it in
 * SQL: a blocked, closed or seller-paused store has no storefront to keep in step, so pulling a
 * remote URL on its behalf is traffic sent to a third party for nothing — and for a blocked store,
 * it is the platform continuing to act on behalf of an account it took down.
 *
 * *Hourly:* the pull is an outbound request to somebody else's server, once per store per period.
 * A seller who needs stock in step within seconds needs a push from their own system, which is what
 * the outbound export token is for; this is the "keep it roughly right without anyone remembering
 * to press a button" half.
 */
const FEED_BATCH = 200;

const feedSync: Job = {
  name: 'feed-sync',
  intervalSec: 1 * HOUR,
  leaseSec: 30 * MINUTE,
  async run() {
    // Longest-unsynced first, capped — see `getStoresWithFeedUrl` for why this job in particular
    // needs a bound. The cap is announced below rather than applied quietly.
    const batch = await getStoresWithFeedUrl(FEED_BATCH);
    const stores = batch.filter(canStoreSell);
    let ok = 0, failed = 0, rows = 0;
    for (const store of stores) {
      try {
        // 'scheduled', not 'seller': the timer applies only the mapping the seller confirmed and
        // refuses a feed with no matcher column, instead of inferring either (store-feed-sync.ts).
        const { body } = await syncStoreFeed(store, true, 'scheduled');
        if (body.ok) { ok++; rows += syncedRowCount(body); }
        else failed++;
      } catch {
        // One store's feed being unreachable, malformed or hostile must not stop the rest. The
        // count is what the run reports; the seller's own dashboard shows them their lastSyncAt.
        failed++;
      }
    }
    const capped = batch.length === FEED_BATCH ? ` · capped at ${FEED_BATCH}, the rest go first next run` : '';
    return `stores ${stores.length} · ok ${ok} · failed ${failed} · rows ${rows}${capped}`;
  },
};

/**
 * Re-run every advertising store's campaign health check.
 *
 * *What it fixes:* the sweep already exists and is correct, but it runs ON A READ — when the seller
 * opens their ads page (`ad-campaign-health.ts#getCampaignsForStore`). That was fine while a paused
 * campaign only mattered on screen. It stops being fine the moment real billing is wired, because
 * the two states it decides both move money: a campaign whose products went out of stock keeps
 * buying clicks nobody can convert until someone happens to load the page, and a campaign that sold
 * out and then restocked stays paused — the platform promising it resumes by itself, and not
 * resuming, because nobody visited. On a timer both happen without a visit.
 *
 * *Idempotent by construction:* the sweep is a function of current state, not a transition. Running
 * it twice takes the same decisions the second time and finds them already applied, so the second
 * pass writes nothing. This is also why the job calls the same function the page calls instead of
 * re-deriving the rules — a second copy of "when may a campaign resume" is a copy that drifts, on
 * the numbers the owner reads as money (memory `project_brand_boost_twin_drift`).
 *
 * *Every quarter hour:* fast enough that spend on a dead product is bounded by minutes, slow enough
 * that a platform with no advertisers costs one query per tick.
 */
const campaignSweep: Job = {
  name: 'campaign-sweep',
  intervalSec: 15 * MINUTE,
  leaseSec: 10 * MINUTE,
  async run() {
    const storeIds = await getStoreIdsWithLiveCampaigns();
    let paused = 0, active = 0, failed = 0;
    for (const storeId of storeIds) {
      try {
        for (const campaign of await getCampaignsForStore(storeId)) {
          if (campaign.status === 'paused') paused++;
          else if (campaign.status === 'active') active++;
        }
      } catch { failed++; }
    }
    return `stores ${storeIds.length} · active ${active} · paused ${paused} · failed ${failed}`;
  },
};

/**
 * Drop failed-sign-in counters whose window has lapsed (`lib/rate-limit.ts`).
 *
 * *Idempotent:* a `DELETE … WHERE window_start < cutoff`, like `purge-checkouts`. A second pass
 * finds nothing.
 *
 * *Correctness does not depend on it,* which is what makes it safe to run rarely: an expired row is
 * already invisible to `checkAuthRate`, which tests the window rather than the row's existence, and
 * the next failure on that bucket rolls it forward in one statement. This job manages table size —
 * and the size it manages is specifically the aftermath of a credential-stuffing run, which leaves
 * one row per address tried and would otherwise sit there indefinitely, since normal use deletes its
 * own row on the next successful sign-in.
 */
const purgeAuthAttempts: Job = {
  name: 'purge-auth-attempts',
  intervalSec: 6 * HOUR,
  leaseSec: 5 * MINUTE,
  async run() {
    return `purged ${await purgeExpiredAuthAttempts()}`;
  },
};

/**
 * Drop per-visitor detail past the retention window (`lib/visitor-retention.ts`).
 *
 * *What it is for:* these are the only two tables in the schema that grow with **traffic** and had
 * nothing bounding them — one row per person per day, forever. Everything else is either aggregated
 * (a row per day, per store, per product), capped at write time (`error_log`) or already purged
 * (`checkout_idempotency`, `auth_attempts`). At the platform's target scale the difference is
 * between a table that reaches a ceiling and one that reaches tens of millions of rows a year, under
 * every dashboard query that has to walk its index.
 *
 * *Idempotent:* two `DELETE … WHERE day < cutoff` statements, like the two purges above. A second
 * pass finds nothing. The cutoff comes from the business calendar and is computed ONCE here rather
 * than per statement, so both tables are cut on the same day even if the run straddles midnight.
 *
 * *Daily, not hourly:* a day's worth of rows is what a single pass removes, and running it more
 * often only re-asks a question whose answer changes once a day. Deliberately the LAST job in the
 * registry list — it is the only one that deletes rows the application still displays inside its
 * window, so if a session ever reads this log top-down, it reads in order of blast radius.
 */
const purgeVisitorDetail: Job = {
  name: 'purge-visitor-detail',
  intervalSec: 24 * HOUR,
  leaseSec: 10 * MINUTE,
  async run() {
    const cutoff = visitorRetentionCutoffISO();
    // Sequential, not Promise.all: two DELETEs over large tables, and there is no click waiting on
    // them. Holding one pooled connection for twice as long beats holding two — the pool has ten,
    // and a shopper's page load needs one of them more than this job needs to finish sooner.
    const analytics = await purgeOldAnalyticsVisitors(cutoff);
    const stores = await purgeOldStoreViewVisitors(cutoff);
    return `before ${cutoff}: purged ${analytics} analytics + ${stores} store visitor rows`;
  },
};

/**
 * Re-ask the edge provider whether each seller's custom domain still verifies.
 *
 * *What it fixes:* the status was written only when a human pressed "check" in the dashboard, and
 * the application treats it as live fact — an 'active' domain is the store's canonical, what every
 * platform surface links to, and where the platform path 301s. A seller who unpointed their CNAME
 * took their own store offline permanently, and nothing was ever going to notice. The reverse case
 * is just as silent: a domain that finished verifying an hour after the seller closed the tab stayed
 * 'pending' forever. See `custom-domain-verify.ts` for both, and for why a mass demotion is refused
 * rather than applied.
 *
 * *Idempotent:* it is a function of the provider's current answer, not of a transition. A second
 * pass asks the same question, gets the same answer and writes the same row. Only a CHANGED status
 * notifies the seller, so a double run cannot double a notification either.
 *
 * *Hourly, 50 at a time:* verification is not urgent to the minute in either direction, and the
 * batch is one outbound request per hostname — the shape that outgrows its lease. `checkedAt`
 * (migration 0014) makes the cap a rotation, so a platform with more domains than the cap simply
 * takes more hours to come round, and the longest-unchecked is always first.
 */
const CUSTOM_DOMAIN_BATCH = 50;

const customDomainCheck: Job = {
  name: 'custom-domain-check',
  intervalSec: 1 * HOUR,
  leaseSec: 15 * MINUTE,
  async run() {
    const stores = await getStoresWithCustomDomain(CUSTOM_DOMAIN_BATCH);
    if (!stores.length) return 'no custom domains';
    const line = await reverifyCustomDomains(stores);
    const capped = stores.length === CUSTOM_DOMAIN_BATCH ? ` · capped at ${CUSTOM_DOMAIN_BATCH}, the rest go first next run` : '';
    return `${line}${capped}`;
  },
};

/**
 * Ask Google and Meta what they actually did with our feed.
 *
 * *What it fixes:* both networks reject a row **without telling anyone** — the product stays on the
 * storefront looking fine and no ad ever runs behind it. Nothing inside the application can see it,
 * because nothing inside the application is wrong. GO_LIVE §2.5 layer 1 had this as a one-time
 * reading of the approval report by hand on connection day, which is a single look at a state that
 * changes every time any seller edits any product. Opening the account is a one-time human act;
 * watching it is this.
 *
 * *Idempotent:* it reads two APIs and derives everything from their current answer, exactly like
 * `custom-domain-check`. The only writes are an alert and a seller notification, and both are
 * guarded by "has this already been said" windows rather than by having run once
 * (`merchant-status-check.ts`), so a double run says nothing twice.
 *
 * *Inert until configured:* with no credentials `getMerchantStatusProviders()` is empty and the run
 * reports that and touches nothing — the dev and CI state, and the state until the accounts exist.
 *
 * *Every four hours:* the input changes when a seller edits a product and the networks re-review on
 * their own schedule anyway, which is hours, not minutes. Faster would mostly re-read an unchanged
 * answer over somebody else's rate limit. The lease is generous because the pass walks the whole
 * catalogue a page at a time across two APIs.
 */
const merchantStatus: Job = {
  name: 'merchant-status',
  intervalSec: 4 * HOUR,
  leaseSec: 30 * MINUTE,
  async run() {
    return runMerchantStatusCheck();
  },
};

/** The registry. The jobs are independent and the scheduler starts them concurrently, so this order
 *  is only what the log reads like — no job can delay another past its own interval. */
export const JOBS: readonly Job[] = [purgeCheckouts, purgeAuthAttempts, campaignSweep, feedSync, customDomainCheck, merchantStatus, purgeVisitorDetail];
