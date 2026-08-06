/**
 * Concurrent callers asking for the same expensive build share one build.
 *
 * **The shape this exists for.** Two public, unauthenticated routes —
 * `/api/feed/products.xml` and `/sitemap-content.xml` — assemble the ENTIRE platform catalogue on
 * every request: every indexable store, every visible product, every category tree, then a single
 * large XML string. That is not a theoretical cost. `products.xml.ts` carries a measurement taken in
 * this repository: 45 stores put the endpoint at **6.1 seconds** before its N+1 was batched, and the
 * batching fixed the round trips, not the size of the job.
 *
 * Node serves one process, one event loop. Building that string is CPU work, so while it runs, every
 * OTHER request in the process waits — a shopper mid-checkout included. The routes are public and
 * take no token, so nothing stops Google's retry, Meta's pull and anyone with `curl` from starting
 * that work several times over. Each one is a full second-scale build competing for the same loop
 * and the same ten-connection pool.
 *
 * **What this does, and the reason it is exactly this and not a cache.** The first caller for a key
 * runs the build; every caller that arrives while it is still running gets that same promise. When
 * it settles, the key is released and the next request builds fresh. So N simultaneous pulls cost
 * one build instead of N, and nothing is ever served from a stale snapshot — the worst staleness any
 * caller can see is "the data as of when the build it joined started", which is less than one build
 * old and no worse than what it would have got by arriving a moment earlier. A TTL cache would beat
 * this on a sequential hammer, and it would also mean holding the whole catalogue's XML in memory
 * per instance and choosing a freshness window. Not worth either, here: sequential flooding is an
 * edge/CDN problem, and both routes already publish `Cache-Control: max-age=3600` for exactly that
 * layer to act on (GO_LIVE §1).
 *
 * **On "no shared write state" (AI_INSTRUCTIONS → Hard rules → Scalability).** This is process-local
 * and it does not breach that rule, which is about state whose CORRECTNESS depends on which instance
 * answered. Nothing is written and nothing is remembered between requests. Two instances each doing
 * one build instead of one instance doing one is the same answer, just less saving — the mechanism
 * degrades in efficiency across instances, never in correctness, which is the property the rule is
 * protecting.
 *
 * **A rejection is shared too, on purpose.** If the build throws, every joined caller gets the same
 * error and the key is released, so the next request retries for real. Swallowing it per caller
 * would mean one failing build being reported as several unrelated failures.
 */

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `build` under `key`, or join the run already under way.
 *
 * `key` names the WORK, not the caller — two routes must never share one, and one route must use a
 * stable string rather than anything derived from the request.
 */
export function singleFlight<T>(key: string, build: () => Promise<T>): Promise<T> {
  const joined = inFlight.get(key) as Promise<T> | undefined;
  if (joined) return joined;

  let started: Promise<T>;
  try {
    started = build();
  } catch (err) {
    // A builder that throws synchronously never registered, so there is nothing to release.
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  // The chained promise is what gets stored AND returned, so every caller — the first one included —
  // awaits the same object. Storing `started` and returning it separately would leave the `.finally`
  // chain with no handler, and a failed build would surface as an unhandled rejection on top of the
  // error the caller is already dealing with.
  const shared: Promise<T> = started.finally(() => {
    // Identity-checked: by the time this runs a later request may already have registered its own
    // build under the same key, and deleting blindly would evict a live entry.
    if (inFlight.get(key) === shared) inFlight.delete(key);
  });
  inFlight.set(key, shared);
  return shared;
}

/** How many builds are running right now. For tests and for a future health readout — nothing in a
 *  request path reads it. */
export function inFlightBuilds(): number {
  return inFlight.size;
}
