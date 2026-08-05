/**
 * The admin Alerts log against a real Postgres (DB_MIGRATION_PLAN.md §8).
 *
 * **This module had ZERO coverage — measured, not assumed (2026-08-02).** Replacing its file I/O
 * with stubs that return nothing left the whole suite at 1825 of 1825. `tests/error-log.test.ts`
 * exercises the two pure functions beside it (`filterAndSortErrors`, `getErrorStoreNames`) over
 * hand-built arrays and never reads or writes an entry, so a replacement that stored nothing at all
 * would have stayed green in 147 files.
 *
 * The two things this file exists to hold still are the two decisions of that move:
 *   · writing is fire-and-forget with a hard cap on how much of the connection pool it may hold,
 *     because it runs inside the error handler and the database is often what broke;
 *   · `MAX_ENTRIES` is still a ceiling on the TABLE, not a `LIMIT` on the read — the endpoint that
 *     feeds it is unauthenticated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AstroCookies } from 'astro';
import { query } from '../src/lib/db.js';
import {
  logError,
  getRecentErrors,
  clearErrorLog,
  setErrorResolved,
  truncateStack,
  MAX_ENTRIES,
} from '../src/lib/error-log.js';

/** Every test here writes the log, so each starts from an empty one and leaves it empty. */
beforeEach(async () => { await query('DELETE FROM error_log'); });
afterEach(async () => { await query('DELETE FROM error_log'); });

async function countRows(): Promise<number> {
  const { rows } = await query<{ n: number | string }>('SELECT COUNT(*) AS n FROM error_log');
  return Number(rows[0]!.n);
}

describe('writing one entry', () => {
  it('stores every field the caller supplied, and reads it back in the same shape', async () => {
    await logError({
      source: 'client',
      route: '/checkout',
      message: 'boom',
      stack: 'at foo()',
      statusCode: 502,
      storeSlug: 'keramika',
      storeName: 'קרמיקה',
      actorRole: 'seller',
      actorId: 'acct-1',
      actorLabel: 'a@b.com',
      resolutionHint: 'check the mailer',
    });

    const [entry] = await getRecentErrors();
    expect(entry).toMatchObject({
      source: 'client',
      route: '/checkout',
      message: 'boom',
      stack: 'at foo()',
      statusCode: 502,
      storeSlug: 'keramika',
      storeName: 'קרמיקה',
      actorRole: 'seller',
      actorId: 'acct-1',
      actorLabel: 'a@b.com',
      resolutionHint: 'check the mailer',
      resolved: false,
    });
    expect(entry!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(entry!.createdAt))).toBe(false);
  });

  it('leaves an unsupplied field ABSENT rather than null', async () => {
    // Every consumer of ErrorLogEntry tests these with `?.`/`??` — `storeSlug: null` is truthy in
    // none of those but IS an own key, which changes `'storeSlug' in entry` and any spread merge.
    await logError({ source: 'server', message: 'bare' });
    const [entry] = await getRecentErrors();
    expect(entry).not.toHaveProperty('storeSlug');
    expect(entry).not.toHaveProperty('actorRole');
    expect(entry).not.toHaveProperty('statusCode');
    expect(entry!.message).toBe('bare');
  });

  it('never rejects when the write fails, and says so on stderr instead of swallowing it', async () => {
    // The old file version swallowed every failure silently. A logging call must still not throw —
    // it runs inside the handler for an error that already happened — but a failure that leaves no
    // trace anywhere is how a broken log stays broken.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await query('ALTER TABLE error_log RENAME TO error_log_hidden');
    try {
      await expect(logError({ source: 'server', message: 'while the table is gone' })).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.flat().join(' ')).toContain('while the table is gone');
    } finally {
      await query('ALTER TABLE error_log_hidden RENAME TO error_log');
      spy.mockRestore();
    }
  });
});

