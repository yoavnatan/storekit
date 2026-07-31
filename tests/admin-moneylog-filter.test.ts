import { describe, expect, it } from 'vitest';
import {
  parseMoneyLogQuery,
  filterMoneyEvents,
  eventPage,
  hasActiveMoneyLogFilters,
} from '../src/lib/admin-moneylog-filter.js';
import type { MoneyEvent } from '../src/lib/money-events.js';

/**
 * The money journal's search / date-window / row-permalink (owner, סשן ג׳). Every rule
 * here is one the UI cannot state for itself: what a search term is allowed to match,
 * which calendar a date bound means, and which page a permalink resolves to.
 */

const q = (search: string) => parseMoneyLogQuery(new URLSearchParams(search));

function ev(over: Partial<MoneyEvent> & { id: string; at: string }): MoneyEvent {
  return { type: 'order_created', actor: 'system', ...over };
}

// 2026-07-28T23:30Z is 02:30 on the 29th in Asia/Jerusalem — the row whose business
// day differs from its UTC day, which is the whole reason business-day.ts exists.
const LATE_NIGHT = ev({ id: 'a', at: '2026-07-28T23:30:00.000Z', orderId: 'ord-11112222', amount: 349.9, storeSlug: 'tools-shop' });
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
    expect(q('mfrom=yesterday&mto=2026-13').from).toBe('');
    expect(q('mfrom=yesterday&mto=2026-13').to).toBe('');
  });

  it('swaps an inverted range instead of answering "0 events"', () => {
    const parsed = q('mfrom=2026-07-31&mto=2026-07-01');
    expect([parsed.from, parsed.to]).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('trims the search term and the permalink id', () => {
    expect(q('mq=%20%20ord-1%20%20&mev=%20abc%20')).toMatchObject({ q: 'ord-1', eventId: 'abc' });
  });

  it('caps the search term so a 16KB query string cannot amplify into terms × rows', () => {
    // Every term is tested against every row on a single-threaded SSR server, so an
    // uncapped `a a a a …` query is a stall, not a search.
    expect(q(`mq=${'a b '.repeat(5000)}`).q.length).toBe(200);
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
