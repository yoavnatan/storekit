import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { RETURN_RATE_MIN_ORDERS, RETURN_RATE_MULTIPLE } from '../src/lib/return-rate.js';

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

  it('counts REQUESTS, not refunds', () => {
    // A refused or lapsed request still says the buyer wanted the product gone. Counting refunds
    // would measure how generous each seller is, which is a different question and not one the
    // platform should be scoring anybody on.
    const src = fs.readFileSync('src/lib/return-rate.ts', 'utf8');
    expect(src).toMatch(/COUNT\(DISTINCT rr\.id\)/);
    expect(src).not.toMatch(/rr\.status\s*=\s*'refunded'/);
  });
});
