import { describe, expect, it } from 'vitest';
import { isMoneyEventType, selectMoneyEvents, MONEY_EVENT_TYPES, MONEY_EVENT_LABELS, type MoneyEvent } from '../src/lib/money-events.js';
import { MONEY_EVENT_GROUPS } from '../src/lib/money-event-types.js';

// The admin money journal's type filter was validated against the rows it had just
// loaded (`events.some(e => e.type === requested)`), so filtering to a type the
// journal had no rows for fell back to "no filter" and rendered the ENTIRE log —
// a filter that answers a different question instead of answering "none" (owner,
// סשן ד׳). Both halves of the fix are here: the vocabulary check, and narrowing
// before the cap rather than after it.

function ev(type: MoneyEvent['type'], at: string): MoneyEvent {
  return { id: at, at, type, actor: 'system' };
}

describe('isMoneyEventType', () => {
  it('accepts every type in the vocabulary', () => {
    for (const t of MONEY_EVENT_TYPES) expect(isMoneyEventType(t)).toBe(true);
  });

  it('rejects an empty string, an unknown value and a near-miss', () => {
    expect(isMoneyEventType('')).toBe(false);
    expect(isMoneyEventType('order_deleted')).toBe(false);
    expect(isMoneyEventType('order_created ')).toBe(false);
  });

  it('accepts a type the journal contains no rows for — the filter must come back empty, not unfiltered', () => {
    expect(isMoneyEventType('duplicate_checkout_blocked')).toBe(true);
    expect(selectMoneyEvents([ev('order_created', '2026-07-30T10:00:00Z')], 'duplicate_checkout_blocked')).toEqual([]);
  });
});

// The admin's type filter is a MENU rendered from MONEY_EVENT_GROUPS (סשן ב׳ — thirteen chips had
// stopped saying what the journal was for). A menu built from sections can lose a value in a way a
// list built from the vocabulary cannot: add a type, forget the section, and it silently becomes
// unfilterable while `?mtype=` still accepts it. That is the whole failure this guards.
describe('MONEY_EVENT_GROUPS covers the vocabulary exactly', () => {
  const grouped = MONEY_EVENT_GROUPS.flatMap((g) => g.types);

  it('places every type in a section', () => {
    expect([...grouped].sort()).toEqual([...MONEY_EVENT_TYPES].sort());
  });

  it('places no type in two sections', () => {
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('names every section, and every type it lists has a label to render', () => {
    for (const g of MONEY_EVENT_GROUPS) {
      expect(g.label.trim()).not.toBe('');
      expect(g.types.length).toBeGreaterThan(0);
      for (const t of g.types) expect(MONEY_EVENT_LABELS[t]).toBeTruthy();
    }
  });
});

describe('selectMoneyEvents', () => {
  const rows: MoneyEvent[] = [
    ev('order_created', '2026-07-28T09:00:00Z'),
    ev('shipping_status_changed', '2026-07-29T09:00:00Z'),
    ev('shipping_status_changed', '2026-07-30T09:00:00Z'),
    ev('order_created', '2026-07-27T09:00:00Z'),
  ];

  it('returns newest first', () => {
    expect(selectMoneyEvents(rows).map((e) => e.at)).toEqual([
      '2026-07-30T09:00:00Z', '2026-07-29T09:00:00Z', '2026-07-28T09:00:00Z', '2026-07-27T09:00:00Z',
    ]);
  });

  it('returns the whole journal, uncapped — the admin panel paginates it', () => {
    expect(selectMoneyEvents(rows)).toHaveLength(rows.length);
  });

  it('returns every row of the requested type, including ones older than newer rows of other types', () => {
    // The two newest rows are both shipping events. The old panel took the newest N
    // and narrowed those, so matches sitting behind them simply vanished.
    expect(selectMoneyEvents(rows, 'order_created').map((e) => e.at)).toEqual([
      '2026-07-28T09:00:00Z', '2026-07-27T09:00:00Z',
    ]);
  });

  it('does not mutate the caller’s array', () => {
    const input = [...rows];
    selectMoneyEvents(input);
    expect(input.map((e) => e.at)).toEqual(rows.map((e) => e.at));
  });
});