describe('the identity lookup, which now happens inside the write', () => {
  /** Enough of AstroCookies for `getSellerSession` — it reads exactly one cookie. */
  const noSession = { get: () => undefined } as unknown as AstroCookies;

  it('derives the store from the path, so the caller does not have to await three queries', async () => {
    // This is the shape of the decision: middleware.ts used to `await resolveErrorContext(…)` and
    // only then call logError, i.e. the error path waited on the database that had probably just
    // failed. The lookups moved in here, behind the same `void` and the same concurrency cap.
    await logError({ source: 'server', message: 'on a store page' }, { pathname: '/keramika/mug', cookies: noSession });
    const [entry] = await getRecentErrors();
    expect(entry!.storeSlug).toBe('keramika');
    expect(entry!.storeName).toBe('קרמיקה');
  });

  it('leaves the fields unset for a path that is not a store', async () => {
    await logError({ source: 'server', message: 'on checkout' }, { pathname: '/checkout', cookies: noSession });
    const [entry] = await getRecentErrors();
    expect(entry).not.toHaveProperty('storeSlug');
  });

  it('lets the caller override what the path would have resolved', async () => {
    // checkout.ts knows the buyer's email and every store in the cart; a path segment knows one
    // slug. The specific answer has to win.
    await logError(
      { source: 'server', message: 'checkout knows better', storeSlug: 'tachshitim', storeName: 'תכשיטים' },
      { pathname: '/keramika/mug', cookies: noSession },
    );
    const [entry] = await getRecentErrors();
    expect(entry!.storeSlug).toBe('tachshitim');
    expect(entry!.storeName).toBe('תכשיטים');
  });

  it('does not let an explicitly-undefined field blank what the path resolved', async () => {
    // A plain spread would: `{ ...ctx, storeSlug: undefined }` has the key, and its value wins. The
    // caller here is not saying "no store", it is saying nothing — every one of these fields is
    // optional and the objects the call sites build are assembled conditionally.
    await logError(
      { source: 'server', message: 'says nothing about the store', storeSlug: undefined, storeName: undefined },
      { pathname: '/keramika/mug', cookies: noSession },
    );
    const [entry] = await getRecentErrors();
    expect(entry!.storeSlug).toBe('keramika');
    expect(entry!.storeName).toBe('קרמיקה');
  });

  it('still records the entry when the identity lookup itself fails', async () => {
    // The context is best-effort; the entry is the point. A cookies object that throws stands in
    // for the case this actually guards — the database being down for the lookup too.
    const angry = { get: () => { throw new Error('no cookie jar'); } } as unknown as AstroCookies;
    await logError({ source: 'server', message: 'context blew up' }, { pathname: '/keramika', cookies: angry });
    expect((await getRecentErrors())[0]!.message).toBe('context blew up');
  });
});

describe('the ceiling on the table', () => {
  it('never lets the table exceed MAX_ENTRIES, however many arrive', async () => {
    // This is the decision the move had to make: `slice(-500)` on a file capped the STORAGE, while
    // a `LIMIT` on the read would cap only what the admin sees. The storage is what has to be
    // bounded, because `POST /api/log-client-error` is unauthenticated.
    //
    // `server`, not `client`, and the swap is the point rather than a detail: client entries now
    // also pass a per-minute rate cap (`tests/error-log-client-rate.test.ts`), so writing 525 of
    // them would be measuring that cap instead of this one. Two layers, deliberately independent —
    // the rate cap bounds what a stranger can spend, this bounds what the table can ever hold, and
    // server entries are subject only to the second.
    for (let i = 0; i < MAX_ENTRIES + 25; i++) {
      await logError({ source: 'server', message: `e${i}` });
    }
    expect(await countRows()).toBe(MAX_ENTRIES);
  });

  it('drops the OLDEST first, so the newest arrival is always kept', async () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await logError({ source: 'server', message: `e${i}` });
    }
    const entries = await getRecentErrors(MAX_ENTRIES);
    expect(entries[0]!.message).toBe(`e${MAX_ENTRIES + 4}`);
    expect(entries.map((e) => e.message)).not.toContain('e0');
    expect(entries.map((e) => e.message)).toContain(`e${5}`);
  });

  it('leaves a log below the cap completely alone', async () => {
    await logError({ source: 'server', message: 'first' });
    await logError({ source: 'server', message: 'second' });
    expect(await countRows()).toBe(2);
  });
});

describe('the caps and the CHECK constraints', () => {
  it('trims a message that has no length limit anywhere else', async () => {
    // In middleware.ts this is `err.message`, which can carry request input — a Postgres error
    // quotes the value it rejected. Neither the code nor the column bounded it before.
    await logError({ source: 'server', message: 'x'.repeat(5000) });
    const [entry] = await getRecentErrors();
    expect(entry!.message.length).toBeLessThanOrEqual(500);
  });

  it('truncates a stack rather than storing the whole thing', async () => {
    await logError({ source: 'server', message: 'm', stack: 'y'.repeat(9000) });
    const [entry] = await getRecentErrors();
    expect(entry!.stack!.length).toBe(2001); // 2000 + the ellipsis truncateStack appends
  });

  it('keeps a value the CHECK would reject out of the column', async () => {
    // `source IN ('server','client')` and `actor_role IN ('buyer','seller')`. A violation raises —
    // inside the error handler, which is the worst place in the application for a second error.
    await logError({
      source: 'nonsense' as 'server',
      message: 'coerced',
      actorRole: 'admin' as 'buyer',
    });
    const [entry] = await getRecentErrors();
    expect(entry!.source).toBe('server');
    expect(entry).not.toHaveProperty('actorRole');
  });

  it('keeps a number the integer column could not hold out of status_code', async () => {
    // `1e30` is not a big status, it is `value out of range` — the same shape as the cart `qty`
    // crashes review-diff found in the buyer-state diff.
    await logError({ source: 'server', message: 'huge', statusCode: 1e30 });
    await logError({ source: 'server', message: 'negative', statusCode: -5 });
    const entries = await getRecentErrors();
    expect(entries.every((e) => !('statusCode' in e))).toBe(true);
  });
});

