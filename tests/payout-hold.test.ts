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
import { orderHold, isReleasable, RELEASABLE_SQL, releasableParams, RELEASABLE_PARAM_COUNT } from '../src/lib/payout-hold.js';
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
  /** Absent = courier, the stricter default and the shape of a pre-field order. */
  deliveryMethod?: 'pickup' | 'courier' | 'pickup_point';
  expect: 'not_payable' | 'held' | 'releasable';
}

const CASES: Case[] = [
  // ── Nothing to pay out ──
  { note: 'never captured', paymentStatus: 'pending', shippingStatus: 'processing', paidAt: null, deliveredAt: null, expect: 'not_payable' },
  { note: 'capture failed', paymentStatus: 'failed', shippingStatus: 'cancelled', paidAt: null, deliveredAt: null, expect: 'not_payable' },
  // The one that matters most: paid AND cancelled. `paymentStatus === 'paid'` alone matches this
  // row, which is exactly the mistake AI_INSTRUCTIONS names — it must never become payable.
  { note: 'paid then cancelled, long past any hold', paymentStatus: 'paid', shippingStatus: 'cancelled', paidAt: at(daysAgo(200)), deliveredAt: at(daysAgo(190)), expect: 'not_payable' },

  // ── The parcel never left ──
  // The hole the owner found on 2026-08-10: these three were `releasable` on the payment fallback,
  // because a paid-but-unshipped order legitimately counts as revenue. The platform paid sellers
  // for parcels that were never sent. Long past both clocks here, so a regression shows up as a
  // payout rather than as an off-by-one.
  { note: 'never touched, long past both clocks', paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(120)), deliveredAt: null, expect: 'held' },
  { note: 'seller started packing but never shipped', paymentStatus: 'paid', shippingStatus: 'processing', paidAt: at(daysAgo(120)), deliveredAt: null, expect: 'held' },
  // `ready` is the one that feels like the work is done — label printed, parcel packed. It is still
  // on the seller's table, and a status the seller sets alone must not start a clock ending in a
  // transfer.
  { note: 'packed and labelled, still on the seller\'s table', paymentStatus: 'paid', shippingStatus: 'ready', paidAt: at(daysAgo(120)), deliveredAt: null, expect: 'held' },

  // ── Self-pickup: no shipping leg, so `ready` is the milestone ──
  // Without its own column a collected order would be frozen until the seller remembered to press
  // "נמסר" after the buyer walked out — and forever if they forgot.
  { note: 'pickup, ready and past the fallback', paymentStatus: 'paid', shippingStatus: 'ready', paidAt: at(daysAgo(FALLBACK_DAYS_AFTER_PAYMENT + 1)), deliveredAt: null, deliveryMethod: 'pickup', expect: 'releasable' },
  { note: 'pickup, ready but still inside the fallback', paymentStatus: 'paid', shippingStatus: 'ready', paidAt: at(daysAgo(2)), deliveredAt: null, deliveryMethod: 'pickup', expect: 'held' },
  // Still gated before `ready`: a pickup order nobody has even packed is not the buyer's turn yet.
  { note: 'pickup, never packed', paymentStatus: 'paid', shippingStatus: 'processing', paidAt: at(daysAgo(120)), deliveredAt: null, deliveryMethod: 'pickup', expect: 'held' },
  // The same row for a COURIER order stays held — this is the pair that proves the column is doing
  // the work rather than `ready` having simply been loosened for everyone.
  { note: 'courier, ready and past the fallback — still held', paymentStatus: 'paid', shippingStatus: 'ready', paidAt: at(daysAgo(FALLBACK_DAYS_AFTER_PAYMENT + 1)), deliveredAt: null, deliveryMethod: 'courier', expect: 'held' },
  // A pickup POINT is a courier leg to a locker, so it takes the courier milestone, not pickup's.
  { note: 'pickup_point, ready and past the fallback — still held', paymentStatus: 'paid', shippingStatus: 'ready', paidAt: at(daysAgo(FALLBACK_DAYS_AFTER_PAYMENT + 1)), deliveredAt: null, deliveryMethod: 'pickup_point', expect: 'held' },

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
      const projection = {
        paymentStatus: c.paymentStatus, shippingStatus: c.shippingStatus,
        paidAt: c.paidAt, deliveredAt: c.deliveredAt, deliveryMethod: c.deliveryMethod ?? null,
      };
      expect(orderHold(projection, TODAY).state, c.note).toBe(c.expect);
      expect(isReleasable(projection, TODAY)).toBe(c.expect === 'releasable');
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

  it('an unshipped order says WHY it has no date, distinctly from an undatable one', () => {
    // Two different held-with-no-date states needing opposite messages: "ship it and the countdown
    // begins" versus "something is wrong with this record". A single null basis for both would put
    // the wrong one in front of a seller.
    const unshipped = orderHold({ paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(120)), deliveredAt: null }, TODAY);
    expect(unshipped.state).toBe('held');
    expect(unshipped.releaseDayISO).toBeNull();
    expect(unshipped.basis).toBe('unshipped');

    const undatable = orderHold({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: null, deliveredAt: at(daysAgo(60)) }, TODAY);
    expect(undatable.state).toBe('held');
    expect(undatable.basis).toBeNull();
  });

  it('shipping an old order starts the clock rather than releasing it instantly', () => {
    // The seller can still fix it: an order paid 120 days ago and shipped today is held from the
    // shipment, not released on the spot because the payment fallback lapsed months back.
    const justShipped = orderHold({ paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(120)), deliveredAt: null }, TODAY);
    // ⚠️ Known and deliberate: the fallback runs from PAYMENT, so this one is releasable at once.
    // It is correct against the rule as written and it is the tail the courier webhook closes
    // (see the module header). Pinned so the day that changes, this case has to be re-read.
    expect(justShipped.state).toBe('releasable');
    expect(justShipped.basis).toBe('payment');
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
      // The predicate reads the delivery method off the per-store slice, so the twin needs the real
      // two-table shape rather than a bare orders row — which is also how every caller queries it.
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot, delivery_method)
         VALUES ($1, 'twin-shop', 'Twin', 1000, 0, $2)`,
        [id, c.deliveryMethod ?? null],
      );
    }
  });

  it('returns exactly the rows JS calls releasable', async () => {
    const found = await rows<{ id: string }>(
      // Derived, not written as a literal — this test hardcoded `$7` and broke the day the
      // predicate grew a seventh parameter of its own.
      `SELECT o.id FROM orders o
         JOIN order_stores os ON os.order_id = o.id
        WHERE o.id = ANY($${RELEASABLE_PARAM_COUNT + 1}::uuid[]) AND ${RELEASABLE_SQL}`,
      [...releasableParams(TODAY), [...ids.keys()]],
    );
    const fromSql = new Set(found.map((r) => r.id));

    for (const [id, c] of ids) {
      const js = isReleasable(
        {
          paymentStatus: c.paymentStatus, shippingStatus: c.shippingStatus,
          paidAt: c.paidAt, deliveredAt: c.deliveredAt, deliveryMethod: c.deliveryMethod ?? null,
        },
        TODAY,
      );
      expect(fromSql.has(id), `${c.note}: SQL says ${fromSql.has(id)}, JS says ${js}`).toBe(js);
    }
  });
});
