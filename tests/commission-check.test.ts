/**
 * Our commission against PayMe's — the comparison nothing was making (area audit, row 13).
 *
 * The failure this guards is quiet by construction: our number goes on the seller's dashboard and
 * into the platform's revenue, theirs is deducted from the actual sale, and until 2026-08-23 their
 * figure came back on every capture and was thrown away. A rate that drifted at their end would
 * have shown up as a seller comparing his own statement with ours and asking why.
 *
 * Two failure directions, and both matter:
 *  · reporting a rounding difference as a mismatch — every sale logs an alert and the log becomes
 *    noise nobody reads, which is the same as having no alert;
 *  · missing a small systematic drift because the tolerance was set in percent.
 */
import { describe, it, expect } from 'vitest';
import { commissionMismatch, commissionMismatchDetail, COMMISSION_ROUNDING_TOLERANCE_AGOROT } from '../src/lib/commission-check.js';
import { commissionOnAgorot } from '../src/lib/pricing.js';

describe('when the two figures agree', () => {
  it('says nothing at all', () => {
    // ₪100 at the starter tier's 12%.
    const expected = commissionOnAgorot(10000, 12);
    expect(commissionMismatch(expected, expected)).toBeNull();
  });

  // Both sides round a percentage of an integer to whole agorot and neither publishes which way, so
  // one agora apart is two correct answers — not a finding. An alert on every sale is an alert
  // nobody reads.
  it('absorbs a one-agora rounding difference in either direction', () => {
    expect(commissionMismatch(1234, 1235)).toBeNull();
    expect(commissionMismatch(1234, 1233)).toBeNull();
    expect(COMMISSION_ROUNDING_TOLERANCE_AGOROT).toBe(1);
  });

  // Their response is not guaranteed to carry the figure. "They said nothing" must never become
  // "they took the wrong amount" — that is a finding about our own reading, filed as one about money.
  it('treats an absent figure as no answer rather than as a mismatch', () => {
    expect(commissionMismatch(1234, undefined)).toBeNull();
    expect(commissionMismatch(1234, NaN)).toBeNull();
  });
});

describe('when they do not', () => {
  it('reports the difference with both numbers and its direction', () => {
    // 12% of ₪100 is ₪12; they took ₪14 — a rate of 14% at their end, which is the exact shape of
    // the drift this exists to catch.
    const m = commissionMismatch(commissionOnAgorot(10000, 12), 1400);
    expect(m).toEqual({ expectedAgorot: 1200, actualAgorot: 1400, deltaAgorot: 200 });
  });

  it('reports it when they took LESS, too — a fee is wrong in both directions', () => {
    expect(commissionMismatch(1200, 1000)?.deltaAgorot).toBe(-200);
  });

  // The tolerance is an ABSOLUTE agora and not a percentage of the sale, on purpose: a percentage
  // threshold would hide a small systematic drift on small sales, which is exactly what a wrong
  // default rate at their end looks like on a catalogue of ₪30 items.
  it('catches a two-agora difference on a tiny sale, which a percent threshold would hide', () => {
    const m = commissionMismatch(commissionOnAgorot(500, 12), 63);
    expect(m?.deltaAgorot).toBe(3);
  });
});

describe('the journal line', () => {
  it('prints shekels, never raw agorot, and names both figures and the reference', () => {
    const line = commissionMismatchDetail(
      { expectedAgorot: 1200, actualAgorot: 1400, deltaAgorot: 200 },
      'my-shop', 'SALE1',
    );
    // ₪12 and ₪14 — not "1200" and "1400", which beside a shekel sign read as ₪1,200.
    expect(line).toContain('12');
    expect(line).toContain('14');
    expect(line).not.toContain('1200');
    expect(line).toContain('my-shop');
    expect(line).toContain('SALE1');
    // Whoever reads it months later has to know which way it went without doing the subtraction.
    expect(line).toContain('יותר');
  });
});
