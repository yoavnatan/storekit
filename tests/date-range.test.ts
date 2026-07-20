import { describe, it, expect } from 'vitest';
import { presetRange, daysInRangeInclusive, previousPeriod, coerceRange, toISODate } from '../src/lib/date-range.js';

const D = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y!, m! - 1, d!); };

describe('date-range', () => {
  it('presetRange resolves each preset against a fixed "today"', () => {
    const today = D('2026-07-20');
    expect(presetRange('today', today)).toEqual({ from: '2026-07-20', to: '2026-07-20' });
    expect(presetRange('7d', today)).toEqual({ from: '2026-07-14', to: '2026-07-20' });   // inclusive 7 days
    expect(presetRange('30d', today)).toEqual({ from: '2026-06-21', to: '2026-07-20' });
    expect(presetRange('thisMonth', today)).toEqual({ from: '2026-07-01', to: '2026-07-20' });
    expect(presetRange('custom', today)).toBeNull();
  });

  it('daysInRangeInclusive counts both endpoints', () => {
    expect(daysInRangeInclusive('2026-07-01', '2026-07-07')).toBe(7);
    expect(daysInRangeInclusive('2026-07-01', '2026-07-01')).toBe(1);
  });

  it('previousPeriod returns the equal-length window immediately before', () => {
    expect(previousPeriod('2026-07-08', '2026-07-14')).toEqual({ from: '2026-07-01', to: '2026-07-07' });
  });

  it('coerceRange validates, swaps reversed, falls back, and caps length', () => {
    const today = D('2026-07-20');
    expect(coerceRange('2026-07-01', '2026-07-07', today)).toEqual({ from: '2026-07-01', to: '2026-07-07' });
    expect(coerceRange('2026-07-07', '2026-07-01', today)).toEqual({ from: '2026-07-01', to: '2026-07-07' }); // swapped
    expect(coerceRange('', 'x', today)).toEqual(presetRange('7d', today)); // fallback
    expect(coerceRange('garbage', '2026-07-07', today)).toEqual(presetRange('7d', today));
    // >366 days gets capped to 365 back from `to`.
    const capped = coerceRange('2020-01-01', '2026-07-20', today);
    expect(daysInRangeInclusive(capped.from, capped.to)).toBeLessThanOrEqual(366);
  });

  it('toISODate uses local calendar (no UTC off-by-one)', () => {
    expect(toISODate(D('2026-01-01'))).toBe('2026-01-01');
  });
});
