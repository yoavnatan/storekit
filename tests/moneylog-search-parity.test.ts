import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getMoneyEventsPage, moneyEventPage, type MoneyEvent } from '../src/lib/money-events.js';
import { filterMoneyEvents, eventPage, parseMoneyLogQuery } from '../src/lib/admin-moneylog-filter.js';
import { formatAgorot } from '../src/lib/money.js';
import { MONEY_EVENT_LABELS } from '../src/lib/money-event-types.js';

/**
 * The seam: the admin money journal is filtered TWICE in this repo, by two implementations that must
 * agree — `filterMoneyEvents` in memory, and the SQL that `getMoneyEventsPage` builds.
 *
 * The SQL one is what actually runs. The in-memory one is kept as the readable statement of the
 * rules and is what this file measures the SQL against, over a corpus and over every search an owner
 * plausibly types. Each side is easy to get right alone; only the JOIN between them can be wrong,
 * and it can be wrong SILENTLY — a search that quietly stops finding rows looks exactly like a
 * search with no results.
 *
 * Two of those rules are the whole reason the pushdown was delicate, because neither exists in the
 * database:
 *   · the Hebrew LABEL of the event type — the word on the chip the owner is reading;
 *   · the amount as it is RENDERED (`349.90 ₪`), not as it is stored (`34990`).
 */

const DAY = '2026-07-20';

/** Rows chosen so every searchable column carries something an owner would actually paste, and so
 *  the amounts cover the two branches of `formatPrice`: round (no decimals) and not. */
const SEED: Array<Partial<MoneyEvent> & { type: MoneyEvent['type']; actor: string }> = [
  { type: 'order_created', actor: 'buyer', orderId: crypto.randomUUID(), checkoutRef: 'CK-4471', storeSlug: 'keramika', amountAgorot: 34990, detail: '2 item(s)' },
  { type: 'order_created', actor: 'buyer', orderId: crypto.randomUUID(), checkoutRef: 'CK-4472', storeSlug: 'tools-shop', amountAgorot: 100000, detail: '1 item(s)' },
  { type: 'shipping_status_changed', actor: 'seller-7', orderId: crypto.randomUUID(), storeSlug: 'kids-wear', amountAgorot: 12050, from: 'shipped', to: 'cancelled' },
  { type: 'payment_status_changed', actor: 'system', orderId: crypto.randomUUID(), storeSlug: 'keramika', amountAgorot: 899, from: 'pending', to: 'paid' },
  { type: 'duplicate_checkout_blocked', actor: 'buyer', checkoutRef: 'CK-4473', detail: 'replayed key 50% off' },
  { type: 'charge_voided', actor: 'system', checkoutRef: 'CK-4474', amountAgorot: 234990, detail: 'RELEASE FAILED at provider' },
  { type: 'order_discount_changed', actor: 'seller-7', orderId: crypto.randomUUID(), storeSlug: 'tools-shop', amountAgorot: -1500, from: '150', to: '135' },
  { type: 'payment_attempted', actor: 'buyer', checkoutRef: 'CK-4475', amountAgorot: 0, detail: 'declined: insufficient funds' },
];

/** Every search worth asserting on, each one a thing the panel itself hands the owner to paste, or a
 *  word they can read on a row. The label and amount searches are the ones a naive pushdown breaks. */
const SEARCHES = [
  '', 'ck-4471', 'CK-447', 'keramika', 'seller-7', 'cancelled', 'replayed', 'declined',
  'item(s)', 'tools-shop', 'system', 'buyer', 'paid', 'pending',
  // The Hebrew labels — no such string exists in any column.
  'ביטול', 'חיוב כפול נמנע', 'הזמנה נוצרה', 'סטטוס', 'חיוב',
  // The amount as rendered, as stored, and the grouping comma the renderer inserts.
  '349.90', '349.9', '34990', '1,000', '1000 ₪', '120.50', '8.99', '2,349.90', '-15',
  // `.00` and `9.90` are the two terms that can TELL the renderer's branches apart: a round amount
  // prints `1,000 ₪` and must not answer to `.00`, and a non-round one prints `349.90 ₪` and must
  // answer to `9.90`. Without a term that distinguishes them, printing every amount the same way
  // passes every other assertion in this file — substring matching hides the difference.
  '.00', '9.90', '0.00',
  // Two terms, ANDed.
  'cancelled kids-wear', 'cancelled tools-shop', 'ביטול kids-wear',
  // Nothing should match these.
  'nothing-here', '%', '_', 'ord\\',
  // The raw type name, and a type this deploy has never heard of.
  'order_created', 'some_future_type',
  // A percent sign an owner pastes out of a discount detail is a percent sign, not "match anything".
  '50%',
];

let all: MoneyEvent[] = [];

