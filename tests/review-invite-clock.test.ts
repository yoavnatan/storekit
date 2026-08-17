import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { query, firstRow } from '../src/lib/db.js';
import { runReviewInvites } from '../src/lib/review-invite-run.js';
import {
  REVIEW_INVITE_DAYS_AFTER_DELIVERY,
  REVIEW_INVITE_DAYS_AFTER_DISPATCH,
  REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT,
} from '../src/lib/review-timing.js';

/**
 * WHEN the "how was it?" mail goes out.
 *
 * The first version measured five days from `orders.updated_at`, which is the mistake migration
 * 0023 had already written down for the payout hold in the same table: `updated_at` is the last
 * touch of ANY field, so a seller fixing a tracking number pushed the invitation out silently, and
 * a status corrected `delivered → shipped → delivered` restarted it. **The regression test is the
 * third case below** — it is the one that fails against the old implementation and passes against
 * this one, and it is the reason this file exists rather than a couple of extra cases elsewhere.
 *
 * The mail itself never leaves: the console adapter is what a test environment has, so what is
 * asserted is the CLAIM — `review_invited_at` stamped, exactly once, on exactly the right rows.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

/** One paid order in a given state. Written directly rather than through checkout: this is about
 *  three timestamp columns, and driving a purchase to set them would test the checkout instead. */
async function order(fields: {
  shippingStatus?: string;
  paidAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  updatedAt?: string;
  invitedAt?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, buyer_phone, buyer_city, buyer_street,
                         shipping_agorot, total_agorot, payment_status, shipping_status,
                         paid_at, shipped_at, delivered_at, review_invited_at, created_at, updated_at)
     VALUES ($1, 'דנה', 'clock@example.test', '0500000000', 'תל אביב', 'הרצל 1',
             0, 1000, 'paid', $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      fields.shippingStatus ?? 'delivered',
      fields.paidAt === undefined ? daysAgo(60) : fields.paidAt,
      fields.shippedAt ?? null,
      fields.deliveredAt ?? null,
      fields.invitedAt ?? null,
      daysAgo(60),
    ],
  );
  if (fields.updatedAt) await query('UPDATE orders SET updated_at = $2 WHERE id = $1', [id, fields.updatedAt]);
  return id;
}

const invitedAt = async (id: string): Promise<string | null> => {
  const row = await firstRow<{ review_invited_at: Date | null }>(
    'SELECT review_invited_at FROM orders WHERE id = $1', [id]);
  return row?.review_invited_at ? String(row.review_invited_at) : null;
};

beforeEach(async () => {
  await query('DELETE FROM product_reviews');
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM return_requests');
  await query('DELETE FROM orders');
  // The console adapter prints; nothing here needs to read it.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the delivered clock', () => {
  it('asks two days after the buyer got it', async () => {
    const due = await order({ deliveredAt: daysAgo(REVIEW_INVITE_DAYS_AFTER_DELIVERY + 1) });
    const result = await runReviewInvites(NOW);
    expect(result.sent).toBe(1);
    expect(await invitedAt(due)).not.toBeNull();
  });

  it('does not ask the day it arrived', async () => {
    // Too early is not a smaller mistake than too late: the buyer ignores it once and is never
    // asked again, because the row is stamped either way.
    const early = await order({ deliveredAt: daysAgo(0) });
    await runReviewInvites(NOW);
    expect(await invitedAt(early)).toBeNull();
  });

  it('IGNORES `updated_at` entirely — the regression this file exists for', async () => {
    // A seller who corrects a tracking number today, on a parcel delivered a week ago. Under the
    // old `updated_at` clock this order fell out of the query and the buyer was asked a week late,
    // or — with the status corrected back and forth — never.
    const fiddled = await order({
      deliveredAt: daysAgo(7),
      updatedAt: daysAgo(0),
    });
    const result = await runReviewInvites(NOW);
    expect(result.sent).toBe(1);
    expect(await invitedAt(fiddled)).not.toBeNull();
  });
});

