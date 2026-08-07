import { describe, expect, it } from 'vitest';
import {
  parseMoneyLogQuery,
  filterMoneyEvents,
  eventPage,
  hasActiveMoneyLogFilters,
  widenToEvent,
  MONEY_LOG_DEFAULT_DAYS,
} from '../src/lib/admin-moneylog-filter.js';
import type { MoneyEvent } from '../src/lib/money-events.js';

/**
 * The money journal's search / date-window / row-permalink (owner, סשן ג׳). Every rule
 * here is one the UI cannot state for itself: what a search term is allowed to match,
 * which calendar a date bound means, and which page a permalink resolves to.
 */

/** `today` is pinned so the default window is a fixed pair of dates rather than whatever the
 *  clock says while the suite runs. */
const TODAY = '2026-07-31';
const q = (search: string) => parseMoneyLogQuery(new URLSearchParams(search), TODAY);

function ev(over: Partial<MoneyEvent> & { id: string; at: string }): MoneyEvent {
  return { type: 'order_created', actor: 'system', ...over };
}

// 2026-07-28T23:30Z is 02:30 on the 29th in Asia/Jerusalem — the row whose business
// day differs from its UTC day, which is the whole reason business-day.ts exists.
const LATE_NIGHT = ev({ id: 'a', at: '2026-07-28T23:30:00.000Z', orderId: 'ord-11112222', amountAgorot: 34990, storeSlug: 'tools-shop' });
const CANCELLED = ev({ id: 'b', at: '2026-07-30T10:00:00.000Z', type: 'shipping_status_changed', from: 'shipped', to: 'cancelled', orderId: 'ord-33334444', storeSlug: 'kids-wear', actor: 'seller-7' });
const BLOCKED = ev({ id: 'c', at: '2026-07-31T08:00:00.000Z', type: 'duplicate_checkout_blocked', checkoutRef: 'CK-9090', detail: 'replayed key', actor: 'buyer' });
const ALL = [BLOCKED, CANCELLED, LATE_NIGHT]; // newest-first, as getMoneyEvents returns

const ids = (rows: MoneyEvent[]) => rows.map((r) => r.id);

