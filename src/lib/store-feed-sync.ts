/**
 * One store's external-inventory pull, in one place.
 *
 * It lived inside `POST /api/store-product/feed-sync` while a seller pressing "sync now" was the
 * only way it could ever run. Stage 4a adds a second caller — the scheduler's `feed-sync` job
 * (`lib/jobs/registry.ts`) — and a job that reached the logic by making an HTTP request to its own
 * server would need a session cookie it does not have, and would be a second copy of the mapping
 * and import sequence the moment either side was edited. So the sequence moved down here and both
 * callers run the same one; the route keeps what only a route can do (authenticate the seller,
 * prove they own the store, read the body).
 *
 * **Running it twice must be the same as running it once**, because the scheduler can only reduce
 * double-runs, not rule them out (migration 0007). It is: `runProductImport` matches feed rows to
 * products by sku and SETS stock and price to the feed's values — an absolute write, never a delta
 * — and a second pass over an unchanged feed resolves every row as `unchanged` and writes nothing
 * at all. `tests/store-feed-sync.test.ts` asserts that rather than trusting this paragraph: five
 * syncs of a feed saying 3 leave the stock at 3, which a pull that added a delta would not.
 */
import { fetchFeedCsv } from './feed-fetch.js';
import { parseCsv } from './csv-bulk.js';
import { guessMapping, confirmedMapping, mappingStatus, buildCanonicalCsv, type MappableKey } from './feed-mapping.js';
import { runProductImport } from './store-products-import.js';
import { updateStore, type Store } from './stores.js';
import { alertOnScheduledSync } from './feed-sync-alert.js';

export interface FeedSyncResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Who asked for this pull. The two differ in what they are allowed to infer, and the difference is
 * not a detail — see `confirmedMapping` in feed-mapping.ts and the matcher check below.
 *
 *   'seller'    — the "sync now" button. A human is looking, and a preview precedes the write.
 *   'scheduled' — the timer. Nothing is inferred, and anything ambiguous is refused rather than
 *                 guessed, because the cost of guessing wrong repeats every hour with nobody to see it.
 */
export type FeedSyncTrigger = 'seller' | 'scheduled';

/**
 * Fetch the store's saved feed URL (behind the SSRF guard), re-apply the saved column mapping to
 * turn it into our canonical format, and run the same import routine a manual upload runs.
 *
 * `commit: false` is the seller's preview; `commit: true` writes and stamps `lastSyncAt`. The
 * scheduler only ever calls it with `true` — a preview nobody reads is a remote fetch for nothing.
 */
export async function syncStoreFeed(store: Store, commit: boolean, trigger: FeedSyncTrigger = 'seller'): Promise<FeedSyncResult> {
  const result = await runSync(store, commit, trigger);

  // The unattended run is the one that has to speak up, because nobody is reading this answer: a
  // dead URL, a renamed sku column or rows refused one by one simply stops moving stock, and the
  // storefront keeps selling from whatever the last working pull left behind (`feed-sync-alert.ts`,
  // which also CLEARS the alert once a run comes back clean). A seller who pressed the button is
  // looking at the result already, so that trigger says nothing extra.
  //
  // Out here rather than beside the write, because most of the failures worth telling anyone about
  // — the fetch, the empty file, the missing matcher column — return long before the write is
  // reached, which is exactly why they were the silent ones. Never allowed to fail the sync it
  // reports on: a badge is not worth undoing a pull that worked.
  if (commit && trigger === 'scheduled') {
    await alertOnScheduledSync(store, result.status, result.body).catch(() => { /* a badge must not cost the sync */ });
  }
  return result;
}

async function runSync(store: Store, commit: boolean, trigger: FeedSyncTrigger): Promise<FeedSyncResult> {
  const url = store.feedSync?.url?.trim();
  if (!url) return { status: 400, body: { ok: false, error: 'no-feed-url' } };

  const fetched = await fetchFeedCsv(url);
  if (!fetched.ok || fetched.csv === undefined) {
    return { status: 502, body: { ok: false, error: `feed-${fetched.error}` } };
  }

  const rows = parseCsv(fetched.csv);
  if (!rows.length) return { status: 400, body: { ok: false, error: 'empty-file' } };

  // For the seller: guess from the live headers, biased by whatever they confirmed last time — they
  // see the result before it is written. For the timer: exactly what they confirmed, and nothing the
  // remote file has since grown.
  const saved = store.feedSync?.mapping as Record<string, MappableKey> | undefined;
  const entries = trigger === 'scheduled' ? confirmedMapping(rows[0]!, saved) : guessMapping(rows[0]!, saved);

  // **The one refusal that only matters unattended.** Without a sku or id column every row reads as
  // a brand-new product (`resolveSkuMatches` has nothing to match on), so the import CREATES the
  // whole feed. A seller doing that by hand sees a preview full of "create" and stops. On a timer it
  // is the entire catalogue duplicated, once an hour, for as long as nobody notices. The panel
  // already warns a human about this (`mappingStatus.hasMatcher`); the timer must not proceed at all.
  if (trigger === 'scheduled' && !mappingStatus(entries).hasMatcher) {
    return { status: 400, body: { ok: false, error: 'no-matcher-column' } };
  }

  const canonicalCsv = buildCanonicalCsv(rows, entries);

  const { status, body } = await runProductImport({
    storeId: store.id,
    // The store's owner, not the caller — the route already proved they are the same, and the
    // scheduler has no caller at all. It is used to clear that seller's stock notifications.
    sellerId: store.sellerId,
    csv: canonicalCsv,
    commit,
  });

  if (commit && body.ok) {
    const lastSyncAt = new Date().toISOString();
    await updateStore(store.id, { feedSync: { ...store.feedSync, lastSyncAt } });
    return { status, body: { ...body, lastSyncAt } };
  }
  return { status, body };
}

/** How many rows a committed sync actually created or updated — the one number worth putting in the
 *  job's log line. Rows the import skipped as unchanged are not written and do not count. */
export function syncedRowCount(body: Record<string, unknown>): number {
  const results = body.results;
  if (!Array.isArray(results)) return 0;
  return results.filter((r) => {
    const row = r as { action?: string; unchanged?: boolean };
    return row.action !== 'error' && !row.unchanged;
  }).length;
}
