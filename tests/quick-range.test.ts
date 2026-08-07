/**
 * The toolbar range presets (`date-range.ts#quickRange`) and the Alerts tab's day filter.
 *
 * The property worth pinning is not "today returns today" — it is that every bound comes off ONE
 * business-day string. The seller performance picker shipped the other shape first (a fresh `Date`
 * per bound, read from the runtime's local calendar), and on a production server, whose clock is
 * UTC, "this month" then began on a different day than the one the rows were bucketed by. These
 * tests fix the clock at the two moments where UTC and Israel disagree about the date, because
 * that is the only time the bug is visible.
 */
import { describe, it, expect } from 'vitest';
import { quickRange, QUICK_RANGE_PRESETS } from '../src/lib/date-range.js';
import { filterAndSortErrors, type ErrorLogEntry } from '../src/lib/error-log.js';

// 2026-08-07 is a Friday. 21:30 UTC is already 2026-08-08 00:30 in Israel (UTC+3), so the
// business day is the 8th while the ISO string still says the 7th — the exact disagreement.
const LATE_EVENING = new Date('2026-08-07T21:30:00Z');
const MIDDAY = new Date('2026-08-07T09:00:00Z');

describe('quickRange', () => {
  it('takes "today" from the BUSINESS day, not from the UTC date', () => {
    expect(quickRange('today', MIDDAY)).toEqual({ from: '2026-08-07', to: '2026-08-07' });
    // Israel has already rolled over. An admin asking for "today" at 00:30 means the 8th.
    expect(quickRange('today', LATE_EVENING)).toEqual({ from: '2026-08-08', to: '2026-08-08' });
  });

  it('starts the week on Sunday', () => {
    // 2026-08-07 is a Friday → back 5 days to Sunday the 2nd.
    expect(quickRange('thisWeek', MIDDAY)).toEqual({ from: '2026-08-02', to: '2026-08-07' });
    // Saturday the 8th is the LAST day of that week, not the first — a Monday-start week would
    // wrongly hand back the 3rd..8th here.
    expect(quickRange('thisWeek', LATE_EVENING)).toEqual({ from: '2026-08-02', to: '2026-08-08' });
  });

  it('starts the month on the 1st and the 30-day window 29 days back, both inclusive', () => {
    expect(quickRange('thisMonth', MIDDAY)).toEqual({ from: '2026-08-01', to: '2026-08-07' });
    // Inclusive of both ends: 29 back from the 7th is 30 days counting both.
    expect(quickRange('30d', MIDDAY)).toEqual({ from: '2026-07-09', to: '2026-08-07' });
  });

  it('every advertised preset resolves — a chip that does nothing is worse than no chip', () => {
    for (const p of QUICK_RANGE_PRESETS) {
      const r = quickRange(p.id, MIDDAY);
      expect(r.from <= r.to, `${p.id} produced a reversed range`).toBe(true);
    }
  });
});

const entry = (createdAt: string): ErrorLogEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  source: 'server', message: 'x', resolved: false, createdAt,
} as ErrorLogEntry);

const base = { sortDir: 'desc' as const, source: [], storeSlug: [], severity: [] };

describe('the Alerts tab day filter', () => {
  it('files a late-evening failure under the ISRAELI day, which is the day the admin asks for', () => {
    // Logged 2026-08-07T21:30Z — the 8th in Israel. Slicing the ISO string would file it under the
    // 7th, so "what broke today (the 8th)" would come back empty while the mail about it sits in
    // the admin's inbox.
    const e = entry('2026-08-07T21:30:00.000Z');
    expect(filterAndSortErrors([e], { ...base, from: '2026-08-08', to: '2026-08-08' })).toHaveLength(1);
    expect(filterAndSortErrors([e], { ...base, from: '2026-08-07', to: '2026-08-07' })).toHaveLength(0);
  });

  it('accepts a half-open window, and both bounds are inclusive', () => {
    const entries = ['2026-08-05', '2026-08-06', '2026-08-07'].map((d) => entry(`${d}T09:00:00.000Z`));
    expect(filterAndSortErrors(entries, { ...base, from: '2026-08-06' })).toHaveLength(2);
    expect(filterAndSortErrors(entries, { ...base, to: '2026-08-06' })).toHaveLength(2);
    expect(filterAndSortErrors(entries, { ...base, from: '2026-08-06', to: '2026-08-06' })).toHaveLength(1);
  });

  it('treats a malformed bound as NO bound rather than as one nothing matches', () => {
    // A picker typo emptying the whole tab reads as "no errors", which is the one wrong answer a
    // triage screen must never give. 2026-02-30 is day-SHAPED and is not a day.
    const entries = ['2026-08-05', '2026-08-07'].map((d) => entry(`${d}T09:00:00.000Z`));
    expect(filterAndSortErrors(entries, { ...base, from: '2026-02-30' })).toHaveLength(2);
    expect(filterAndSortErrors(entries, { ...base, from: 'yesterday' })).toHaveLength(2);
  });

  it('leaves the list alone when no window is asked for — this tab has no default one', () => {
    const entries = ['2020-01-01', '2026-08-07'].map((d) => entry(`${d}T09:00:00.000Z`));
    expect(filterAndSortErrors(entries, base)).toHaveLength(2);
  });
});
