/**
 * **The number the owner is shown before the run, and the transfers the run makes.**
 *
 * This is the only figure on the platform that is acted on BEFORE there is a row to check it
 * against: the admin card says "₪X leaves the account on the 10th", and the 10th is when anyone
 * would find out it was wrong. So the guarantee cannot be "both were written carefully" — it has to
 * be that they are one function, and this file is what holds that.
 *
 * Every case below asserts the plan against what `runPayouts` then really created, over real rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query, rows } from '../src/lib/db.js';
import { planPayouts, runPayouts } from '../src/lib/payout-run.js';
import { nextPayoutDayISO } from '../src/lib/payout-schedule.js';
import { getPayoutsForSeller, recordAdjustment } from '../src/lib/payouts.js';
import { MIN_PAYOUT_AGOROT, PAYOUT_WEEKDAY } from '../src/lib/payout-schedule.js';

const TODAY = '2026-08-10';
const BANK = { code: '12', branch: '345', account: '99887766', holder: 'Payee' };

/** A seller with a store, optionally with bank details on file. */
async function makeSeller(opts: { bank?: boolean } = {}): Promise<{ sellerId: string; slug: string }> {
  const sellerId = crypto.randomUUID();
  const slug = `plan-${sellerId.slice(0, 8)}`;
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, created_at,
                          bank_code, bank_branch, bank_account, bank_account_holder)
     VALUES ($1, 'Plan Seller', $2, '', now(), $3, $4, $5, $6)`,
    [sellerId, `plan-${sellerId}@example.com`,
      opts.bank ? BANK.code : null, opts.bank ? BANK.branch : null,
      opts.bank ? BANK.account : null, opts.bank ? BANK.holder : null],
  );
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, tagline, description, colors, created_at)
     VALUES ($1, $2, $3, 'Plan Shop', '', '', '{"primary":"#000","accent":"#111"}'::jsonb, now())`,
    [crypto.randomUUID(), sellerId, slug],
  );
  return { sellerId, slug };
}

/** One delivered order old enough that its hold has certainly expired. */
async function seedReleased(slug: string, agorot: number): Promise<void> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status,
                         paid_at, delivered_at, created_at)
     VALUES ($1, 'B', 'b@example.com', $2, 'paid', 'delivered',
             now() - interval '200 days', now() - interval '190 days', now() - interval '200 days')`,
    [id, agorot],
  );
  await query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
     VALUES ($1, $2, 'Plan Shop', $3, 0)`,
    [id, slug, agorot],
  );
}

const rowFor = async (sellerId: string) =>
  (await planPayouts(TODAY)).rows.find((r) => r.sellerId === sellerId);

beforeEach(async () => {
  await query('DELETE FROM money_events');
  // Before the sellers: a completed run plans the platform's own invoice, and that row holds a
  // RESTRICT foreign key back to the seller. Nothing here is deleted in production — the ordering
  // exists because this file re-runs a payout against a clean table several times.
  await query('DELETE FROM invoice_documents');
  await query('DELETE FROM seller_ledger_adjustments');
  await query('DELETE FROM seller_payouts');
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  await query('DELETE FROM stores');
  await query('DELETE FROM sellers');
});

