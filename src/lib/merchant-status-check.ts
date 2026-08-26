/**
 * The pass that turns "what Google and Meta say about our feed" into an alert and a seller
 * notification — the one step, called by the `merchant-status` job.
 *
 * **What it is for.** The ad networks reject rows silently: the product stays on the storefront
 * looking perfectly fine and no ad ever runs behind it (memory
 * `project_feed_silent_rejection_class`). Nothing inside the application can see that, because
 * nothing inside the application is wrong. The only way to know is to ask them, and the only way to
 * keep knowing is to ask on a timer.
 *
 * **Three failures are ours and one is the seller's, and telling them apart is most of this file:**
 *
 * 1. *No answer* — credentials, quota, or a body we could not parse. Nothing is wrong with any
 *    product; what is broken is the watching. It is louder than it looks, because its symptom is
 *    silence.
 * 2. *Feed-level rejection or an empty catalogue* — every seller's ads at once. One Merchant Center,
 *    one Catalog, one Pixel for the whole platform is what lets a seller be advertised without
 *    registering anywhere (memory `project_ad_platform_account_risk`), and it is why a failure here
 *    is never one seller's problem.
 * 3. *Ids that map to no product* — the two systems stopped agreeing on a key. This is the exact
 *    class that already cost this project four months (`ad-item-id.ts`): each side internally
 *    correct, the JOIN between them empty, nothing raising a word. It is checked over ALL rows, not
 *    just rejected ones, because a broken join shows up as a healthy report about nobody.
 * 4. *One row disapproved* — genuinely the seller's to fix, and the only case that reaches them.
 *
 * **A mass rejection is treated as (2), not as thousands of (4).** Above {@link rejectionCeiling}
 * the per-seller notifications are held and one platform alert is raised instead. Same reasoning as
 * `custom-domain-verify.ts`'s demotion ceiling, and the same scenario behind it: a policy change or
 * a mistake of ours reads, row by row, exactly like every seller independently breaking their own
 * products on the same afternoon. Telling 200 sellers they did something wrong when we did is not
 * recoverable by a correction the next hour.
 */
import { productIdFromAdItemId } from './ad-item-id.js';
import { hasRecentErrorForRoute, logError } from './error-log.js';
import { createNotification, existingNotificationRelatedIds } from './notifications.js';
import { getProductsByIds } from './store-products.js';
import { getStoresByIds } from './stores.js';
import {
  NETWORK_LABEL,
  getMerchantStatusProviders,
  type MerchantItemStatus,
  type MerchantNetwork,
  type MerchantStatusProvider,
  type MerchantStatusReport,
} from './merchant-status.js';

/** How long one platform-level alert speaks for. Long enough that a condition lasting all day is a
 *  couple of entries rather than a screenful; short enough that it does not fall quiet on a problem
 *  nobody has fixed. */
const ALERT_WINDOW_HOURS = 12;

/** How long a seller notification about one product's rejection speaks for. A day: the seller has to
 *  edit the product and wait for a re-review, so anything shorter is nagging about work in flight. */
const SELLER_WINDOW_HOURS = 24;

/** How long the "the site is live and this is still not connected" reminder speaks for. A week: it
 *  is a standing condition, not an incident, and it stops by itself the day the variables are set. */
const UNCONFIGURED_WINDOW_HOURS = 7 * 24;

/** Below this many rows, ratios mean nothing — three rejected out of four is a small catalogue
 *  having a bad day, not a platform incident. */
const MIN_SAMPLE = 20;

/**
 * How many rejections one pass may believe are really the sellers'.
 *
 * A share, not a count, for the reason the domain check learned: a fixed number is the wrong shape
 * at both ends of the platform's life. With 40 products, four rejections is a pattern; with 40,000
 * it is Tuesday.
 */
export function rejectionCeiling(checked: number): number {
  return Math.max(MIN_SAMPLE, Math.floor(checked / 4));
}

