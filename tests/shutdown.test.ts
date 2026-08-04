import { describe, expect, it } from 'vitest';
import { inFlightCount, shutdown, trackRequest } from '../src/lib/shutdown.js';

/**
 * Graceful shutdown (GO_LIVE §7).
 *
 * The case being defended: a deploy sends `SIGTERM`, and Node's default action is to terminate at
 * once — cutting whatever request is mid-flight, including the POST to `/api/checkout`. These
 * assertions cover the counter and the drain; the signal handler itself is deliberately not
 * exercised, because installing it in a test run means the runner exits on the first Ctrl+C.
 */

describe('the in-flight counter', () => {
  it('returns to zero when a request completes', () => {
    const before = inFlightCount();
    const release = trackRequest();
    expect(inFlightCount()).toBe(before + 1);
    release();
    expect(inFlightCount()).toBe(before);
  });

  it('ignores a double release', () => {
    // A negative counter reads as "nothing in flight" forever after, so every later shutdown would
    // skip the drain entirely — the exact failure this guard exists to prevent.
    const before = inFlightCount();
    const release = trackRequest();
    release();
    release();
    expect(inFlightCount()).toBe(before);
  });
});

describe('draining', () => {
  it('returns immediately and cleanly when nothing is in flight', async () => {
    const started = Date.now();
    expect(await shutdown(5_000)).toBe(true);
    // Would be ~5s if it waited out the deadline regardless.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('waits for a request that is still running, then reports a clean drain', async () => {
    const release = trackRequest();
    setTimeout(release, 120);
    const started = Date.now();
    expect(await shutdown(5_000)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('gives up at the deadline instead of hanging the deploy forever', async () => {
    // A request that never finishes must not stop the process from exiting — the host sends SIGKILL
    // shortly after SIGTERM, so an unbounded wait buys nothing and loses the clean exit.
    const release = trackRequest();
    try {
      expect(await shutdown(150)).toBe(false);
    } finally {
      release();
    }
  });
});