describe('the plan and the run are one answer', () => {
  it('what the card promises is exactly what leaves the account', async () => {
    const a = await makeSeller({ bank: true });
    const b = await makeSeller({ bank: true });
    await seedReleased(a.slug, 500_000);
    await seedReleased(b.slug, 300_000);

    const plan = await planPayouts(TODAY);
    const run = await runPayouts(TODAY);

    expect(run.created).toBe(plan.payableSellers);
    expect(run.totalAgorot).toBe(plan.payableAgorot);
    // …and the same per seller, not merely in total: a plan whose totals matched while two rows had
    // swapped amounts would pay each of them the other's money.
    const created = [...await getPayoutsForSeller(a.sellerId), ...await getPayoutsForSeller(b.sellerId)];
    for (const payout of created) {
      const planned = plan.rows.find((r) => r.sellerId === payout.sellerId)!;
      expect(payout.amountAgorot).toBe(planned.balanceAgorot);
      expect(payout.commissionAgorot).toBe(planned.commissionAgorot);
    }
  });

  it('reports money that will NOT move, and why — the state no other screen shows', async () => {
    const stuck = await makeSeller();            // released money, no bank details
    const tiny = await makeSeller({ bank: true }); // bank details, not enough money
    await seedReleased(stuck.slug, 500_000);
    await seedReleased(tiny.slug, 1_000);

    const plan = await planPayouts(TODAY);

    expect((await rowFor(stuck.sellerId))!.state).toBe('no_bank');
    expect(plan.noBankSellers).toBe(1);
    expect(plan.noBankAgorot).toBeGreaterThan(0);

    expect((await rowFor(tiny.sellerId))!.state).toBe('below_minimum');
    expect(plan.belowMinimumAgorot).toBeLessThan(MIN_PAYOUT_AGOROT);

    // Neither is payable, and neither is lost — the run creates nothing and the money stays.
    const run = await runPayouts(TODAY);
    expect(run.created).toBe(0);
    expect(run.skippedNoBank).toBe(1);
    expect((await rowFor(stuck.sellerId))!.balanceAgorot).toBeGreaterThan(0);
  });

  it('shows a seller who has already been paid as settled, not as stuck below the minimum', async () => {
    // The steady state, and the reason `settled` exists as its own answer: after a payout, the
    // balance is zero and zero IS below the minimum. Reporting it that way would bury the handful
    // of sellers who are genuinely stuck under everyone who is perfectly fine.
    const paid = await makeSeller({ bank: true });
    await seedReleased(paid.slug, 500_000);
    await runPayouts(TODAY);

    // A later month, so the period key differs and `already_paid` does not mask the question.
    const next = await planPayouts('2026-09-10');
    const row = next.rows.find((r) => r.sellerId === paid.sellerId)!;
    expect(row.state).toBe('settled');
    expect(row.balanceAgorot).toBe(0);
    expect(next.belowMinimumSellers).toBe(0);
  });

  it('a chargeback larger than the balance leaves nothing payable and nothing negative', async () => {
    const seller = await makeSeller({ bank: true });
    await seedReleased(seller.slug, 200_000);
    await recordAdjustment({ sellerId: seller.sellerId, kind: 'chargeback', amountAgorot: -900_000 });

    const row = (await rowFor(seller.sellerId))!;
    // Never negative on a "to be paid" column — a minus sign there reads as a payment. The debt is
    // real and it is `seller-account.ts`'s `carriedAgorot` that reports it, on the seller's screen.
    expect(row.balanceAgorot).toBe(0);
    expect(row.state).toBe('settled');
    expect((await runPayouts(TODAY)).created).toBe(0);
  });

  it('a re-run on the same day plans nothing new — the UNIQUE index, not control flow', async () => {
    const seller = await makeSeller({ bank: true });
    await seedReleased(seller.slug, 500_000);
    await runPayouts(TODAY);

    expect((await rowFor(seller.sellerId))!.state).toBe('already_paid');
    const second = await runPayouts(TODAY);
    expect(second.created).toBe(0);
    expect(second.skippedAlreadyPaid).toBe(1);
    const stored = await rows<{ n: number }>('SELECT COUNT(*)::int AS n FROM seller_payouts');
    expect(stored[0]!.n).toBe(1);
  });
});

describe('the date the card names', () => {
  /** 2026-08-16 is a Sunday, so the week either side of it pins every branch at once. */
  it('is today when today IS the payout day, and the next one otherwise', () => {
    expect(nextPayoutDayISO('2026-08-16')).toBe('2026-08-16');  // on the day itself
    expect(nextPayoutDayISO('2026-08-17')).toBe('2026-08-23');  // the morning after: a full week
    expect(nextPayoutDayISO('2026-08-22')).toBe('2026-08-23');  // the day before
  });

  /** Month and year rollovers, which plain day arithmetic on a `YYYY-MM-DD` string gets wrong. */
  it('crosses a month and a year without inventing a date', () => {
    expect(nextPayoutDayISO('2026-08-30')).toBe('2026-08-30');  // itself a Sunday
    expect(nextPayoutDayISO('2026-08-31')).toBe('2026-09-06');
    expect(nextPayoutDayISO('2026-12-28')).toBe('2027-01-03');
  });

  /** Every day of one week resolves to a payout day that really is the configured weekday. */
  it('always lands on the configured weekday', () => {
    for (const d of ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22']) {
      const next = nextPayoutDayISO(d);
      expect(next >= d, `${d} resolved backwards to ${next}`).toBe(true);
      expect(new Date(`${next}T12:00:00Z`).getUTCDay()).toBe(PAYOUT_WEEKDAY);
    }
  });
});
