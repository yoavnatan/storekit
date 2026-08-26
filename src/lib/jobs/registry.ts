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
import { purgeExpiredPasswordResetTokens } from '../password-reset.js';
import { purgeOldAnalyticsVisitors } from '../analytics.js';
import { purgeOldStoreViewVisitors } from '../store-pageviews.js';
import { visitorRetentionCutoffISO } from '../visitor-retention.js';
import { getStoresWithFeedUrl, getStoresWithCustomDomain, canStoreSell } from '../stores.js';
import { reverifyCustomDomains } from '../custom-domain-verify.js';
import { syncStoreFeed, syncedRowCount } from '../store-feed-sync.js';
import { isPlatformWideFeedFailure } from '../feed-sync-alert.js';
import { logError } from '../error-log.js';
import { getStoreIdsWithLiveCampaigns } from '../ad-campaigns.js';
import { getCampaignsForStore } from '../ad-campaign-health.js';
import { runMerchantStatusCheck } from '../merchant-status-check.js';
import { rebuildCatalogArtifact, FEED_ARTIFACT, REVIEW_FEED_ARTIFACT, SITEMAP_ARTIFACT, CATALOG_ARTIFACT_INTERVAL_SEC } from '../catalog-artifacts.js';
import { runOrderSla } from '../order-sla-run.js';
import { runReturnsSweep } from '../returns-run.js';
import { runReviewInvites, reviewInviteRunLine } from '../review-invite-run.js';
import { runInboxDigest } from '../inbox-digest.js';
import { runStorePublicationSweep } from '../store-publication-run.js';
import { runSubscriptionLapseSweep } from '../subscription-lapse.js';
import { resyncAllSubscriptionPrices } from '../seller-subscription.js';
import { runPaymeInvoiceSync } from '../payme-invoice-sync.js';

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
        // count is what the run reports; the seller is told about their own feed by the
        // notification `syncStoreFeed` raises (feed-sync-alert.ts).
        failed++;
      }
    }
    // A broken vendor link is the seller's problem and they have already been told. MOST of them
    // failing in one run is ours — two hundred vendors do not go down together — and nothing else
    // would ever say so, since the job "succeeded" either way. Fire-and-forget, like every other
    // logError: a failed alert must not fail the run it describes.
    if (isPlatformWideFeedFailure(stores.length, failed)) {
      void logError({
        source: 'server',
        route: 'job:feed-sync',
        message: `feed-sync: ${failed} of ${stores.length} stores failed in one run`,
        resolutionHint: 'Each seller was notified about their own feed. This many at once points at us, not at them — check outbound network and the SSRF fetch guard (lib/feed-fetch.ts) before contacting anyone.',
      });
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
 * Drop spent and expired forgot-password links (`lib/password-reset.ts`).
 *
 * *Idempotent:* a `DELETE … WHERE expires_at < now()`, like the two purges above. A second pass
 * finds nothing.
 *
 * *Correctness does not depend on it,* and that is worth being explicit about on a table that holds
 * credentials: both statements that accept a token test `expires_at > now()` and `used_at IS NULL`
 * in SQL, so an unpurged row is already refused. This job is hygiene — the rows carry a hash of
 * something that was mailed to a person, and there is no reason to keep them once they can no
 * longer do anything.
 */
const purgeResetTokens: Job = {
  name: 'purge-reset-tokens',
  intervalSec: 6 * HOUR,
  leaseSec: 5 * MINUTE,
  async run() {
    return `purged ${await purgeExpiredPasswordResetTokens()}`;
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

/**
 * Pre-build the two catalogue-wide documents Google and Meta pull.
 *
 * *What it fixes:* `/api/feed/products.xml` and `/sitemap-content.xml` assembled the WHOLE platform
 * catalogue in memory on every request — 6.1 seconds at 45 stores, measured in this repo, on the
 * one event loop every shopper shares, and a several-hundred-megabyte string at a thousand sellers.
 * Both routes now serve a document this job wrote (`catalog-artifacts.ts`, migration 0022). The
 * build did not get cheaper; it stopped happening on the request path, and it stopped happening in
 * one allocation — it flushes every ~256KB, and each flush is an `await` that hands the loop back
 * to whoever is at checkout. GO_LIVE §7.
 *
 * *Idempotent:* a build is a function of current state that ends in a pointer swap, so a second run
 * writes a second generation with identical content and publishes it over the first. Nothing
 * accumulates — publishing keeps the live generation and the one before it, and drops the rest,
 * including the parts of a run that was abandoned at its lease.
 *
 * *Every half hour, which is also the `max-age` the routes publish:* the two are one number in
 * `catalog-artifacts.ts`, so worst-case staleness stays the hour it already was when the document
 * was built fresh and cached for one. Why an hour is the budget, and why there is no
 * "rebuild only if changed" fingerprint, are argued at that constant.
 *
 * *Two entries, not one:* they are independent documents and either can fail on its own. One job
 * doing both would report a single line for two states and re-run the healthy half to retry the
 * broken one.
 */
const feedArtifact: Job = {
  name: 'feed-artifact',
  intervalSec: CATALOG_ARTIFACT_INTERVAL_SEC,
  leaseSec: 10 * MINUTE,
  async run() {
    return rebuildCatalogArtifact(FEED_ARTIFACT);
  },
};

/**
 * The Google product-reviews feed (`review-feed-document.ts`).
 *
 * Its own entry for the same reason the two above are two: an independent document that can fail on
 * its own. Rebuilt on the same interval as the others even though Merchant Center only needs the
 * reviews feed refreshed MONTHLY — the freshness that matters is not Google's schedule but the gap
 * between a shopper writing a review and the platform being able to prove it exists, and a document
 * that is rebuilt on a different rhythm from its own catalogue is one that can name a product the
 * product feed has already dropped.
 */
const reviewFeedArtifact: Job = {
  name: 'review-feed-artifact',
  intervalSec: CATALOG_ARTIFACT_INTERVAL_SEC,
  leaseSec: 10 * MINUTE,
  async run() {
    return rebuildCatalogArtifact(REVIEW_FEED_ARTIFACT);
  },
};

/**
 * Ask buyers how it was, a few days after the parcel left (`review-invite-run.ts`).
 *
 * *Idempotent:* `orders.review_invited_at` is stamped before the send and is the query's own
 * filter, so an order this job has touched is not a candidate on the next pass — migration 0034
 * argues why the stamp goes first.
 *
 * *Every six hours:* the thing being waited for is measured in DAYS, so a tighter interval would
 * only re-run the same empty query. Six hours means an invitation goes out within a quarter of a
 * day of becoming due, which is well inside the precision this has.
 */
const reviewInvites: Job = {
  name: 'review-invites',
  intervalSec: 6 * HOUR,
  leaseSec: 15 * MINUTE,
  async run() {
    return reviewInviteRunLine(await runReviewInvites());
  },
};

const sitemapArtifact: Job = {
  name: 'sitemap-artifact',
  intervalSec: CATALOG_ARTIFACT_INTERVAL_SEC,
  leaseSec: 10 * MINUTE,
  async run() {
    return rebuildCatalogArtifact(SITEMAP_ARTIFACT);
  },
};

/** The registry. The jobs are independent and the scheduler starts them concurrently, so this order
 *  is only what the log reads like — no job can delay another past its own interval. */

/**
 * Warn a seller whose order is late, and cancel the one they never sent.
 *
 * *What it fixes:* the rule existed and nothing ran it (`order-sla.ts`, GO_LIVE §5.0-ב). Without a
 * caller, an order the seller never shipped left the buyer paying for goods that were never coming
 * and nothing gave it back. This is the only job in the registry that gives money back to a real
 * person, which is why it is also the only one that cancels anything.
 *
 * *Idempotent:* a cancelled order fails `REVENUE_SHIPPING_STATUSES` and is not a candidate on the
 * next pass; if a race got one through, `canTransition` refuses a move out of a terminal status.
 * The warning is deduplicated against the seller's own notification feed, so a second pass in the
 * same day says nothing twice (`order-sla-run.ts`).
 *
 * *Daily:* both thresholds are whole days on the business calendar, so asking more often re-asks a
 * question whose answer changes once a day. The lease is generous because the overdue branch reads
 * a whole order and restocks every line.
 */
const orderSla: Job = {
  name: 'order-sla',
  intervalSec: 24 * HOUR,
  leaseSec: 30 * MINUTE,
  async run() {
    const r = await runOrderSla();
    const capped = r.capped ? ` · capped at the batch, the rest go first next run` : '';
    return `late ${r.scanned} · warned ${r.warned} · cancelled ${r.cancelled} `
      + `(${r.refundOwedAgorot} agorot owed back to buyers) · failed ${r.failed}${capped}`;
  },
};

/**
 * The returns mechanism closing its own cases (`returns-run.ts`).
 *
 * **This job is the reason the owner does not have to open the admin dashboard.** Seven of the eight
 * states a return case can be in resolve on a clock; this is the clock. The eighth — `disputed` — is
 * the only one that needs a person, and the run reports how many are waiting so he can be TOLD
 * rather than have to look.
 *
 * *Daily:* every threshold it reads is a whole number of business days, so asking more often re-asks
 * a question whose answer changes once a day. The lease is generous because a refunded case moves an
 * order, which restocks its lines and writes to the money journal.
 */
const returnsSweep: Job = {
  name: 'returns-sweep',
  intervalSec: 24 * HOUR,
  leaseSec: 30 * MINUTE,
  async run() {
    const r = await runReturnsSweep();
    return `scanned ${r.scanned} · warned ${r.warned} · auto-rejected ${r.autoRejected} · expired ${r.expired} `
      + `· auto-refunded ${r.autoRefunded} (${r.refundedAgorot} agorot) · escalated ${r.escalated} · failed ${r.failed} `
      + `· awaiting a human ${r.awaitingAdmin}`;
  },
};

/**
 * Tell the owner, once a day, that somebody is waiting for an answer (`inbox-digest.ts`).
 *
 * *What it fixes (owner, 2026-08-19):* the inbox is a screen you have to open. A guest whose
 * checkout broke can write at 2am and sit there until somebody happens to look. This is the only
 * job in the registry whose entire output is a sentence to a person.
 *
 * *Idempotent:* it derives a count from current state and sends at most one mail per run. A second
 * pass on the same day would send the same mail again — which is why the SCHEDULE is the bound, not
 * the job's memory (`project_scheduler`: a job must INFER NOTHING). At 24h that is one mail a day
 * even after a restart, because `job_runs` measures start-to-start.
 *
 * *Silent when there is nothing,* and when `ALERT_EMAIL` is unset — the dev and CI state. Both are
 * reported on the row rather than swallowed.
 */
const inboxDigest: Job = {
  name: 'inbox-digest',
  intervalSec: 24 * HOUR,
  leaseSec: 5 * MINUTE,
  async run() {
    return runInboxDigest();
  },
};

/**
 * Put a seller's shop on the site the moment PayMe stop holding it back.
 *
 * *What it fixes:* a shop is built unpublished and goes live when clearing is approved and the
 * subscription is running (`store-publication.ts`). PayMe announce the approval on a callback — and
 * **that callback needs a public URL this platform does not have yet**, so today this job is the
 * only thing that would ever end a real seller's wait. Once a host exists it becomes the cover for
 * a notification they dropped, which is a failure nothing else would report.
 *
 * *Idempotent:* publication is derived from current state and `published_at` is written once, so a
 * second pass finds the same shops already live and changes nothing.
 *
 * *Every 30 minutes:* the seller is waiting on a human decision at PayMe that takes up to seven
 * business days, so the answer changes at most once — but it is the last half hour of a week-long
 * wait, and it is one statement when nothing is pending. The lease covers one PayMe round trip per
 * waiting seller.
 */
const storePublication: Job = {
  name: 'store-publication',
  intervalSec: 30 * MINUTE,
  leaseSec: 10 * MINUTE,
  async run() {
    return runStorePublicationSweep();
  },
};

/**
 * Take a shop off the site when the month it was paid for has run out.
 *
 * *What it fixes:* the other end of `store-publication`. Cancelling a subscription used to change
 * nothing a shopper could see — the shop stayed up for ever, selling, with our commission still
 * coming off it (owner, 2026-08-24). Cancellation takes effect at the END of the paid period, so
 * something has to act on a date rather than on a click, and this is it (`subscription-lapse.ts`).
 *
 * *Hourly:* the deadline is a date, not a moment anyone is watching, and an hour of a shop staying
 * up past its paid month costs nothing and is the forgiving direction to err in. The steady-state
 * cost is one indexed statement that almost always answers with no rows.
 */
const subscriptionLapse: Job = {
  name: 'subscription-lapse',
  intervalSec: 60 * MINUTE,
  leaseSec: 10 * MINUTE,
  async run() {
    return runSubscriptionLapseSweep();
  },
};

/**
 * Fetch the invoices the processor issued in a seller's name and put them on his orders.
 *
 * *What it fixes:* a seller who switched on the processor's invoicing service (`seller-invoicing.ts`)
 * was billed monthly for documents that appeared nowhere in our dashboard, while his order cards
 * went on asking him to upload the very invoice he was paying to have issued (owner, 2026-08-25).
 *
 * *Hourly, and it usually does nothing:* almost no seller has the service, and the gate is read per
 * seller before any transaction is fetched — so the steady-state cost is one indexed query that
 * returns the handful of approved merchants and nothing else. An invoice arriving an hour after the
 * sale is invisible to everyone: the buyer is not waiting on this screen, and the seller's alternative
 * was uploading it by hand.
 *
 * *Idempotent:* `markBuyerInvoiceProvided` is a settlement, not an increment — re-running attaches
 * the same URL to the same row and keeps the original `issued_at`.
 */
const paymeInvoices: Job = {
  name: 'payme-invoices',
  intervalSec: 60 * MINUTE,
  leaseSec: 10 * MINUTE,
  async run() {
    const { sellersChecked, attached } = await runPaymeInvoiceSync();
    return `${sellersChecked} seller(s) with invoicing on · ${attached} document(s) attached`;
  },
};

/**
 * Keep every standing order level with what its shops actually cost.
 *
 * ── Why a job and not a one-off script (owner, 2026-08-26) ──
 * *"אם אתחיל כעוסק פטור ואז אעבור לעוסק מורשה איך זה ישתקף בפלטפורמה, צריך לפשט את זה."* Flipping
 * `PLATFORM_BUSINESS_TYPE` changes every new charge immediately — the price quoted, the `market_fee`
 * on the next sale, every line of copy — but a standing order already at PayMe holds a fixed amount
 * and would go on charging the old figure for ever. That is the only part of the switch that needs
 * an action, and a one-off command is an action somebody has to remember at the exact moment they
 * are busy with an accountant.
 *
 * So it levels itself. The same is true of anything else that moves what a shop costs and does not
 * pass through the tier route — a plan's price changing in `pricing.ts`, a shop closing while PayMe
 * were unreachable, a `set-price` that failed and was never retried.
 *
 * **Idempotent by construction**, which this list requires: `syncSubscriptionPrice` compares the
 * computed price with the stored one and only calls PayMe when they differ, so a steady state costs
 * two indexed reads per paying seller and no outbound call at all.
 *
 * *Daily:* the thing it corrects is measured in months, and a wrong monthly charge is caught long
 * before the next one. Nightly rather than hourly so that a mass re-price — the one day this really
 * does something — is one burst against the processor instead of one every hour.
 */
const subscriptionPriceSync: Job = {
  name: 'subscription-price-sync',
  intervalSec: 24 * HOUR,
  leaseSec: 30 * MINUTE,
  async run() {
    const { checked, updated, failed } = await resyncAllSubscriptionPrices();
    // The failures are NAMED and not counted away: each one is a seller whose card is charging a
    // figure our own records disagree with, which is the exact divergence the write order exists to
    // prevent and the one thing a person has to see.
    return `${checked} standing order(s) checked · ${updated} re-priced${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`;
  },
};

export const JOBS: readonly Job[] = [purgeCheckouts, purgeAuthAttempts, purgeResetTokens, campaignSweep, feedSync, customDomainCheck, merchantStatus, feedArtifact, reviewFeedArtifact, sitemapArtifact, reviewInvites, orderSla, returnsSweep, inboxDigest, purgeVisitorDetail, storePublication, subscriptionLapse, subscriptionPriceSync, paymeInvoices];
