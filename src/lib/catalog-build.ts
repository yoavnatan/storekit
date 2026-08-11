/**
 * The two things both catalogue-wide builds need, in one place so they cannot drift apart.
 *
 * `feed-document.ts` and `sitemap-document.ts` walk the same mall for different documents. Neither
 * imports the other — they are alternatives, not layers — so the window size and the counters they
 * share live here.
 */

/** How many stores are read per round trip.
 *
 *  Every read inside both builds is `… = ANY($1)`, so this is the batch size for two or three
 *  queries at once, never a query per store — the N+1 that took the feed endpoint to 6.1 seconds at
 *  45 stores is still batched, just in windows now. Small enough that a window's products are a few
 *  MB at most (the memory ceiling of the whole build), large enough that round trips are not the
 *  cost. It is also the rhythm the event loop gets back: each window ends in an `await`. */
export const STORE_BATCH = 20;

/** Filled in as a build runs, so its job can report what it wrote without counting it twice. What
 *  `stores` counts is the builder's to say — see each one. */
export interface CatalogBuildStats {
  stores: number;
  items: number;
}

export function newBuildStats(): CatalogBuildStats {
  return { stores: 0, items: 0 };
}

export function batches<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