beforeEach(async () => {
  await query('DELETE FROM money_events');
  for (const [i, row] of SEED.entries()) {
    // Spread across the day so `ORDER BY at DESC, id` is exercised rather than being a tie every time.
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO money_events (id, at, type, order_id, checkout_ref, store_slug, amount_agorot,
                                 from_value, to_value, actor, detail)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id, `${DAY}T0${i}:00:00.000Z`, row.type, row.orderId ?? null, row.checkoutRef ?? null,
        row.storeSlug ?? null, row.amountAgorot ?? null, row.from ?? null, row.to ?? null,
        row.actor, row.detail ?? null,
      ],
    );
  }
  // A row whose type is not in the vocabulary — the column is plain `text` on purpose, and the
  // in-memory matcher still searches its raw name. `%` and `_` land in a detail so the LIKE
  // metacharacters are actually reachable.
  await query(
    `INSERT INTO money_events (id, at, type, actor, detail) VALUES ($1, $2::timestamptz, $3, $4, $5)`,
    [crypto.randomUUID(), `${DAY}T09:00:00.000Z`, 'some_future_type', 'system', '100% match_rate'],
  );
  all = (await getMoneyEventsPage({ from: DAY, to: DAY }, 0, 500)).events;
  expect(all).toHaveLength(SEED.length + 1);
});

const idsOf = (rows: MoneyEvent[]) => rows.map((r) => r.id);

describe('the SQL search and the in-memory search return the same rows', () => {
  for (const search of SEARCHES) {
    it(`agrees on ${JSON.stringify(search)}`, async () => {
      const q = parseMoneyLogQuery(new URLSearchParams({ mq: search, mfrom: DAY, mto: DAY }));
      const inMemory = filterMoneyEvents(all, q);
      const inSql = await getMoneyEventsPage(q, 0, 500);
      expect(idsOf(inSql.events)).toEqual(idsOf(inMemory));
      expect(inSql.total).toBe(inMemory.length);
    });
  }

  it('agrees when a type filter and a search narrow together', async () => {
    for (const mtype of ['order_created', 'shipping_status_changed', 'charge_voided']) {
      for (const mq of ['keramika', 'ביטול', '349.90', '']) {
        const q = parseMoneyLogQuery(new URLSearchParams({ mtype, mq, mfrom: DAY, mto: DAY }));
        const inSql = await getMoneyEventsPage(q, 0, 500);
        expect(idsOf(inSql.events), `${mtype} / ${mq}`).toEqual(idsOf(filterMoneyEvents(all, q)));
      }
    }
  });
});

describe('the rendered amount, reproduced in SQL', () => {
  // `formatAgorot` prints a round amount with NO decimals (`1,000 ₪`) and everything else with two
  // (`349.90 ₪`). Getting that split wrong in SQL would not error — the search would just stop
  // finding the rows an owner searches for most, since they type what they can see.
  it('matches formatAgorot for every shape of amount', async () => {
    // Under a shekel, at a shekel, over a thousand (the grouping comma), round vs not, and negative
    // on each side of those boundaries — the cases `amountGuards` reasons about.
    const amounts = [0, 1, 5, 50, 99, 100, 101, 899, 1005, 1500, 34990, 100000, 100099, 234990, 999999, 100000000, -5, -1500, -100, -234990];
    for (const agorot of amounts) {
      const rendered = formatAgorot(agorot);
      // Search for the rendered string minus the currency symbol — a term never contains a space.
      const term = rendered.replace(' ₪', '');
      const id = crypto.randomUUID();
      await query(
        `INSERT INTO money_events (id, at, type, actor, amount_agorot) VALUES ($1, $2::timestamptz, 'order_created', 'system', $3)`,
        [id, `${DAY}T10:00:00.000Z`, agorot],
      );
      const q = parseMoneyLogQuery(new URLSearchParams({ mq: term, mfrom: DAY, mto: DAY }));
      const hit = await getMoneyEventsPage(q, 0, 500);
      expect(idsOf(hit.events), `${agorot} renders as ${rendered}`).toContain(id);
      await query('DELETE FROM money_events WHERE id = $1', [id]);
    }
  });
});

