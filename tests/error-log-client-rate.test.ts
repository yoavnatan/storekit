/**
 * The rate ceiling on CLIENT-sourced log entries.
 *
 * `POST /api/log-client-error` is unauthenticated and unrated — the one write path in this
 * application that any stranger may call for free — and each accepted call costs up to three
 * identity lookups plus an insert-and-prune. `MAX_CONCURRENT_WRITES` (see
 * `error-log-pool-guard.test.ts`) bounds how much of the pool this module holds at one INSTANT; it
 * says nothing about the rate, so a caller sending reports back to back keeps two connections busy
 * indefinitely and writes forever. The browser reporter caps itself at five per page load, which
 * defends against a runaway loop in our own JavaScript and not at all against someone who is not
 * using a browser.
 *
 * Server entries are deliberately NOT capped: a storm of 500s is exactly what you want recorded,
 * and only our own code can produce one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setDatabase, type Database, type Queryable } from '../src/lib/db.js';
import { logError, resetClientWriteBudget } from '../src/lib/error-log.js';

/** The numbers `error-log.ts` declares. Duplicated deliberately: a test that read the constants
 *  would agree with any new value instead of making a change be a decision. */
const MAX_CLIENT_WRITES_PER_WINDOW = 60;
const CLIENT_WINDOW_MS = 60_000;

function countingDatabase() {
  let writes = 0;
  const queryable: Queryable = {
    query: async (text: string) => {
      if (/INSERT INTO error_log/.test(text)) writes++;
      return { rows: [], rowCount: 0 };
    },
  };
  const db: Database = {
    query: queryable.query,
    transaction: (run) => run(queryable),
    close: async () => {},
  };
  return { db, get writes() { return writes; } };
}

afterEach(() => {
  setDatabase(undefined);
  resetClientWriteBudget();
  vi.restoreAllMocks();
});

/** `logError` is fire-and-forget by contract, so a caller cannot await the write. Sequential
 *  awaits here also keep `inFlight` at one, which isolates the RATE cap from the CONCURRENCY cap. */
async function report(source: 'client' | 'server', n: number): Promise<void> {
  for (let i = 0; i < n; i++) await logError({ source, message: `boom ${i}` });
}

describe('client error-log rate cap', () => {
  it('writes client reports up to the cap and drops the rest', async () => {
    const counting = countingDatabase();
    setDatabase(counting.db);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await report('client', MAX_CLIENT_WRITES_PER_WINDOW + 40);
    expect(counting.writes).toBe(MAX_CLIENT_WRITES_PER_WINDOW);
  });

  it('a dropped report still reaches stderr, where an external log drain reads', async () => {
    const counting = countingDatabase();
    setDatabase(counting.db);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await report('client', MAX_CLIENT_WRITES_PER_WINDOW + 1);
    expect(stderr).toHaveBeenCalledWith('[error-log] dropped (client rate cap):', expect.any(String));
  });

  it('does not cap server errors — a storm of 500s is what you want recorded', async () => {
    const counting = countingDatabase();
    setDatabase(counting.db);

    await report('server', MAX_CLIENT_WRITES_PER_WINDOW + 40);
    expect(counting.writes).toBe(MAX_CLIENT_WRITES_PER_WINDOW + 40);
  });

  it('the budget refills on the next window, so a real incident is not silenced forever', async () => {
    const counting = countingDatabase();
    setDatabase(counting.db);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await report('client', MAX_CLIENT_WRITES_PER_WINDOW);
    expect(counting.writes).toBe(MAX_CLIENT_WRITES_PER_WINDOW);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + CLIENT_WINDOW_MS + 1);
    await report('client', 5);
    expect(counting.writes).toBe(MAX_CLIENT_WRITES_PER_WINDOW + 5);
  });

  it('spends no identity lookups on a report it is going to drop', async () => {
    // The three context queries are most of what the cap exists to stop a stranger from buying.
    // Checking the budget after paying them would leave the cost in place and cap only the insert.
    let queries = 0;
    const queryable: Queryable = {
      query: async () => { queries++; return { rows: [], rowCount: 0 }; },
    };
    setDatabase({ query: queryable.query, transaction: (run) => run(queryable), close: async () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await report('client', MAX_CLIENT_WRITES_PER_WINDOW);
    const afterCap = queries;
    await report('client', 20);
    expect(queries).toBe(afterCap);
  });
});
