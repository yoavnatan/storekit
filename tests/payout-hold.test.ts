/**
 * When a seller's money stops being at risk — every case, and the proof that the SQL twin agrees.
 *
 * This is the rule the whole agent model turns on. Get it wrong in one direction and the platform
 * pays a seller for goods the buyer is still entitled to send back, then has to chase the money;
 * get it wrong in the other and a seller's balance sits frozen with no explanation. And it is
 * written TWICE — once in JS for the seller's screen, once in SQL for the payout run, which
 * aggregates across every seller and cannot pull the orders into memory. `payout-hold.ts` explains
 * why that duplication is allowed; this file is the reason it is safe.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query, rows } from '../src/lib/db.js';
import { orderHold, isReleasable, RELEASABLE_SQL, releasableParams } from '../src/lib/payout-hold.js';
import { HOLD_DAYS_AFTER_DELIVERY, FALLBACK_DAYS_AFTER_PAYMENT } from '../src/lib/payout-schedule.js';
import { addDaysISO } from '../src/lib/date-range.js';

const TODAY = '2026-08-10';
/** Midday, so the instant is unambiguously on that business day in Asia/Jerusalem regardless of DST
 *  — a midnight timestamp is exactly the input that makes a UTC-vs-business-day bug invisible. */
const at = (dayISO: string) => `${dayISO}T12:00:00.000Z`;
const daysAgo = (n: number) => addDaysISO(TODAY, -n);

interface Case {
  note: string;
  paymentStatus: 'pending' | 'paid' | 'failed';
  shippingStatus: 'pending' | 'processing' | 'ready' | 'shipped' | 'delivered' | 'cancelled';
  paidAt: string | null;
  deliveredAt: string | null;
  expect: 'not_payable' | 'held' | 'releasable';
}

const CASES: Case[] = [
  // ── Nothing to pay out ──
  { note: 'never captured', paymentStatus: 'pending', shippingStatus: 'processing', paidAt: null, deliveredAt: null, expect: 'not_payable' },
  { note: 'capture failed', paymentStatus: 'failed', shippingStatus: 'cancelled', paidAt: null, deliveredAt: null, expect: 'not_payable' },
  // The one that matters most: paid AND cancelled. `paymentStatus === 'paid'` alone matches this
  // row, which is exactly the mistake AI_INSTRUCTIONS names — it must never become payable.
  { note: 'paid then cancelled, long past any hold', paymentStatus: 'paid', shippingStatus: 'cancelled', paidAt: at(daysAgo(200)), deliveredAt: at(daysAgo(190)), expect: 'not_payable' },

  // ── The delivery clock ──
  { note: 'delivered yesterday', paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(30)), deliveredAt: at(daysAgo(1)), expect: 'held' },
  { note: 'delivered one day short of the hold', paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(90)), deliveredAt: at(daysAgo(HOLD_DAYS_AFTER_DELIVERY - 1)), expect: 'held' },
  // Inclusive on the release day itself — a seller told "released on the 24th" who finds it still
  // held on the 24th has been shown the wrong date.
  { note: 'delivered exactly the hold ago — releases TODAY', paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(90)), deliveredAt: at(daysAgo(HOLD_DAYS_AFTER_DELIVERY)), expect: 'releasable' },
  { note: 'delivered well past the hold', paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(90)), deliveredAt: at(daysAgo(HOLD_DAYS_AFTER_DELIVERY + 5)), expect: 'releasable' },

  // ── The fallback clock: never marked delivered ──
  { note: 'paid recently, never marked delivered', paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(2)), deliveredAt: null, expect: 'held' },
  { note: 'paid one day short of the fallback', paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(FALLBACK_DAYS_AFTER_PAYMENT - 1)), deliveredAt: null, expect: 'held' },
  { note: 'paid exactly the fallback ago', paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(FALLBACK_DAYS_AFTER_PAYMENT)), deliveredAt: null, expect: 'releasable' },
  // The whole point of making the fallback LONGER than the delivery hold: at a day count that is
  // past the delivery hold but short of the fallback, not marking delivery must NOT pay faster.
  { note: 'past the delivery hold but not the fallback — undelivered stays held', paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(HOLD_DAYS_AFTER_DELIVERY + 1)), deliveredAt: null, expect: 'held' },

  // ── The anomaly ──
  // A captured order with no paid_at cannot be dated. It stays HELD rather than releasable: the
  // safe direction, and reconcile surfaces it rather than this rule inventing a day.
  { note: 'paid but no paid_at — undatable, so held', paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: null, deliveredAt: at(daysAgo(60)), expect: 'held' },
];