describe('the concurrency cap', () => {
  it('drops rather than queues once too many writes are already in flight', async () => {
    // The point is the connection pool, not the log: when the database is down EVERY request is a
    // 500, so every request runs this handler. Without a cap a storm of errors takes the pool that
    // the healthy requests need, and the outage amplifies itself.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await Promise.all(Array.from({ length: 12 }, (_, i) => logError({ source: 'server', message: `burst${i}` })));
      expect(await countRows()).toBeLessThan(12);
      // Dropped is not lost — stderr is where an external monitor reads from.
      expect(spy.mock.calls.flat().join(' ')).toContain('dropped');
    } finally {
      spy.mockRestore();
    }
  });

  it('is released again afterwards, so a later error is still recorded', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all(Array.from({ length: 12 }, (_, i) => logError({ source: 'server', message: `burst${i}` })));
    spy.mockRestore();
    await clearErrorLog();
    await logError({ source: 'server', message: 'after the storm' });
    expect((await getRecentErrors())[0]!.message).toBe('after the storm');
  });
});

describe('reading', () => {
  it('returns newest first and honours the limit', async () => {
    await logError({ source: 'server', message: 'oldest' });
    await logError({ source: 'server', message: 'middle' });
    await logError({ source: 'server', message: 'newest' });
    expect((await getRecentErrors()).map((e) => e.message)).toEqual(['newest', 'middle', 'oldest']);
    expect((await getRecentErrors(1)).map((e) => e.message)).toEqual(['newest']);
  });

  it('returns nothing on an empty log rather than failing', async () => {
    expect(await getRecentErrors()).toEqual([]);
  });

  it('orders by ARRIVAL, not by the clock — entries that share a timestamp still sort right', async () => {
    // This is the defect that produced migrations/0005, and it was found by this file failing, not
    // by reading the code: `now()` has finite resolution, three sequential writes landed on the
    // same millisecond, and the tie-break behind them was a random uuid. Forcing an identical
    // timestamp on every row is that condition made certain rather than hoped for.
    for (let i = 0; i < 6; i++) await logError({ source: 'server', message: `arrival${i}` });
    await query(`UPDATE error_log SET created_at = '2026-01-01T00:00:00Z'`);
    expect((await getRecentErrors()).map((e) => e.message))
      .toEqual(['arrival5', 'arrival4', 'arrival3', 'arrival2', 'arrival1', 'arrival0']);
  });

  it('evicts by arrival too, so a burst cannot drop an entry newer than one it keeps', async () => {
    // The half that is not cosmetic: the ceiling DELETEs by this order, and a burst is exactly when
    // the ceiling engages.
    for (let i = 0; i < MAX_ENTRIES; i++) await logError({ source: 'server', message: `old${i}` });
    await query(`UPDATE error_log SET created_at = '2026-01-01T00:00:00Z'`);
    await logError({ source: 'server', message: 'the newest' });
    const entries = await getRecentErrors(MAX_ENTRIES);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0]!.message).toBe('the newest');
    // The one that left is the first that arrived, not whichever uuid sorted lowest.
    expect(entries.map((e) => e.message)).not.toContain('old0');
    expect(entries.map((e) => e.message)).toContain('old1');
  });
});

describe('admin triage', () => {
  it('flips the one human-toggled field and reports that it did', async () => {
    await logError({ source: 'server', message: 'triage me' });
    const [entry] = await getRecentErrors();
    expect(await setErrorResolved(entry!.id, true)).toBe(true);
    expect((await getRecentErrors())[0]!.resolved).toBe(true);
    expect(await setErrorResolved(entry!.id, false)).toBe(true);
    expect((await getRecentErrors())[0]!.resolved).toBe(false);
  });

  it('reports false for an id that matches no row — the route turns that into a 404', async () => {
    expect(await setErrorResolved('cccccccc-cccc-4ccc-8ccc-999999999999', true)).toBe(false);
  });

  it('answers false for a malformed id instead of raising', async () => {
    // The id arrives in a request body, and Postgres REJECTS a bad uuid literal rather than failing
    // to match it — without the shape check `{"id":"nope"}` is a 500 where a 404 belongs.
    await expect(setErrorResolved('nope', true)).resolves.toBe(false);
    await expect(setErrorResolved('', true)).resolves.toBe(false);
    await expect(setErrorResolved("' OR 1=1 --", true)).resolves.toBe(false);
  });

  it('clears the whole log', async () => {
    await logError({ source: 'server', message: 'a' });
    await logError({ source: 'server', message: 'b' });
    await clearErrorLog();
    expect(await countRows()).toBe(0);
  });
});

describe('truncateStack', () => {
  it('is unchanged by the move — still pure, still the module default', () => {
    expect(truncateStack('short', 2000)).toBe('short');
    expect(truncateStack('a'.repeat(50), 10)).toBe('a'.repeat(10) + '…');
  });
});
