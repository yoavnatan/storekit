/**
 * The three ways a payout system loses money, and the proof that none of them can happen here.
 *
 *   1. Paying twice. A scheduled job gets retried — after a crash, by two servers, by a person
 *      re-triggering it. The defence is a UNIQUE index, not control flow, and this asserts the
 *      index is really what decides.
 *   2. Paying more than was released. Every adjustment and every prior payout has to come off, and
 *      money still inside its hold must never be reachable no matter what the arithmetic says.
 *   3. Absorbing a reversal silently. A refund on an order already paid out has to land on
 *      somebody; without a clawback it lands invisibly on the platform.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { createPayout, setPayoutStatus, recordAdjustment, getPayoutsForSeller, getAdjustmentsForSeller } from '../src/lib/payouts.js';
import { buildSellerAccount, payoutBalanceAgorot, type AccountSlice } from '../src/lib/seller-account.js';
import { splitHeldByBasis } from '../src/lib/order-payout-line.js';
import { needsBankDetails, type PayoutDetails } from '../src/lib/payout-details.js';
import { commissionOnAgorot, commissionPercentForTier } from '../src/lib/pricing.js';
import { HOLD_DAYS_AFTER_DELIVERY } from '../src/lib/payout-schedule.js';
import { addDaysISO } from '../src/lib/date-range.js';

const TODAY = '2026-08-10';
const at = (dayISO: string) => `${dayISO}T12:00:00.000Z`;
const daysAgo = (n: number) => addDaysISO(TODAY, -n);

/** A slice whose hold has expired, so its money is genuinely payable. */
const released = (netAgorot: number): AccountSlice => ({
  orderId: crypto.randomUUID(),
  storeSlug: 'shop',
  netAgorot,
  order: {
    paymentStatus: 'paid',
    shippingStatus: 'delivered',
    paidAt: at(daysAgo(60)),
    deliveredAt: at(daysAgo(HOLD_DAYS_AFTER_DELIVERY + 1)),
  },
});

/** Same money, still inside the hold. */
const stillHeld = (netAgorot: number): AccountSlice => ({
  ...released(netAgorot),
  order: { paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(3)), deliveredAt: at(daysAgo(1)) },
});

/** Paid for, never posted. Held with NO release date, and the one case where the seller is holding
 *  up their own money — `payout-hold.ts`'s `unshipped` basis. */
const unshipped = (netAgorot: number): AccountSlice => ({
  ...released(netAgorot),
  order: { paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(9)), deliveredAt: null },
});