describe('the hold rule', () => {
  for (const c of CASES) {
    it(`${c.note} → ${c.expect}`, () => {
      const hold = orderHold(
        { paymentStatus: c.paymentStatus, shippingStatus: c.shippingStatus, paidAt: c.paidAt, deliveredAt: c.deliveredAt },
        TODAY,
      );
      expect(hold.state, c.note).toBe(c.expect);
      expect(isReleasable({ paymentStatus: c.paymentStatus, shippingStatus: c.shippingStatus, paidAt: c.paidAt, deliveredAt: c.deliveredAt }, TODAY))
        .toBe(c.expect === 'releasable');
    });
  }

  it('names the clock it used, so a seller can be told WHY', () => {
    const delivered = orderHold({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(30)), deliveredAt: at(daysAgo(1)) }, TODAY);
    expect(delivered.basis).toBe('delivery');
    expect(delivered.releaseDayISO).toBe(addDaysISO(daysAgo(1), HOLD_DAYS_AFTER_DELIVERY));

    const undelivered = orderHold({ paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(1)), deliveredAt: null }, TODAY);
    expect(undelivered.basis).toBe('payment');
    expect(undelivered.releaseDayISO).toBe(addDaysISO(daysAgo(1), FALLBACK_DAYS_AFTER_PAYMENT));
  });

  it('never offers a release date for money that will never come', () => {
    const dead = orderHold({ paymentStatus: 'paid', shippingStatus: 'cancelled', paidAt: at(daysAgo(90)), deliveredAt: at(daysAgo(80)) }, TODAY);
    expect(dead.state).toBe('not_payable');
    expect(dead.releaseDayISO).toBeNull();
    expect(dead.basis).toBeNull();
  });
});

/**
 * The twin check. Every case above is written as a real `orders` row and put through the SQL
 * predicate the payout run uses; the answer must match `isReleasable` exactly.
 *
 * Drift here is not cosmetic. If SQL called a row releasable and JS did not, a seller would be paid
 * for an order their own screen still showed as held — and the reverse leaves money the screen
 * promised sitting unsent with no run ever picking it up.
 */
describe('the SQL twin agrees with the JS rule', () => {
  const ids = new Map<string, Case>();

  beforeAll(async () => {
    for (const c of CASES) {
      const id = crypto.randomUUID();
      ids.set(id, c);
      await query(
        `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, paid_at, delivered_at)
         VALUES ($1, 'T', 'twin@example.com', 1000, $2, $3, $4::timestamptz, $5::timestamptz)`,
        [id, c.paymentStatus, c.shippingStatus, c.paidAt, c.deliveredAt],
      );
    }
  });

  it('returns exactly the rows JS calls releasable', async () => {
    const found = await rows<{ id: string }>(
      // $7: `releasableParams` supplies exactly six, so the first free slot is 7.
      `SELECT o.id FROM orders o WHERE o.id = ANY($7::uuid[]) AND ${RELEASABLE_SQL}`,
      [...releasableParams(TODAY), [...ids.keys()]],
    );
    const fromSql = new Set(found.map((r) => r.id));

    for (const [id, c] of ids) {
      const js = isReleasable(
        { paymentStatus: c.paymentStatus, shippingStatus: c.shippingStatus, paidAt: c.paidAt, deliveredAt: c.deliveredAt },
        TODAY,
      );
      expect(fromSql.has(id), `${c.note}: SQL says ${fromSql.has(id)}, JS says ${js}`).toBe(js);
    }
  });
});
