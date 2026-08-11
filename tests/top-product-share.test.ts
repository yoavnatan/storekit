import { describe, expect, it } from 'vitest';
import { productShare } from '../src/lib/top-product-share.js';

/**
 * The percentage on the leading-products list — the number the owner asked about directly
 * (CURRENT_TASK.md → סשן ג׳: "ומה זה האחוז שמופיע שם?"). The invariants that make it MEAN
 * something across a real period live in reporting-invariants.test.ts; these are the edges, which
 * are the ones that print something visibly wrong rather than something merely misleading.
 */
describe('productShare', () => {
  it('is a share of the total it is given, not of the row', () => {
    expect(productShare(2500, 10000)).toEqual({ pct: 25, label: '25%' });
    expect(productShare(10000, 10000)).toEqual({ pct: 100, label: '100%' });
  });

  it('says <1% rather than 0% for a real but tiny share', () => {
    // A row printing "0%" beside a four-figure revenue reads as a broken number, which is the
    // opposite of what a leaderboard is for.
    expect(productShare(1, 1_000_000)).toEqual({ pct: 0, label: '<1%' });
    expect(productShare(400, 100_000)).toEqual({ pct: 0, label: '<1%' });
    // Not below 1% any more — this one rounds up to a whole percent and says so.
    expect(productShare(600, 100_000).label).toBe('1%');
  });

  it('states nothing rather than dividing by nothing', () => {
    expect(productShare(0, 0)).toEqual({ pct: 0, label: '0%' });
    expect(productShare(5000, 0)).toEqual({ pct: 0, label: '0%' });
  });

  it('never returns NaN, which is the zero-downtime deploy case', () => {
    // For a few seconds during a rollout a new client can read an old API response, which carries
    // no `productRevenueAgorot`. Untreated that renders `width:NaN%` and prints "NaN%".
    for (const bad of [undefined, null, Number.NaN, Infinity]) {
      const s = productShare(1000, bad as unknown as number);
      expect(Number.isFinite(s.pct), `total=${String(bad)}`).toBe(true);
      expect(s.label, `total=${String(bad)}`).not.toContain('NaN');
    }
    const s = productShare(Number.NaN, 10000);
    expect(Number.isFinite(s.pct)).toBe(true);
    expect(s.label).not.toContain('NaN');
  });

  it('a negative row cannot draw a bar backwards', () => {
    // Refund handling can in principle drive a line negative; a bar with a negative width is a
    // rendering artefact, and the fuzz suite already forbids a negative reported figure.
    expect(productShare(-500, 10000)).toEqual({ pct: 0, label: '0%' });
  });
});