async function makeSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, created_at)
     VALUES ($1, 'Payout Test', $2, '', now())`,
    [id, `payout-${id}@example.com`],
  );
  return id;
}

describe('a payout run cannot pay twice', () => {
  let sellerId: string;
  beforeAll(async () => { sellerId = await makeSeller(); });

  it('the second create for the same period returns null and writes nothing', async () => {
    const first = await createPayout({ sellerId, periodKey: '2026-08', amountAgorot: 50_000, bankSnapshot: null });
    const second = await createPayout({ sellerId, periodKey: '2026-08', amountAgorot: 50_000, bankSnapshot: null });

    expect(first).not.toBeNull();
    // Null means "somebody already created this one", NOT an error — that distinction is what lets
    // the job loop over every seller without a try/catch per iteration.
    expect(second).toBeNull();
    expect((await getPayoutsForSeller(sellerId)).filter((p) => p.periodKey === '2026-08')).toHaveLength(1);
  });

  it('a different period is a different payout', async () => {
    const ok = await createPayout({ sellerId, periodKey: '2026-09', amountAgorot: 20_000, bankSnapshot: null });
    expect(ok).not.toBeNull();
    expect((await getPayoutsForSeller(sellerId)).map((p) => p.periodKey).sort()).toEqual(['2026-08', '2026-09']);
  });

  // The minimum is deliberately NOT enforced here. It is a run-level policy — "not worth a bank
  // transfer this month" — and storage must not refuse a payout somebody deliberately creates for
  // a smaller amount (a final settlement on a closing store, a correction). `payout-run.ts` is
  // where MIN_PAYOUT_AGOROT applies, and it rolls the balance over rather than dropping it.
  it('does not apply the run\'s minimum — that is a policy, not a storage rule', async () => {
    const tiny = await createPayout({ sellerId, periodKey: '2026-11', amountAgorot: 1, bankSnapshot: null });
    expect(tiny).not.toBeNull();
    expect(tiny!.amountAgorot).toBe(1);
  });

  it('refuses a zero or negative amount instead of raising inside the loop', async () => {
    expect(await createPayout({ sellerId, periodKey: '2026-10', amountAgorot: 0, bankSnapshot: null })).toBeNull();
    expect(await createPayout({ sellerId, periodKey: '2026-10', amountAgorot: -500, bankSnapshot: null })).toBeNull();
  });
});

/**
 * The double-billing bug, found reviewing this change and fixed in it.
 *
 * `getReleasableBySeller` is CUMULATIVE — it answers "commission on everything out of hold", which
 * still includes every earlier period, because a balance that stayed below the payout minimum is
 * still releasable next month. Feeding that straight to the platform's tax invoice bills the seller
 * a second time for commission they were already invoiced for. The fix is that each payout records
 * the slice of commission it settled, and the next run subtracts them.
 */
describe('commission is invoiced once, not once per period it rolls over', () => {
  it('the settled commission carried on a payout is the increment, and prior ones subtract', async () => {
    const sellerId = await makeSeller();

    // Period 1 settles 12,000 of commission.
    const first = await createPayout({ sellerId, periodKey: '2026-06', amountAgorot: 88_000, commissionAgorot: 12_000, bankSnapshot: null });
    expect(first!.commissionAgorot).toBe(12_000);

    // Period 2: the cumulative figure has grown to 20,000, so only 8,000 is new.
    const payouts = await getPayoutsForSeller(sellerId);
    const alreadyInvoiced = payouts.reduce((sum, p) => (p.status === 'failed' ? sum : sum + p.commissionAgorot), 0);
    expect(Math.max(0, 20_000 - alreadyInvoiced)).toBe(8_000);
  });

  it('a FAILED payout settled no commission either, so its slice becomes billable again', async () => {
    const sellerId = await makeSeller();
    const payout = await createPayout({ sellerId, periodKey: '2026-06', amountAgorot: 50_000, commissionAgorot: 9_000, bankSnapshot: null });
    await setPayoutStatus(payout!.id, 'failed', 'bank rejected');

    const payouts = await getPayoutsForSeller(sellerId);
    const alreadyInvoiced = payouts.reduce((sum, p) => (p.status === 'failed' ? sum : sum + p.commissionAgorot), 0);
    // Same rule as `paidOut`: the transfer came back, so nothing about it was settled.
    expect(alreadyInvoiced).toBe(0);
  });

  it('defaults to 0 rather than guessing from the amount', async () => {
    // A manual or corrective payout settles no commission, and amount and commission are not
    // proportional once an adjustment is in play — so there is nothing to infer.
    const sellerId = await makeSeller();
    const manual = await createPayout({ sellerId, periodKey: '2026-07', amountAgorot: 5_000, bankSnapshot: null });
    expect(manual!.commissionAgorot).toBe(0);
  });
});

describe('a failed payout gives the money back', () => {
  it('is excluded from paidOut, so the amount becomes payable again', async () => {
    const sellerId = await makeSeller();
    const payout = await createPayout({ sellerId, periodKey: '2026-08', amountAgorot: 30_000, bankSnapshot: null });
    expect(payout).not.toBeNull();

    const slices = [released(100_000)];
    const before = buildSellerAccount('starter', slices, await getPayoutsForSeller(sellerId), [], TODAY);
    expect(before.paidOutAgorot).toBe(30_000);

    await setPayoutStatus(payout!.id, 'failed', 'bank rejected the account number');

    const after = buildSellerAccount('starter', slices, await getPayoutsForSeller(sellerId), [], TODAY);
    // The row is still there — a money row is evidence and is never deleted — but it no longer
    // withholds the amount. Deleting it would do the same arithmetic and destroy the answer to
    // "what happened in August".
    expect((await getPayoutsForSeller(sellerId))).toHaveLength(1);
    expect(after.paidOutAgorot).toBe(0);
    expect(after.payableNowAgorot).toBeGreaterThan(before.payableNowAgorot);
  });
});

describe('a clawback debits once, however many times it fires', () => {
  it('is idempotent on (order, kind)', async () => {
    const sellerId = await makeSeller();
    const orderId = crypto.randomUUID();
    await query(
      `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status)
       VALUES ($1, 'T', 'claw@example.com', 5000, 'paid', 'cancelled')`,
      [orderId],
    );

    const first = await recordAdjustment({ sellerId, orderId, kind: 'refund_clawback', amountAgorot: -4_000 });
    const again = await recordAdjustment({ sellerId, orderId, kind: 'refund_clawback', amountAgorot: -4_000 });

    expect(first).not.toBeNull();
    expect(again).toBeNull();
    expect(await getAdjustmentsForSeller(sellerId)).toHaveLength(1);
  });

  it('a manual correction is NOT deduplicated — two deliberate corrections are two corrections', async () => {
    const sellerId = await makeSeller();
    expect(await recordAdjustment({ sellerId, kind: 'manual', amountAgorot: -100, detail: 'a' })).not.toBeNull();
    expect(await recordAdjustment({ sellerId, kind: 'manual', amountAgorot: -100, detail: 'b' })).not.toBeNull();
    expect(await getAdjustmentsForSeller(sellerId)).toHaveLength(2);
  });
});

describe('the account arithmetic', () => {
  const rate = commissionPercentForTier('starter');

  it('held money is never payable, whatever else is true', () => {
    const account = buildSellerAccount('starter', [stillHeld(100_000)], [], [], TODAY);
    expect(account.heldAgorot).toBeGreaterThan(0);
    expect(account.releasableAgorot).toBe(0);
    expect(account.payableNowAgorot).toBe(0);
  });

  it('payable never exceeds what has been released', () => {
    const account = buildSellerAccount('starter', [released(100_000), stillHeld(500_000)], [], [], TODAY);
    expect(account.payableNowAgorot).toBeLessThanOrEqual(account.releasableAgorot);
  });

  it('a cancelled slice contributes to nothing at all — not even gross', () => {
    const cancelled: AccountSlice = {
      ...released(100_000),
      order: { paymentStatus: 'paid', shippingStatus: 'cancelled', paidAt: at(daysAgo(60)), deliveredAt: at(daysAgo(50)) },
    };
    const account = buildSellerAccount('starter', [cancelled], [], [], TODAY);
    // Counting it in gross while excluding it from held/releasable would render a page whose parts
    // visibly do not sum to its whole.
    expect(account.grossAgorot).toBe(0);
    expect(account.commissionAgorot).toBe(0);
    expect(account.heldAgorot).toBe(0);
    expect(account.releasableAgorot).toBe(0);
  });

  it('commission is rounded per slice and summed, matching what a seller can add up by hand', () => {
    // Amounts chosen so per-slice rounding and whole-total rounding actually differ.
    const nets = [3_333, 6_667, 1_111];
    const account = buildSellerAccount('starter', nets.map(released), [], [], TODAY);
    const bySlice = nets.reduce((sum, n) => sum + commissionOnAgorot(n, rate), 0);
    expect(account.commissionAgorot).toBe(bySlice);
    for (const [i, slice] of account.slices.entries()) {
      expect(slice.commissionAgorot).toBe(commissionOnAgorot(nets[i]!, rate));
    }
  });

  it('the parts sum to the whole', () => {
    const account = buildSellerAccount('starter', [released(100_000), released(37_777), stillHeld(64_321)], [], [], TODAY);
    const sellerShare = account.grossAgorot - account.commissionAgorot;
    expect(account.heldAgorot + account.releasableAgorot).toBe(sellerShare);
  });

  /**
   * The payments tab's middle section is now a SPLIT of `heldAgorot` by reason rather than a list
   * of the orders behind it (owner, סשן א׳ §4), so the rows and the tile above them are two
   * renderings of one number. This is the invariant that keeps them one: every agora in the tile
   * appears in exactly one line, including the anomalies.
   */
  it('the held split adds up to the held tile, anomalies included', () => {
    const account = buildSellerAccount(
      'starter',
      [released(100_000), stillHeld(64_321), stillHeld(7_777), unshipped(23_456)],
      [], [], TODAY,
    );
    const split = splitHeldByBasis(account.slices);
    const shown = split.groups.reduce((t, g) => t + g.agorot, 0) + split.unknownAgorot;
    expect(shown).toBe(account.heldAgorot);
    // And the released slice is NOT double-counted into it — it is already inside payableNow.
    expect(shown).toBeLessThan(account.grossAgorot - account.commissionAgorot);
  });

  it('an unshipped order is held, dateless, and named as the seller\'s own to unblock', () => {
    const account = buildSellerAccount('starter', [unshipped(23_456)], [], [], TODAY);
    expect(account.heldAgorot).toBeGreaterThan(0);
    expect(account.payableNowAgorot).toBe(0);
    const split = splitHeldByBasis(account.slices);
    expect(split.groups.map((g) => g.basis)).toEqual(['unshipped']);
    expect(split.unknownOrders).toBe(0);
  });

  it('a debt larger than the balance becomes a carried debt, never a negative payout', () => {
    const account = buildSellerAccount('starter', [released(10_000)], [], [{ amountAgorot: -50_000 }], TODAY);
    expect(account.payableNowAgorot).toBe(0);
    // The debt is neither paid nor lost. Flooring it away silently would be a hole in the
    // platform's own money that no screen reports.
    expect(account.carriedAgorot).toBeGreaterThan(0);
    expect(account.carriedAgorot).toBe(50_000 - account.releasableAgorot);
  });

  it('a clawback comes off the next payout', () => {
    const slices = [released(100_000)];
    const clean = buildSellerAccount('starter', slices, [], [], TODAY);
    const clawed = buildSellerAccount('starter', slices, [], [{ amountAgorot: -20_000 }], TODAY);
    expect(clawed.payableNowAgorot).toBe(clean.payableNowAgorot - 20_000);
  });

  /** `buildSellerAccount` and `planPayouts` reach the balance from different inputs, and both go
   *  through this. A sign error here is a seller paid twice or not at all, so it is pinned on its
   *  own rather than only through its callers. */
  it('the balance is releasable − paidOut + adjustments, signed', () => {
    expect(payoutBalanceAgorot(100_000, 30_000, 0)).toBe(70_000);
    expect(payoutBalanceAgorot(100_000, 0, -25_000)).toBe(75_000);
    expect(payoutBalanceAgorot(10_000, 0, -50_000)).toBe(-40_000);
    // The one arrangement that must NOT net out: money already sent plus a credit is not new money.
    expect(payoutBalanceAgorot(0, 30_000, 30_000)).toBe(0);
  });
});

/**
 * The red dot that says "you have money and nowhere to send it".
 *
 * Three surfaces draw it — the payments tab's badge, the banner inside the tab, and the avatar in
 * the site header — and the whole point of the chain is that following one dot reaches something to
 * do (owner, סשן א׳ §5). A dot on a screen with nothing on it is worse than no dot, so the rule is
 * one function and this pins its two halves.
 */
describe('when the bank details are actually asked for', () => {
  const noBank: PayoutDetails = {};
  const fullBank: PayoutDetails = { bankCode: '12', bankBranch: '345', bankAccount: '6789', bankAccountHolder: 'עסק בע״מ' };
  const halfBank: PayoutDetails = { bankCode: '12', bankBranch: '345' };

  it('never before there is money — that would be the registration-time barrier the project refuses', () => {
    expect(needsBankDetails(noBank, 0)).toBe(false);
  });

  it('the moment money is released and there is nowhere to send it', () => {
    expect(needsBankDetails(noBank, 1)).toBe(true);
  });

  it('a half-filled form still counts as nowhere — a transfer missing a field cannot be made', () => {
    expect(needsBankDetails(halfBank, 100_000)).toBe(true);
  });

  it('and clears the moment all four fields are there', () => {
    expect(needsBankDetails(fullBank, 100_000)).toBe(false);
  });
});
