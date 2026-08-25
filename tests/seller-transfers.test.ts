/**
 * "How much is coming to me, and when" — the rules of the seller's transfer strip.
 *
 * Every case here is one the live sandbox actually produced on 2026-08-25 (the seven-row answer
 * with six zero windows and one open one), plus the shapes PayMe's own documentation says can come
 * back. The reason they are worth pinning is that this is a MONEY figure a seller reads and acts
 * on: a pending total that silently drops a row, or a date invented for money PayMe have not dated,
 * is wrong in a way no screen would show.
 */
import { describe, expect, it } from 'vitest';
import { summarizeTransfers, paymeDay } from '../src/lib/seller-transfers.js';
import type { PaymeWithdrawal } from '../src/lib/payment-payme.js';

const future = (over: Partial<PaymeWithdrawal>): PaymeWithdrawal =>
  ({ totalAgorot: 0, code: 'c', at: '2026-08-26 13:15:00', windowEnd: 1787739300, ...over });
const past = (over: Partial<PaymeWithdrawal>): PaymeWithdrawal =>
  ({ totalAgorot: 0, code: 'c', at: '2026-08-01 09:00:00', description: 'משיכה לבנק', ...over });

describe('paymeDay', () => {
  it('slices their timestamp rather than parsing it', () => {
    expect(paymeDay('2026-08-25 13:15:00')).toBe('2026-08-25');
  });

  /** The whole reason it is a slice: `new Date('2026-08-25 13:15:00').toISOString()` reads the
   *  string as LOCAL time, so in any zone east of UTC the day can move backwards. */
  it('never lets a timezone move the day', () => {
    expect(paymeDay('2026-01-01 00:30:00')).toBe('2026-01-01');
    expect(paymeDay('2026-01-01 23:45:00')).toBe('2026-01-01');
  });

  it('drops a shape that is not theirs, instead of producing Invalid Date on a screen', () => {
    expect(paymeDay('')).toBe('');
    expect(paymeDay('yesterday')).toBe('');
  });
});

describe('summarizeTransfers', () => {
  it('sums every future row into the pending total, open window included', () => {
    const out = summarizeTransfers([
      future({ totalAgorot: 0 }),
      future({ totalAgorot: 2500, at: '2026-08-27 13:15:00' }),
      future({ totalAgorot: 101348, windowEnd: -1, at: '2026-08-25 11:43:31' }),
    ], []);
    expect(out.pendingAgorot).toBe(103848);
  });

  /** The measured case: money accrues into an OPEN window, which by definition has no payment date.
   *  A screen must then say "at the processor's next date" rather than showing one. */
  it('offers no date when the only money sits in the open window', () => {
    const out = summarizeTransfers([future({ totalAgorot: 101348, windowEnd: -1 })], []);
    expect(out.pendingAgorot).toBe(101348);
    expect(out.next).toBeNull();
  });

  it('picks the EARLIEST dated window that actually carries money', () => {
    const out = summarizeTransfers([
      future({ totalAgorot: 0, at: '2026-08-26 13:15:00' }),        // dated, empty — not a transfer
      future({ totalAgorot: 7700, at: '2026-08-29 13:15:00' }),
      future({ totalAgorot: 4400, at: '2026-08-28 13:15:00' }),
    ], []);
    expect(out.next).toEqual({ dayISO: '2026-08-28', amountAgorot: 4400 });
  });

  it('counts a dated empty window in nothing and promises nothing for it', () => {
    const out = summarizeTransfers([future({ totalAgorot: 0 })], []);
    expect(out.pendingAgorot).toBe(0);
    expect(out.next).toBeNull();
  });

  it('keeps past transfers in the order PayMe returned them', () => {
    const out = summarizeTransfers([], [
      past({ totalAgorot: 51200, at: '2026-08-10 09:00:00' }),
      past({ totalAgorot: 33300, at: '2026-07-10 09:00:00' }),
    ]);
    expect(out.past.map((p) => p.dayISO)).toEqual(['2026-08-10', '2026-07-10']);
    expect(out.past[0]!.amountAgorot).toBe(51200);
    expect(out.past[0]!.description).toBe('משיכה לבנק');
  });

  it('drops a past row whose date it cannot read rather than rendering it undated', () => {
    const out = summarizeTransfers([], [past({ at: '', totalAgorot: 999 })]);
    expect(out.past).toEqual([]);
  });

  it('is empty and not undefined when PayMe return nothing at all', () => {
    expect(summarizeTransfers([], [])).toEqual({ pendingAgorot: 0, next: null, past: [] });
  });
});
