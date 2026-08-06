/**
 * `lib/single-flight.ts` — the guard that stops the two public catalogue-wide routes from being a
 * free way to stall the storefront.
 *
 * The thing under test is a COUNT: how many full builds N simultaneous callers cause. Node runs one
 * event loop, `/api/feed/products.xml` and `/sitemap-content.xml` are public and take no token, and
 * each assembles the whole mall into one string (6.1 seconds at 45 stores, measured in this repo).
 * Every extra concurrent build is that much time the shopper at checkout spends waiting behind a
 * service they have never heard of.
 *
 * Every test here drives the failure or the edge, not the happy path: the happy path is one caller,
 * and one caller never needed a guard.
 */
import { describe, expect, it, vi } from 'vitest';
import { inFlightBuilds, singleFlight } from '../src/lib/single-flight.js';

/** A build that finishes only when told to — the whole mechanism is about what happens DURING one. */
function pending<T>() {
  let release!: (value: T) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { release = resolve; fail = reject; });
  return { promise, release, fail };
}

describe('concurrent callers', () => {
  it('cause ONE build, not one each', async () => {
    const gate = pending<string>();
    const build = vi.fn(() => gate.promise);

    const callers = [1, 2, 3, 4, 5].map(() => singleFlight('k', build));
    expect(build).toHaveBeenCalledTimes(1);

    gate.release('<xml/>');
    expect(await Promise.all(callers)).toEqual(['<xml/>', '<xml/>', '<xml/>', '<xml/>', '<xml/>']);
  });

  it('all receive the same answer, so no caller is served something the others were not', async () => {
    const gate = pending<{ n: number }>();
    const [a, b] = [singleFlight('k2', () => gate.promise), singleFlight('k2', () => gate.promise)];
    gate.release({ n: 1 });
    expect(await a).toBe(await b);
  });

  it('does not merge different keys — two routes must never share one build', async () => {
    const feed = vi.fn(() => Promise.resolve('feed'));
    const sitemap = vi.fn(() => Promise.resolve('sitemap'));
    const [f, s] = await Promise.all([
      singleFlight('feed:products.xml', feed),
      singleFlight('sitemap:platform', sitemap),
    ]);
    expect([f, s]).toEqual(['feed', 'sitemap']);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(sitemap).toHaveBeenCalledTimes(1);
  });
});

describe('after a build settles', () => {
  it('the next request builds fresh — this is a de-duplicator, never a cache', async () => {
    // The distinction is the reason no TTL was chosen: a caller may join a build already running,
    // but nobody is ever handed a snapshot from a build that had already finished. A crawler that
    // pulls an hour later must see the products added in that hour.
    const build = vi.fn(() => Promise.resolve('v1'));
    await singleFlight('k3', build);
    await singleFlight('k3', build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('releases the key even when the build fails', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('database down')));
    await expect(singleFlight('k4', failing)).rejects.toThrow('database down');
    expect(inFlightBuilds()).toBe(0);

    // …and the failure is not remembered: the outage that caused it is expected to end.
    await expect(singleFlight('k4', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('a build that fails', () => {
  it('fails every joined caller with the same error rather than only the first', async () => {
    const gate = pending<string>();
    const callers = [singleFlight('k5', () => gate.promise), singleFlight('k5', () => gate.promise)];
    // Both are awaited below, so the rejection is handled on every branch — an unhandled one here
    // would be reported by `lib/process-errors.ts` in production, which is exactly the noise a
    // shared promise stored without its `.finally` chain would produce.
    gate.fail(new Error('pool exhausted'));
    await expect(callers[0]).rejects.toThrow('pool exhausted');
    await expect(callers[1]).rejects.toThrow('pool exhausted');
    expect(inFlightBuilds()).toBe(0);
  });

  it('survives a builder that throws SYNCHRONOUSLY, and registers nothing', async () => {
    // A synchronous throw never produced a promise, so there is no key to release. Getting this
    // wrong the other way — registering first — would wedge the key forever and take the route
    // down permanently on one transient programming error.
    await expect(singleFlight('k6', () => { throw new Error('bad config'); })).rejects.toThrow('bad config');
    expect(inFlightBuilds()).toBe(0);
    await expect(singleFlight('k6', () => Promise.resolve('recovered'))).resolves.toBe('recovered');
  });
});

describe('bookkeeping', () => {
  it('holds nothing once everything has settled — no unbounded growth across requests', async () => {
    await Promise.all(['a', 'b', 'c'].map((k) => singleFlight(k, () => Promise.resolve(k))));
    expect(inFlightBuilds()).toBe(0);
  });
});