describe('every substring an owner could have selected off a rendered amount', () => {
  /**
   * The exhaustive version, and the only real guard on `amountGuards`: that function DROPS the
   * expensive rendering arm from the query whenever it can prove no row could match through it, and
   * a proof that is subtly wrong shows up as a search that quietly returns fewer rows. So rather
   * than trusting the reasoning, every substring of every rendering is fed through both matchers.
   */
  const AMOUNTS = [0, 1, 5, 50, 99, 100, 101, 899, 1000, 1005, 1500, 34990, 100000, 100099, 234990, -5, -100, -1500, -234990];

  it('returns the same rows through the SQL arm and the in-memory one', async () => {
    await query('DELETE FROM money_events');
    for (const [i, agorot] of AMOUNTS.entries()) {
      await query(
        `INSERT INTO money_events (id, at, type, actor, amount_agorot)
         VALUES ($1, $2::timestamptz, 'order_created', 'system', $3)`,
        [crypto.randomUUID(), `${DAY}T${String(i).padStart(2, '0')}:00:00.000Z`, agorot],
      );
    }
    const corpus = (await getMoneyEventsPage({ from: DAY, to: DAY }, 0, 500)).events;
    expect(corpus).toHaveLength(AMOUNTS.length);

    const terms = new Set<string>();
    for (const agorot of AMOUNTS) {
      for (const spelling of [formatAgorot(agorot), String(agorot)]) {
        for (let start = 0; start < spelling.length; start++) {
          for (let end = start + 1; end <= spelling.length; end++) {
            const t = spelling.slice(start, end).trim();
            // A term is produced by splitting on whitespace, so one can never contain a space.
            if (t && !/\s/.test(t)) terms.add(t);
          }
        }
      }
    }
    expect(terms.size).toBeGreaterThan(80);

    for (const term of terms) {
      const q = parseMoneyLogQuery(new URLSearchParams({ mq: term, mfrom: DAY, mto: DAY }));
      const inSql = await getMoneyEventsPage(q, 0, 500);
      expect(idsOf(inSql.events), `search ${JSON.stringify(term)}`).toEqual(idsOf(filterMoneyEvents(corpus, q)));
    }
  });
});

describe('the Hebrew labels, resolved before the query', () => {
  it('finds every type by the exact word its chip shows', async () => {
    for (const [type, label] of Object.entries(MONEY_EVENT_LABELS)) {
      const q = parseMoneyLogQuery(new URLSearchParams({ mq: label, mfrom: DAY, mto: DAY }));
      const hit = await getMoneyEventsPage(q, 0, 500);
      const expected = all.filter((e) => e.type === type);
      // Only assert on labels the corpus actually has a row for; the point is that a label search
      // resolves to the TYPE, which no column holds.
      if (expected.length) expect(idsOf(hit.events), label).toEqual(idsOf(expected));
    }
  });
});

describe('paging in SQL agrees with paging in memory', () => {
  it('slices the same rows, page by page, and reports the same total', async () => {
    const q = parseMoneyLogQuery(new URLSearchParams({ mfrom: DAY, mto: DAY }));
    const expected = filterMoneyEvents(all, q);
    for (let page = 1; page <= 3; page++) {
      const got = await getMoneyEventsPage(q, (page - 1) * 3, 3);
      expect(idsOf(got.events), `page ${page}`).toEqual(idsOf(expected.slice((page - 1) * 3, page * 3)));
      expect(got.total).toBe(expected.length);
    }
  });

  it('still reports the total for a page past the end', async () => {
    // A window function riding on the returned rows answers 0 here — there are no rows to ride on —
    // and the pager would report an empty journal for a hand-typed `?mlpage=999`.
    const q = parseMoneyLogQuery(new URLSearchParams({ mfrom: DAY, mto: DAY }));
    const got = await getMoneyEventsPage(q, 900, 15);
    expect(got.events).toEqual([]);
    expect(got.total).toBe(all.length);
  });

  it('resolves a permalink to the same page the in-memory pager would', async () => {
    const q = parseMoneyLogQuery(new URLSearchParams({ mfrom: DAY, mto: DAY }));
    const expected = filterMoneyEvents(all, q);
    for (const e of expected) {
      expect(await moneyEventPage(q, e.id, 3), e.id).toBe(eventPage(expected, e.id, 3));
    }
  });

  it('reports a permalinked row the filter excludes as missing, not as page 1', async () => {
    const outside = all.find((e) => e.storeSlug === 'kids-wear')!;
    const q = parseMoneyLogQuery(new URLSearchParams({ mq: 'keramika', mfrom: DAY, mto: DAY }));
    expect(await moneyEventPage(q, outside.id, 15)).toBeNull();
    expect(eventPage(filterMoneyEvents(all, q), outside.id, 15)).toBeNull();
  });

  it('answers null for a malformed permalink rather than raising', async () => {
    // Postgres REJECTS a bad uuid literal instead of not matching it — unguarded, a hand-edited
    // `?mev=` is a 500 on the whole admin dashboard.
    const q = parseMoneyLogQuery(new URLSearchParams({ mfrom: DAY, mto: DAY }));
    expect(await moneyEventPage(q, 'not-a-uuid', 15)).toBeNull();
    expect(await moneyEventPage(q, '', 15)).toBeNull();
  });
});
