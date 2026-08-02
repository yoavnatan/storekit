import { beforeEach, describe, expect, it } from 'vitest';
import { getDatabase, query, setDatabase, type Database } from '../src/lib/db.js';
import { getMoneyEvents, recordMoneyEvent } from '../src/lib/money-events.js';

/**
 * The money journal, against a real Postgres — moved with `orders`
 * (DB_MIGRATION_PLAN.md §4/§8).
 *
 * **Nothing tested the journal's I/O before this file.** `money-events-select.test.ts` covers the
 * pure narrowing over rows handed to it, and `money-guards.test.ts` scans the source of the money
 * paths for missing `recordMoneyEvent` calls. Neither appends and neither reads, so an append that
 * dropped the amount, wrote the wrong day, or threw into the charge it was recording would have
 * left both green — and the third of those is the one that turns "we failed to log the charge"
 * into "we failed to charge".
 *
 * The date window is asserted on the BUSINESS calendar (§7.8), because that is where a journal and
 * a chart most easily come to disagree by three hours without either looking wrong.
 */

const ORDER = '55555555-5555-4555-8555-000000000001';

beforeEach(async () => {
  await query('DELETE FROM money_events');
});

describe('appending', () => {
  it('writes every field back exactly, with absent optionals absent', async () => {
    const entry = await recordMoneyEvent({
      type: 'order_created',
      orderId: ORDER,
      checkoutRef: 'CHK-1',
      storeSlug: 'keramika',
      amountAgorot: 27151,
      to: 'paid',
      actor: 'buyer',
      detail: '2 item(s)',
    });
    const [read] = await getMoneyEvents();
    expect(read!.id).toBe(entry.id);
    expect(read!.amountAgorot).toBe(27151);
    expect(read!.orderId).toBe(ORDER);
    expect(read!.checkoutRef).toBe('CHK-1');
    expect(read!.to).toBe('paid');
    expect('from' in read!).toBe(false);
  });

  it('keeps an event with no order — a charge that failed before any order row existed', async () => {
    await recordMoneyEvent({ type: 'payment_attempted', checkoutRef: 'CHK-2', actor: 'buyer', amountAgorot: 5000 });
    const [read] = await getMoneyEvents();
    expect('orderId' in read!).toBe(false);
    expect(read!.amountAgorot).toBe(5000);
  });

  it('holds the amount as an EXACT integer — no float tail, no bigint-as-string', async () => {
    // `bigint` comes back from `pg` as a string and from PGlite as a number. Untouched, the admin's
    // free-text search would match one spelling and not the other, and a sum would concatenate.
    await recordMoneyEvent({ type: 'order_created', actor: 'system', amountAgorot: 27151 });
    const [read] = await getMoneyEvents();
    expect(read!.amountAgorot).toBe(27151);
    expect(typeof read!.amountAgorot).toBe('number');
  });

  it('rounds a fractional amount rather than refusing the row', async () => {
    // Agorot are integers by definition; a caller handing over a fraction means a bug upstream, and
    // failing the INSERT would make the journal the thing that breaks the charge it is recording.
    await recordMoneyEvent({ type: 'order_created', actor: 'system', amountAgorot: 100.4 });
    expect((await getMoneyEvents())[0]!.amountAgorot).toBe(100);
  });

  it('NEVER throws, even when the database is gone', async () => {
    // The rule the module exists under: a failure to journal must not fail the operation being
    // journalled. It still returns the entry, so a caller can log its id.
    const real = getDatabase();
    const broken: Database = {
      query: () => Promise.reject(new Error('connection lost')),
      transaction: () => Promise.reject(new Error('connection lost')),
      close: () => Promise.resolve(),
    };
    setDatabase(broken);
    try {
      const entry = await recordMoneyEvent({ type: 'order_created', actor: 'system', amountAgorot: 1 });
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      setDatabase(real);
    }
  });
});

describe('reading', () => {
  it('returns newest-first with a stable tie-break', async () => {
    // Two events appended in the same instant share an `at`; without the `id` tie-break the pair
    // would swap places between two loads of the same admin page.
    for (const detail of ['a', 'b', 'c']) {
      await recordMoneyEvent({ type: 'order_created', actor: 'system', detail });
    }
    const first = (await getMoneyEvents()).map((e) => e.id);
    expect(first).toHaveLength(3);
    expect((await getMoneyEvents()).map((e) => e.id)).toEqual(first);
  });

  it('narrows by type in the QUERY, over the whole journal', async () => {
    // The narrowing has to happen before any paging: it used to take the newest N rows and filter
    // those, which is how the type filter came to look broken on a busy journal.
    await recordMoneyEvent({ type: 'order_created', actor: 'system' });
    await recordMoneyEvent({ type: 'payment_attempted', actor: 'buyer' });
    const narrowed = await getMoneyEvents('payment_attempted');
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]!.type).toBe('payment_attempted');
    expect(await getMoneyEvents()).toHaveLength(2);
  });

  it('narrows by the BUSINESS day, not the UTC one (§7.8)', async () => {
    // 2026-06-01T22:30Z is already 2026-06-02 in Asia/Jerusalem (UTC+3 in June). A UTC window
    // would file it under the 1st — the same off-by-a-few-hours that put after-midnight sales on
    // the previous day in every report before business-day.ts existed. A row found by searching a
    // date here must be the row the seller's chart counts on that day.
    await query(
      `INSERT INTO money_events (id, at, type, actor) VALUES (gen_random_uuid(), $1::timestamptz, 'order_created', 'system')`,
      ['2026-06-01T22:30:00.000Z'],
    );
    expect(await getMoneyEvents(undefined, '2026-06-02', '2026-06-02')).toHaveLength(1);
    expect(await getMoneyEvents(undefined, '2026-06-01', '2026-06-01')).toHaveLength(0);
  });

  it('treats an open-ended window as open-ended', async () => {
    await recordMoneyEvent({ type: 'order_created', actor: 'system' });
    expect(await getMoneyEvents(undefined, undefined, undefined)).toHaveLength(1);
    expect(await getMoneyEvents(undefined, '', '')).toHaveLength(1);
  });

  it('shows a row whose type this deploy has never heard of, rather than hiding it', async () => {
    // The column is plain `text` on purpose: the journal carries legacy and seeded rows (the
    // fixture holds `charge` and `status`), and a ledger that silently omits what it cannot label
    // is worse than one that shows an unfamiliar word.
    await query(
      `INSERT INTO money_events (id, at, type, actor) VALUES (gen_random_uuid(), now(), 'some_future_type', 'system')`,
    );
    const [read] = await getMoneyEvents();
    expect(read!.type).toBe('some_future_type');
  });

  it('drops a day-shaped bound that is not a day, instead of raising on it', async () => {
    // `?mfrom=2026-02-30` reaches here from the admin money-journal toolbar. Postgres RAISES
    // `date/time field value out of range` on the `::date` cast rather than matching nothing, so
    // an unguarded bound took the WHOLE admin dashboard down with a 500 (business-day.ts#isDayISO).
    const all = await getMoneyEvents();
    for (const impossible of ['9999-99-99', '2026-02-30', '2026-13-01']) {
      await expect(getMoneyEvents(undefined, impossible, undefined), impossible).resolves.toHaveLength(all.length);
      await expect(getMoneyEvents(undefined, undefined, impossible), impossible).resolves.toHaveLength(all.length);
    }
  });
});
