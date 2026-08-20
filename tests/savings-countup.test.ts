import { describe, it, expect } from 'vitest';
import { countUpValue } from '../src/lib/savings-celebration.js';

// The checkout's savings figure animates from 0 up to the real number. That is a MONEY figure on
// screen, so the animation is only allowed to be a slower way of arriving at the same value —
// never a different one, and never a value with a precision the real one does not have.
const TARGETS = [0, 1, 5, 80, 99.9, 123.45, 1200, 0.05, 7.5];
const STEPS = Array.from({ length: 41 }, (_, i) => i / 40);

describe('savings count-up', () => {
  it('lands exactly on the target — never a rounded lookalike', () => {
    for (const target of TARGETS) {
      expect(countUpValue(target, 1)).toBe(target);
      // Past the end too: a late frame after the clock has run out must not drift off it.
      expect(countUpValue(target, 1.4)).toBe(target);
    }
  });

  it('never shows more than the shopper actually saved', () => {
    for (const target of TARGETS) {
      for (const t of STEPS) expect(countUpValue(target, t)).toBeLessThanOrEqual(target);
    }
  });

  it('never invents agorot on a whole-shekel figure', () => {
    for (const target of [1, 5, 80, 1200]) {
      for (const t of STEPS) expect(Number.isInteger(countUpValue(target, t))).toBe(true);
    }
  });

  it('keeps agorot on a figure that has them, and never more than two places', () => {
    // Through roundMoney (lib/money.ts), so this is also the assertion that the count-up did not
    // hand-roll its own rounding: `Math.round(9.03 * 100) / 100` is 9.029999999999999, which
    // would fail here on the exact value a shopper reads.
    for (const t of STEPS) {
      const v = countUpValue(123.45, t);
      expect(v).toBe(Number(v.toFixed(2)));
    }
  });

  it('only ever moves toward the target', () => {
    for (const target of TARGETS) {
      let prev = -Infinity;
      for (const t of STEPS) {
        const v = countUpValue(target, t);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('starts at zero and is well behaved before the clock does', () => {
    expect(countUpValue(80, 0)).toBe(0);
    expect(countUpValue(80, -0.5)).toBe(0);
  });
});