describe('the dispatch clock, for an order nobody marked delivered', () => {
  it('asks ten days after the parcel LEFT', async () => {
    const stale = await order({
      shippingStatus: 'shipped',
      deliveredAt: null,
      shippedAt: daysAgo(REVIEW_INVITE_DAYS_AFTER_DISPATCH + 1),
    });
    const result = await runReviewInvites(NOW);
    expect(result.sent).toBe(1);
    expect(await invitedAt(stale)).not.toBeNull();
  });

  it('does not charge the buyer for the seller\'s packing time', async () => {
    // Paid three weeks ago, spent a fortnight in `processing` — the seller's right — and posted
    // three days ago. Measured from PAYMENT, which is what this did before migration 0036, the
    // mail went out three days into transit. Measured from dispatch it correctly waits.
    const slowSeller = await order({
      shippingStatus: 'shipped',
      deliveredAt: null,
      paidAt: daysAgo(21),
      shippedAt: daysAgo(3),
    });
    await runReviewInvites(NOW);
    expect(await invitedAt(slowSeller)).toBeNull();
  });

  it('does not let a lower clock govern an order we KNOW arrived', async () => {
    // Posted three weeks ago, delivered this morning. An `OR` over the three clocks would have
    // fired on dispatch and asked about a parcel the buyer opened an hour earlier.
    const justArrived = await order({ shippedAt: daysAgo(21), deliveredAt: daysAgo(0) });
    await runReviewInvites(NOW);
    expect(await invitedAt(justArrived)).toBeNull();
  });
});

describe('the payment last resort, for an order with no dispatch stamp at all', () => {
  it('covers a self-pickup order, which never passes through `shipped`', async () => {
    const pickup = await order({
      shippingStatus: 'delivered',
      deliveredAt: null,
      shippedAt: null,
      paidAt: daysAgo(REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT + 1),
    });
    const result = await runReviewInvites(NOW);
    expect(result.sent).toBe(1);
    expect(await invitedAt(pickup)).not.toBeNull();
  });

  it('is MORE patient than the dispatch clock, because it knows less', async () => {
    // Old enough for the dispatch clock, not for this one. Anything else would mean an order with
    // no dispatch record is asked about EARLIER than one we can actually date.
    expect(REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT).toBeGreaterThan(REVIEW_INVITE_DAYS_AFTER_DISPATCH);
    const young = await order({
      shippingStatus: 'shipped', deliveredAt: null, shippedAt: null,
      paidAt: daysAgo(REVIEW_INVITE_DAYS_AFTER_DISPATCH + 1),
    });
    await runReviewInvites(NOW);
    expect(await invitedAt(young)).toBeNull();
  });
});

describe('what it refuses to ask about at all', () => {
  it('skips an order that never shipped, and a cancelled one', async () => {
    const pending = await order({ shippingStatus: 'pending', deliveredAt: null, paidAt: daysAgo(90) });
    const cancelled = await order({ shippingStatus: 'cancelled', deliveredAt: daysAgo(30) });
    const result = await runReviewInvites(NOW);
    expect(result.sent).toBe(0);
    expect(await invitedAt(pending)).toBeNull();
    expect(await invitedAt(cancelled)).toBeNull();
  });

  it('says nothing to a buyer with an OPEN case', async () => {
    // The status columns cannot see this: a return lives in its own table and does not move the
    // order until it is refunded, so a parcel the buyer has already told us never arrived still
    // satisfies every clock. "איך היה?" in that inbox earns a one-star about US.
    const disputed = await order({ deliveredAt: daysAgo(10) });
    await query(
      `INSERT INTO return_requests (id, order_id, store_slug, reason, within_statutory, refund_agorot, status)
       VALUES ($1, $2, 'keramika', 'not_arrived', true, 0, 'requested')`,
      [crypto.randomUUID(), disputed],
    );
    const result = await runReviewInvites(NOW);
    expect(result.sent).toBe(0);
    // Left UN-stamped: the case will close, and then this is an ordinary order that deserves the
    // question. Skipping is not deciding never to ask.
    expect(await invitedAt(disputed)).toBeNull();
  });

  it('asks once and never again', async () => {
    const due = await order({ deliveredAt: daysAgo(10) });
    expect((await runReviewInvites(NOW)).sent).toBe(1);
    const stamp = await invitedAt(due);

    const second = await runReviewInvites(NOW + DAY);
    expect(second.scanned).toBe(0);
    // The stamp is the memory — a second pass must not even re-write it, or a retry loop would be
    // invisible in the data.
    expect(await invitedAt(due)).toBe(stamp);
  });
});