/** The share of unmappable ids that means the id contract itself broke rather than a few stale rows
 *  lingering in the network's catalogue from a deleted product. */
const UNMAPPED_ALARM_SHARE = 0.5;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * One platform-level alert, at most once per {@link ALERT_WINDOW_HOURS} per key.
 *
 * `route` is the dedupe key and must be stable across runs — so the varying part (counts, the
 * network's wording) goes in `message`, never in the key.
 *
 * Severity is not passed and must not be: `error-log.ts` derives it, and by `error-severity.ts`'s
 * rule these land at `error` rather than `critical`. That is the right level and worth stating,
 * because "the platform's entire advertising is down" sounds like the loudest thing there is:
 * `critical` is reserved for a buyer unable to complete a purchase or for money and stock possibly
 * being wrong, and a dead feed is neither. Nothing is charged, nothing is left inconsistent, and
 * the spend stops with the serving. It costs marketing, and marketing does not wake anyone at 2am.
 */
async function alertOnce(route: string, message: string, resolutionHint: string): Promise<boolean> {
  return alertOnceIn(ALERT_WINDOW_HOURS, route, message, resolutionHint);
}

/** The same, for a condition whose natural repeat is not the incident window — see
 *  {@link UNCONFIGURED_WINDOW_HOURS}. Kept as one implementation so the "ask before writing" rule
 *  has a single definition and only the period varies. */
async function alertOnceIn(windowHours: number, route: string, message: string, resolutionHint: string): Promise<boolean> {
  if (await hasRecentErrorForRoute(route, hoursAgo(windowHours)).catch(() => false)) return false;
  await logError({ source: 'server', route, message, resolutionHint })
    .catch(() => { /* the job's own line still reports it */ });
  return true;
}

/** What one network's pass did, for the job's summary line. */
interface NetworkOutcome {
  network: MerchantNetwork;
  line: string;
}

export async function runMerchantStatusCheck(): Promise<string> {
  const providers = getMerchantStatusProviders();
  if (!providers.length) {
    // The reminder nobody has to remember. Advertising is launch-blocking by the owner's own
    // decision (GO_LIVE §2, 2026-08-04) — "אני לא מתכוון לעלות לאוויר עם נתוני דמו או כשזה לא
    // מחובר" — so a live site with these four variables unset is a real gap, not a preference.
    // Every other route to noticing it depends on somebody recalling it on the one day it counts,
    // which is exactly the kind of promise this whole job exists to stop relying on.
    //
    // PROD only, and the condition is inline because a named predicate here could only ever be
    // tested against itself. The behaviour that matters — dev and CI stay silent, where "inert" is
    // the correct and permanent state — is asserted through the public function instead.
    if (import.meta.env.PROD) {
      await alertOnceIn(
        UNCONFIGURED_WINDOW_HOURS,
        'job:merchant-status:unconfigured',
        'The site is live and nothing is checking what Google and Meta do with the product feed',
        'Set GOOGLE_MERCHANT_ID + GOOGLE_SERVICE_ACCOUNT_JSON and META_CATALOG_ID + META_ACCESS_TOKEN (see .env.example, GO_LIVE §2.5 layer 1). Until then a rejected product is invisible: it keeps looking fine on the storefront and no ad runs behind it. This notice stops by itself once they are set.',
      );
    }
    return 'not configured — no ad network credentials set';
  }

  // The two networks are independent: Meta being unreachable must not cost us Google's answer, and
  // they are asked concurrently because each is a slow outbound call to somebody else's API.
  //
  // The catch is per network and it is required, not defensive. `registry.ts`: **a job never throws
  // out of `run`.** The provider itself cannot throw by contract, but everything after it is
  // database work — the product lookup, the store lookup, the notification write — and one of those
  // failing must not take down the OTHER network's pass, which had already finished successfully.
  // Without it, `Promise.all` turns one bad query into "neither network was checked this hour".
  const outcomes = await Promise.all(providers.map(async (provider) => {
    try {
      return await checkNetwork(provider);
    } catch (err) {
      return { network: provider.network, line: `pass failed — ${err instanceof Error ? err.message : String(err)}` };
    }
  }));
  return outcomes.map((outcome) => `${outcome.network}: ${outcome.line}`).join(' · ');
}

async function checkNetwork(provider: MerchantStatusProvider): Promise<NetworkOutcome> {
  const { network } = provider;
  const label = NETWORK_LABEL[network];

  let report: MerchantStatusReport | null;
  try {
    report = await provider.fetchStatuses();
  } catch {
    // The contract says a provider never throws. Catching anyway: a job that dies here stops
    // checking the OTHER network too, and the whole point of this module is that nothing goes
    // unwatched quietly.
    report = null;
  }

  if (!report) {
    await alertOnce(
      `job:merchant-status:${network}:unreachable`,
      `${label} did not return a readable answer — product approval status is not being monitored`,
      'Check the credentials for this network and its API status. Nothing is known to be wrong with any product; what is not working is the check itself, so a quiet Alerts tab currently means nothing.',
    );
    return { network, line: 'no answer' };
  }

  if (report.feedError) {
    await alertOnce(
      `job:merchant-status:${network}:feed`,
      `${label} rejected the whole feed: ${report.feedError}`,
      'This is platform-wide, not one seller — every store loses its ads at once. Fetch /api/feed/products.xml and check it parses; an XML-illegal character anywhere makes the entire document unreadable (lib/product-feed.ts).',
    );
    return { network, line: `feed rejected — ${report.feedError}` };
  }

  if (!report.items.length) {
    await alertOnce(
      `job:merchant-status:${network}:empty`,
      `${label} holds no items at all for our feed`,
      'Either the feed was never ingested or every row was dropped. Confirm the feed URL is still configured on the account and that it returns products.',
    );
    return { network, line: 'catalogue empty' };
  }

  if (report.truncated) {
    // Announced, never quiet. A monitor that reads the first N products and says "nothing wrong"
    // is making a claim about products it never looked at — the same silent-coverage failure it
    // was built to end, one level up. `registry.ts` holds the same rule for its capped batches.
    await alertOnce(
      `job:merchant-status:${network}:truncated`,
      `${label} holds more items than one pass reads — approval status beyond the first ${report.items.length} is NOT being monitored`,
      'Raise MAX_STATUS_PAGES in lib/merchant-status.ts, or split the pass across runs. Until then a clean result covers only the part that was read.',
    );
  }

  return checkItems(network, label, report.items, report.truncated === true);
}

async function checkItems(network: MerchantNetwork, label: string, items: MerchantItemStatus[], truncated: boolean): Promise<NetworkOutcome> {
  // Mapped over EVERY row, not just the rejected ones — a broken id contract is invisible in the
  // rejections (there would not be any) and obvious here.
  const mapped = items.map((item) => ({ item, productId: productIdFromAdItemId(item.itemId) }));
  const unmapped = mapped.filter((entry) => !entry.productId).length;

  if (unmapped > items.length * UNMAPPED_ALARM_SHARE) {
    await alertOnce(
      `job:merchant-status:${network}:unmapped-ids`,
      `${unmapped} of ${items.length} items in ${label} carry an id that matches no product on the platform`,
      'The feed and the catalogue have stopped agreeing on the product id. Nothing looks broken from inside the app — the feed builds, the events fire — but remarketing and per-product ad reporting are joining to nothing. Compare a real feed row id against lib/ad-item-id.ts.',
    );
  }

  const rejected = mapped.filter((entry) => !entry.item.approved && entry.productId);
  const ceiling = rejectionCeiling(items.length);
  const held = rejected.length > ceiling;

  if (held) {
    await alertOnce(
      `job:merchant-status:${network}:mass-rejection`,
      `${rejected.length} of ${items.length} items rejected by ${label} in one pass (ceiling ${ceiling}) — seller notifications held`,
      'A rejection rate this high is far more likely to be our feed, our account or a policy change than every seller at once. Read the account\'s own report before telling sellers they did something wrong; the notifications were deliberately not sent.',
    );
    return { network, line: `checked ${items.length} · rejected ${rejected.length} · HELD (over ${ceiling}, treated as ours)` };
  }

  const notified = rejected.length ? await notifySellers(network, label, rejected) : 0;
  const unmappedNote = unmapped ? ` · unmapped ${unmapped}` : '';
  const partial = truncated ? ' · PARTIAL (page cap reached — the rest of the catalogue was not read)' : '';
  return { network, line: `checked ${items.length} · rejected ${rejected.length} · told ${notified}${unmappedNote}${partial}` };
}

/**
 * Tell each affected seller once, and return how many were told.
 *
 * Bulk lookups rather than a query per rejection: the bad day for this job is precisely the day
 * there are hundreds (memory `project_sequential_await_latency`).
 */
async function notifySellers(
  network: MerchantNetwork,
  label: string,
  rejected: { item: MerchantItemStatus; productId: string | null }[],
): Promise<number> {
  const products = await getProductsByIds(rejected.map((entry) => entry.productId!));
  const byId = new Map(products.map((product) => [product.id, product]));
  const stores = await getStoresByIds([...new Set(products.map((product) => product.storeId))]);
  const storeById = new Map(stores.map((store) => [store.id, store]));

  // One key per (network, product, reason). Two variants of one product rejected for the same reason
  // are one piece of news to the seller — the product needs editing either way — so the combo is
  // deliberately not part of the key.
  const pending = rejected.flatMap((entry) => {
    const product = byId.get(entry.productId!);
    const store = product ? storeById.get(product.storeId) : undefined;
    if (!product || !store) return [];
    const reason = entry.item.issueCode ?? 'rejected';
    return [{ product, store, item: entry.item, relatedId: `feed:${network}:${product.id}:${reason}` }];
  });

  // Deliberately NOT caught into an empty set. If the "have I already said this" query fails,
  // proceeding would announce every rejection to every affected seller again — and again on the
  // next tick, for as long as the query keeps failing. Duplicate alarms are how a notification
  // bell stops being read, and unlike a missed hour that damage compounds. The throw reaches the
  // per-network catch, which reports the failed pass without sending anything.
  const alreadySaid = await existingNotificationRelatedIds(
    pending.map((entry) => entry.relatedId),
    hoursAgo(SELLER_WINDOW_HOURS),
  );

  const fresh = pending.filter((entry) => !alreadySaid.has(entry.relatedId));
  // De-duplicate within this pass too: two rejected variant rows of one product produce the same key
  // and would otherwise both be written, since neither is in the database yet when the batch starts.
  const seen = new Set<string>();
  let sent = 0;

  for (const entry of fresh) {
    if (seen.has(entry.relatedId)) continue;
    seen.add(entry.relatedId);
    const reason = entry.item.issue ? ` הסיבה: ${entry.item.issue}` : '';
    await createNotification({
      userId: entry.store.sellerId,
      role: 'seller',
      type: 'feed_status',
      title: 'מוצר שלך לא מתפרסם',
      // No count and no id in the sentence — the seller needs the product and the fix, and a
      // number next to a Latin name reads backwards in RTL (memory feedback_seller_copy_register).
      body: `${entry.product.name} נדחה על ידי ${label} ולכן לא מופיע במודעות.${reason} תקן את המוצר והוא ייבדק מחדש אוטומטית.`,
      relatedId: entry.relatedId,
      storeSlug: entry.store.slug,
      storeName: entry.store.name,
    }).catch(() => { /* one seller's badge must not cost the rest of the batch */ });
    sent++;
  }

  return sent;
}
