import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  RETURN_RATE_MIN_ORDERS, RETURN_RATE_MULTIPLE,
  DISPUTE_MIN_RETURNS, DISPUTE_RATE_THRESHOLD,
} from '../src/lib/return-rate.js';

/**
 * The return-rate signal is the only quality judgement this platform makes about a shop, and the
 * owner's decision was that it judges NOTHING automatically: "התראה לאדמין בלבד. בלי אזהרה אוטומטית
 * ובלי חסימה". These tests pin that restraint, because it is the kind of thing a later session
 * "improves" into an automatic warning.
 */
describe('the return-rate signal stays a signal', () => {
  it('needs a floor of orders before a rate means anything', () => {
    // One return out of two orders is 50% and says nothing. Without a floor the shop most likely to
    // be flagged is a brand-new one having an unlucky week — the one least able to argue with it.
    expect(RETURN_RATE_MIN_ORDERS).toBeGreaterThanOrEqual(10);
  });

  it('measures against the platform rather than a fixed percentage', () => {
    // A hardcoded "20%" is wrong for a swimwear shop the day it is written and drifts as the
    // catalogue's mix changes. A multiple of the platform's own rate stays true.
    expect(RETURN_RATE_MULTIPLE).toBeGreaterThan(1);
    const src = fs.readFileSync('src/lib/return-rate.ts', 'utf8');
    expect(src).toMatch(/platformRate \* RETURN_RATE_MULTIPLE/);
  });

  it('notifies nobody and blocks nothing', () => {
    // The whole decision, as a scan: this module reports and does not act. A future edit that mails
    // a seller or flips a flag has to delete this test first, which is the point of it.
    const src = fs.readFileSync('src/lib/return-rate.ts', 'utf8');
    for (const forbidden of ['createNotification', 'sendEmail', 'alertOnCriticalError', 'UPDATE ', 'blocked']) {
      expect(src, `return-rate.ts must not ${forbidden.trim()} — it reports, it does not act`)
        .not.toContain(forbidden);
    }
  });

  it('needs enough returns before "contested most of them" means anything', () => {
    // A shop with two returns that disputed both is at 100% and is telling us nothing. The floor is
    // what stops the signal firing on a shop's first bad week — the shop least able to argue with it.
    expect(DISPUTE_MIN_RETURNS).toBeGreaterThanOrEqual(3);
  });

  it('uses a flat dispute threshold, not a multiple of the platform', () => {
    // "Contested most of them" is the claim being made, and it is the same claim whatever every other
    // shop does — unlike a return rate, where the category is the whole context.
    expect(DISPUTE_RATE_THRESHOLD).toBeGreaterThan(0);
    expect(DISPUTE_RATE_THRESHOLD).toBeLessThanOrEqual(1);
    const src = fs.readFileSync('src/lib/return-rate.ts', 'utf8');
    expect(src).toMatch(/disputeRate >= DISPUTE_RATE_THRESHOLD/);
  });

  it('measures disputes against this shop\'s own RETURNS, not its orders', () => {
    // The question is "when goods come back, how often does this shop say something was wrong with
    // them". Dividing by orders would make a shop with few returns look clean for contesting all.
    const src = fs.readFileSync('src/lib/return-rate.ts', 'utf8');
    expect(src).toMatch(/disputes \/ returns/);
  });

  it('counts REQUESTS, not refunds', () => {
    // A refused or lapsed request still says the buyer wanted the product gone. Counting refunds
    // would measure how generous each seller is, which is a different question and not one the
    // platform should be scoring anybody on.
    const src = fs.readFileSync('src/lib/return-rate.ts', 'utf8');
    expect(src).toMatch(/COUNT\(DISTINCT rr\.id\)/);
    expect(src).not.toMatch(/rr\.status\s*=\s*'refunded'/);
  });
});