describe('parseMoneyLogQuery', () => {
  it('drops a type that is not in the vocabulary rather than trusting it', () => {
    expect(q('mtype=order_created').type).toBe('order_created');
    expect(q('mtype=made_up').type).toBeUndefined();
  });

  it('ignores a malformed date bound instead of filtering by garbage', () => {
    expect(q('mfrom=2026-07-30').from).toBe('2026-07-30');
    // Garbage on BOTH bounds leaves none named, so the default window applies — it does not fall
    // back to reading the whole journal, which is the thing the default exists to prevent.
    expect(q('mfrom=yesterday&mto=2026-13')).toMatchObject({ from: '2026-07-02', to: TODAY, defaultWindow: true });
  });

  it('swaps an inverted range instead of answering "0 events"', () => {
    const parsed = q('mfrom=2026-07-31&mto=2026-07-01');
    expect([parsed.from, parsed.to]).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('trims the search term and the permalink id', () => {
    expect(q('mq=%20%20ord-1%20%20&mev=%20abc%20')).toMatchObject({ q: 'ord-1', eventId: 'abc' });
  });

  it('caps the search so a 16KB query string cannot amplify', () => {
    // Two caps, and the second is the one that costs now. Length first — a query string can carry
    // ~16KB. Then TERMS, because the search runs in the query: each one is a ten-armed `OR` bolted
    // into the WHERE, so 200 characters of `a b a b …` is 100 of them and Postgres spends its time
    // planning. Measured against the production build: 1.26s, where a real search takes ~70ms.
    const capped = q(`mq=${'a b '.repeat(5000)}`).q;
    expect(capped.split(/\s+/)).toHaveLength(12);
    expect(capped.length).toBeLessThanOrEqual(200);
  });

  it('leaves a search nobody would call excessive completely alone', () => {
    // The cap must be invisible to every real search — it exists for the pathological one only.
    expect(q('mq=ord-1111+keramika+cancelled').q).toBe('ord-1111 keramika cancelled');
  });
});

describe('filterMoneyEvents', () => {
  it('returns everything when nothing narrows it', () => {
    expect(ids(filterMoneyEvents(ALL, q('')))).toEqual(['c', 'b', 'a']);
  });

  it('searches order id, checkout ref, store, actor, detail and amount', () => {
    expect(ids(filterMoneyEvents(ALL, q('mq=ord-1111')))).toEqual(['a']);
    expect(ids(filterMoneyEvents(ALL, q('mq=CK-9090')))).toEqual(['c']);
    expect(ids(filterMoneyEvents(ALL, q('mq=kids-wear')))).toEqual(['b']);
    expect(ids(filterMoneyEvents(ALL, q('mq=seller-7')))).toEqual(['b']);
    expect(ids(filterMoneyEvents(ALL, q('mq=replayed')))).toEqual(['c']);
    expect(ids(filterMoneyEvents(ALL, q('mq=349.9')))).toEqual(['a']);
  });

  it('matches the Hebrew label the admin is reading on screen', () => {
    expect(ids(filterMoneyEvents(ALL, q(`mq=${encodeURIComponent('חיוב כפול')}`)))).toEqual(['c']);
  });

  it('matches an order id by the 8-char prefix the table displays', () => {
    expect(ids(filterMoneyEvents(ALL, q('mq=ord-3333')))).toEqual(['b']);
  });

  it('is case-insensitive', () => {
    expect(ids(filterMoneyEvents(ALL, q('mq=ck-9090')))).toEqual(['c']);
  });

  it('ANDs multiple search terms so a second word narrows', () => {
    expect(ids(filterMoneyEvents(ALL, q('mq=cancelled+kids-wear')))).toEqual(['b']);
    expect(ids(filterMoneyEvents(ALL, q('mq=cancelled+tools-shop')))).toEqual([]);
  });

  it('windows by BUSINESS day, not by the UTC timestamp', () => {
    // 23:30Z on the 28th belongs to the 29th here — the seller's chart counts it there.
    expect(ids(filterMoneyEvents(ALL, q('mfrom=2026-07-29&mto=2026-07-29')))).toEqual(['a']);
    expect(ids(filterMoneyEvents(ALL, q('mfrom=2026-07-28&mto=2026-07-28')))).toEqual([]);
  });

  it('accepts an open-ended window on either side', () => {
    expect(ids(filterMoneyEvents(ALL, q('mfrom=2026-07-30')))).toEqual(['c', 'b']);
    expect(ids(filterMoneyEvents(ALL, q('mto=2026-07-30')))).toEqual(['b', 'a']);
  });

  it('ANDs type, search and window together', () => {
    expect(ids(filterMoneyEvents(ALL, q('mtype=shipping_status_changed&mq=kids&mfrom=2026-07-30&mto=2026-07-30')))).toEqual(['b']);
    expect(ids(filterMoneyEvents(ALL, q('mtype=order_created&mq=kids')))).toEqual([]);
  });

  it('never mutates or reorders the journal it was given', () => {
    const before = [...ALL];
    filterMoneyEvents(ALL, q('mq=ord'));
    expect(ALL).toEqual(before);
  });
});

describe('eventPage', () => {
  const many = Array.from({ length: 40 }, (_, i) => ev({ id: `e${i}`, at: '2026-07-30T10:00:00.000Z' }));

  it('resolves a row to the page holding it', () => {
    expect(eventPage(many, 'e0', 15)).toBe(1);
    expect(eventPage(many, 'e14', 15)).toBe(1);
    expect(eventPage(many, 'e15', 15)).toBe(2);
    expect(eventPage(many, 'e39', 15)).toBe(3);
  });

  it('returns null for a row the current result set does not contain', () => {
    // The panel must say so rather than silently opening page 1 — a permalink that
    // lands on the wrong row is worse than one that admits it missed.
    expect(eventPage(many, 'nope', 15)).toBeNull();
    expect(eventPage(many, '', 15)).toBeNull();
  });
});

describe('hasActiveMoneyLogFilters', () => {
  it('distinguishes a narrowed journal from an empty one', () => {
    expect(hasActiveMoneyLogFilters(q(''))).toBe(false);
    expect(hasActiveMoneyLogFilters(q('mev=abc'))).toBe(false); // a permalink is not a filter
    expect(hasActiveMoneyLogFilters(q('mq=x'))).toBe(true);
    expect(hasActiveMoneyLogFilters(q('mtype=order_created'))).toBe(true);
    expect(hasActiveMoneyLogFilters(q('mto=2026-07-30'))).toBe(true);
  });
});

describe('the default window (owner decision, 2026-08-03: 30 days)', () => {
  // The journal is the one table nothing is ever deleted from, so "the admin opened the money log"
  // used to mean "read every event ever recorded" — the last unbounded read on the dashboard.
  it('opens on the last 30 days, inclusive of both ends', () => {
    const parsed = q('');
    expect(parsed).toMatchObject({ from: '2026-07-02', to: TODAY, defaultWindow: true });
    // 2026-07-02 … 2026-07-31 is 30 days counting both, not 31.
    const days = (Date.parse(`${parsed.to}T00:00:00Z`) - Date.parse(`${parsed.from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(MONEY_LOG_DEFAULT_DAYS);
  });

  it('does not apply when the admin named EITHER bound', () => {
    // One bound alone is a deliberate half-open range ("everything since the 1st"); widening it to
    // 30 days would answer a different question than the one asked.
    expect(q('mfrom=2026-01-01')).toMatchObject({ from: '2026-01-01', to: '', defaultWindow: false });
    expect(q('mto=2026-01-31')).toMatchObject({ from: '', to: '2026-01-31', defaultWindow: false });
  });

  it('is not something "clear filters" offers to remove', () => {
    // It always applies, so offering to clear it would either lie or hand back the unbounded read.
    expect(hasActiveMoneyLogFilters(q(''))).toBe(false);
    expect(hasActiveMoneyLogFilters(q('mtype=order_created'))).toBe(true);
    expect(hasActiveMoneyLogFilters(q('mq=abc'))).toBe(true);
    expect(hasActiveMoneyLogFilters(q('mfrom=2026-01-01'))).toBe(true);
  });

  it('actually narrows — an older event is outside it', () => {
    const old = ev({ id: 'old', at: '2026-01-15T10:00:00.000Z' });
    expect(ids(filterMoneyEvents([...ALL, old], q('')))).toEqual(['c', 'b', 'a']);
  });
});

describe('widenToEvent — a permalink older than the default window', () => {
  // Without this, every ?mev= link older than 30 days would answer "this row is not in the current
  // filter" — the exact failure `moneyLogTargetMissing` exists to report, arriving by default.
  it('reaches back to the linked row', () => {
    const widened = widenToEvent(q('mev=old'), '2026-01-15');
    expect(widened.from).toBe('2026-01-15');
    expect(widened.to).toBe(TODAY);
    const old = ev({ id: 'old', at: '2026-01-15T10:00:00.000Z' });
    expect(ids(filterMoneyEvents([...ALL, old], widened))).toContain('old');
    expect(eventPage(filterMoneyEvents([...ALL, old], widened), 'old')).toBe(1);
  });

  it('leaves a range the admin chose alone — theirs wins', () => {
    const chosen = q('mfrom=2026-07-01&mto=2026-07-31&mev=old');
    expect(widenToEvent(chosen, '2026-01-15')).toEqual(chosen);
  });

  it('changes nothing when the row is already inside the window, or does not exist', () => {
    expect(widenToEvent(q('mev=x'), '2026-07-20').from).toBe('2026-07-02');
    expect(widenToEvent(q('mev=x'), null).from).toBe('2026-07-02');
  });
});
