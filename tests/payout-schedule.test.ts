/**
 * The four payout-policy numbers, and the two things that are NOT anybody's decision.
 *
 * ── Why this file exists at all (written 2026-08-11) ──
 * `payout-schedule.ts`'s header has said "`tests/payout-schedule.test.ts` pins that floor" since it
 * was written, and the file did not exist. That is worse than an untested rule: it is an untested
 * rule that everyone reading the module believes is tested, which is exactly the state a session
 * lowers a number in without checking. Found while making the 21-day hold explain itself to the
 * seller (owner: *"למה 21 מרגע המסירה ולא 15 למשל?"*).
 *
 * These are PLACEHOLDERS awaiting the owner's returns-policy decision, so this file deliberately
 * does not pin their values — a test asserting `HOLD_DAYS_AFTER_DELIVERY === 21` would fail the day
 * he decides, which teaches the next session to edit the test rather than think. It pins the
 * RELATIONSHIPS that any choice has to satisfy, each of which has a concrete failure behind it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STATUTORY_RETURN_DAYS,
  HOLD_DAYS_AFTER_DELIVERY,
  FALLBACK_DAYS_AFTER_PAYMENT,
  SHIP_DEADLINE_BUSINESS_DAYS,
  SHIP_WARNING_DAYS,
  SHIP_AUTO_CANCEL_DAYS,
  PAYOUT_WEEKDAY,
  MIN_PAYOUT_AGOROT,
  payoutWeekdayName,
} from '../src/lib/payout-schedule.js';

describe('the hold may never open inside the buyer\'s statutory window', () => {
  /**
   * The one number on that page that is law rather than policy: חוק הגנת הצרכן §14ג gives a
   * distance-sale buyer 14 days from RECEIVING the goods to cancel.
   *
   * The failure is not abstract. Pay a seller on day 14 and a buyer who cancels on day 14 leaves the
   * platform holding a refund it has already given away — money to chase from a seller rather than
   * money we are holding. `refund-owed.ts` would correctly record the debt, and it would be a debt.
   */
  it('the delivered-order hold clears the statutory window, with room to spare', () => {
    expect(STATUTORY_RETURN_DAYS).toBe(14);
    // STRICTLY greater, and the strictness is the test. `orderHold` releases INCLUSIVELY — a hold of
    // N frees the money ON delivery-day + N — so a hold equal to the window pays the seller out on
    // the last morning the buyer may still cancel. That is why the 2026-08-16 cut landed on 15 and
    // not the 14 it was asked for; anyone shortening it again meets this line first.
    expect(
      HOLD_DAYS_AFTER_DELIVERY,
      'a hold at or below the statutory window releases money the buyer can still cancel',
    ).toBeGreaterThan(STATUTORY_RETURN_DAYS);
  });

  /**
   * The fallback must stay ABOVE the hold, and the reason is an incentive rather than an arithmetic
   * one — `payout-schedule.ts` records the correction that produced it. With a hold H and a fallback
   * F, reporting delivery pays sooner only while delivery happens within F − H days; set F ≤ H and a
   * seller is paid FASTER for never touching the status dropdown, which is the exact behaviour the
   * fallback exists to remove.
   */
  it('the no-delivery fallback stays slower than reporting delivery', () => {
    expect(FALLBACK_DAYS_AFTER_PAYMENT).toBeGreaterThan(HOLD_DAYS_AFTER_DELIVERY);
  });

  /** The fulfilment clock runs inside the cancellation clock: an order auto-cancelled for non-supply
   *  must be cancelled while there is still something to cancel, and warned about before that. */
  it('the fulfilment deadlines run in the order a seller experiences them', () => {
    expect(SHIP_DEADLINE_BUSINESS_DAYS).toBeGreaterThan(0);
    expect(SHIP_WARNING_DAYS).toBeGreaterThan(SHIP_DEADLINE_BUSINESS_DAYS);
    expect(SHIP_AUTO_CANCEL_DAYS).toBeGreaterThan(SHIP_WARNING_DAYS);
  });

  it('the payout weekday is one a week actually has', () => {
    // Indexed the way `Date#getUTCDay` numbers it, because `payout-run.ts#weekdayOf` compares
    // against exactly that. A 7 here would simply never match and the run would never fire —
    // silently, since "not the payout day" is its normal answer on six days out of seven.
    expect(Number.isInteger(PAYOUT_WEEKDAY)).toBe(true);
    expect(PAYOUT_WEEKDAY).toBeGreaterThanOrEqual(0);
    expect(PAYOUT_WEEKDAY).toBeLessThanOrEqual(6);
  });

  /**
   * The seller-facing copy names the payout day in words, and those words are generated from
   * `PAYOUT_WEEKDAY` rather than typed into two translation files. This is the same defect the
   * module header describes for the numeric periods, wearing a weekday: change the constant, forget
   * a dictionary, and the terms of use promise a different day from the one the scheduler fires on.
   */
  it('the weekday word is derived from the constant, in both languages', () => {
    expect(payoutWeekdayName('he')).toBe('יום ראשון');
    expect(payoutWeekdayName('en')).toBe('Sunday');
  });

  it('the minimum payout is a whole number of agorot and not zero', () => {
    // Zero would mean sending a 3-agora transfer that costs more than it moves; a fraction would be
    // an amount no bank file can carry.
    expect(Number.isInteger(MIN_PAYOUT_AGOROT)).toBe(true);
    expect(MIN_PAYOUT_AGOROT).toBeGreaterThan(0);
  });
});

/**
 * The terms page states these periods to a person who can hold us to them, so it must INTERPOLATE
 * the constants rather than restate them. A clause promising 21 days beside code that waits 30 is
 * the version the seller can point at being the wrong one.
 */
describe('the terms page quotes the constants instead of repeating them', () => {
  const terms = readFileSync('src/pages/terms.astro', 'utf8');

  it('imports the periods from payout-schedule.ts', () => {
    expect(terms).toMatch(/from\s+['"][^'"]*payout-schedule(\.js)?['"]/);
  });

  /**
   * The payout DAY is now a word rather than a digit, and a word is the easier one to leave behind:
   * a clause reading "בכל יום ראשון" survives a change to `PAYOUT_WEEKDAY` looking perfectly
   * correct, while a stale digit at least looks like a number somebody should check. So the clause
   * must call the generator, and must not spell any weekday out.
   */
  it('names the payout day through payoutWeekdayName, never as a written weekday', () => {
    expect(terms, 'terms.astro must interpolate payoutWeekdayName').toContain('payoutWeekdayName(');
    for (const day of ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת']) {
      expect(terms, `terms.astro writes "${day}" as a literal — interpolate the weekday instead`)
        .not.toContain(`בכל ${day}`);
    }
  });

  it.each([
    ['HOLD_DAYS_AFTER_DELIVERY', HOLD_DAYS_AFTER_DELIVERY],
    ['FALLBACK_DAYS_AFTER_PAYMENT', FALLBACK_DAYS_AFTER_PAYMENT],
  ])('states %s by name, never as a bare digit', (name, value) => {
    expect(terms, `terms.astro must interpolate ${name}`).toContain(name);
    // The digit may legitimately appear inside an interpolated expression elsewhere; what must not
    // appear is the number followed by the Hebrew word for days, which is the clause restating it.
    expect(
      terms,
      `terms.astro writes "${value} ימים" as a literal — interpolate ${name} instead`,
    ).not.toMatch(new RegExp(`(?<![\\d{$])${value}\\s+ימים`));
  });
});
