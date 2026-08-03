/**
 * The concurrency cap in `lib/error-log.ts`, under the condition it exists for — a storm of 500s
 * against a database that has stopped answering (DB_MIGRATION_PLAN.md §8, stage 3 load check).
 *
 * **Why this is a separate file from `error-log-db.test.ts`.** That one runs against a real (PGlite)
 * database, where every query returns in microseconds and nothing is ever concurrent — so it can
 * assert what a write STORES, and cannot assert anything about how many connections one is holding.
 * The cap is a claim about the resource, not about the row, and to test it the database has to be
 * slow on purpose. So this file installs a stub that never resolves until told to.
 *
 * **What the cap is protecting.** `middleware.ts` catches every 500 and calls `logError`. When the
 * database is what broke, EVERY request is a 500 — so without the cap every request would sit in
 * the error handler holding a pooled connection until `connectionTimeoutMillis` +
 * `statement_timeout` expired. With a pool of 10, an outage would escalate itself into a total
 * freeze. Two is the whole budget this module may spend, no matter how fast errors arrive.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setDatabase, type Database, type Queryable } from '../src/lib/db.js';
import { logError } from '../src/lib/error-log.js';

/** The number `error-log.ts` declares. Duplicated deliberately: if it changes, this must be a
 *  decision, and a test that reads the constant would silently agree with any new value. */
const MAX_CONCURRENT_WRITES = 2;

/** A database that answers nothing until released, and counts how many callers are waiting. */
function stallingDatabase() {
  let live = 0;
  let peak = 0;
  const waiting: (() => void)[] = [];
  const queryable: Queryable = {
    query: async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise<void>((resolve) => waiting.push(resolve));
      live--;
      return { rows: [], rowCount: 0 };
    },
  };
  const db: Database = {
    query: queryable.query,
    transaction: (run) => run(queryable),
    close: async () => {},
  };
  return {
    db,
    get peak() { return peak; },
    get pending() { return waiting.length; },
    releaseAll() { for (const done of waiting.splice(0)) done(); },
  };
}

afterEach(() => {
  setDatabase(undefined);
  vi.restoreAllMocks();
});

describe('a storm of errors cannot drain the pool', () => {
  it(`holds at most ${MAX_CONCURRENT_WRITES} connections while 50 requests fail at once`, async () => {
    const stub = stallingDatabase();
    setDatabase(stub.db);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 50 simultaneous 500s, exactly as `middleware.ts` issues them: never awaited by the caller.
    const storm = Array.from({ length: 50 }, (_, i) =>
      logError({ source: 'server', route: '/x', message: `boom ${i}`, statusCode: 500 }));

    // Let every call reach its first `await`. Only the ones inside the cap are now holding
    // anything; the other 48 must already have given up rather than queued behind them.
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    expect(stub.peak).toBeLessThanOrEqual(MAX_CONCURRENT_WRITES);
    expect(stub.pending).toBe(MAX_CONCURRENT_WRITES);

    // Dropped, not queued — and still audible, because stderr is where an external monitor reads.
    expect(stderr.mock.calls.filter((c) => String(c[0]).includes('dropped (busy)')))
      .toHaveLength(50 - MAX_CONCURRENT_WRITES);

    stub.releaseAll();
    await expect(Promise.all(storm)).resolves.toBeDefined();
  });

  it('gives the budget back once a write finishes, so a recovered database logs again', async () => {
    const stub = stallingDatabase();
    setDatabase(stub.db);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = Array.from({ length: 5 }, () => logError({ source: 'server', message: 'a' }));
    await new Promise((r) => setImmediate(r));
    expect(stub.pending).toBe(MAX_CONCURRENT_WRITES);

    stub.releaseAll();
    await Promise.all(first);

    // The slots were released, not leaked — a cap that never gives back would silence the log for
    // the rest of the process, which is indistinguishable from the outage it was meant to survive.
    const second = logError({ source: 'server', message: 'b' });
    await new Promise((r) => setImmediate(r));
    expect(stub.pending).toBe(1);
    stub.releaseAll();
    await second;
  });

  it('releases the slot when the write THROWS, not only when it succeeds', async () => {
    setDatabase({
      query: async () => { throw new Error('connection terminated'); },
      transaction: async () => { throw new Error('connection terminated'); },
      close: async () => {},
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Three times the cap, one after another. If a failed write kept its slot, the third call
    // onwards would be dropped instead of attempted — an outage would permanently silence the log.
    for (let i = 0; i < 6; i++) await logError({ source: 'server', message: `fail ${i}` });

    expect(stderr.mock.calls.filter((c) => String(c[0]).includes('write failed'))).toHaveLength(6);
    expect(stderr.mock.calls.filter((c) => String(c[0]).includes('dropped (busy)'))).toHaveLength(0);
  });
});
