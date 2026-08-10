import { rows, firstRow, isUuid } from './db.js';
import { recordMoneyEvent } from './money-events.js';
import { RELEASABLE_SQL, releasableParams } from './payout-hold.js';
import { NET_SQL } from './order-reporting.js';
import { REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES } from './order-status-rules.js';
import { SELLER_TIERS, DEFAULT_TIER } from './pricing.js';
import { businessTodayISO } from './business-day.js';
import { buildSellerAccount, type AccountSlice, type SellerAccount } from './seller-account.js';
import { getSellerById } from './seller-auth.js';
import type { Order } from './orders.js';

/**
 * Storage for the two things the agent model made real: **a transfer that left**, and **a debt that
 * landed**. The arithmetic is in `seller-account.ts`; this file only reads and writes rows.
 *
 * ── Why `createPayout` inserts and does not check first ──
 * The classic shape — SELECT to see whether this seller has been paid for this period, then INSERT
 * — is wrong under every condition this code will actually meet: the job retried after a crash, two
 * app servers whose timers fired together, someone re-triggering the run by hand. Between the SELECT
 * and the INSERT is a window, and what falls into it is a **second bank transfer**.
 *
 * So the uniqueness lives in the database (`seller_payouts_seller_period_idx`, migration 0023) and
 * this inserts unconditionally with `ON CONFLICT DO NOTHING`, reading the affected-row count as the
 * answer — the same shape as `decrementStock` and `claimCoupon`, and for the same reason. A caller
 * that gets `null` has been told, correctly, "somebody already created this one"; it has not been
 * told an error occurred, because nothing went wrong.
 *
 * ── Why a failed payout keeps its row ──
 * Nothing here deletes. A bounced transfer is evidence — of an account number that was wrong, of a
 * bank that rejected us, of a seller asking why their money did not arrive — and `status='failed'`
 * both preserves it and returns the amount to payable, because `seller-account.ts` excludes failed
 * rows from `paidOut`. Deleting the row would do the same arithmetic while destroying the answer to
 * "what happened in March".
 */

export type PayoutStatus = 'pending' | 'sent' | 'paid' | 'failed';

export interface BankSnapshot {
  code: string;
  branch: string;
  account: string;
  holder: string;
}

export interface SellerPayout {
  id: string;
  sellerId: string;
  /** 'YYYY-MM' on the BUSINESS calendar — `businessMonthKey`, never UTC. */
  periodKey: string;
  amountAgorot: number;
  /** The commission this payout settled — the INCREMENT, not the seller's lifetime total. See the
   *  column comment in migration 0023: the releasable figure is cumulative, so the platform's tax
   *  invoice has to be generated from the difference or it bills the same commission twice. */
  commissionAgorot: number;
  status: PayoutStatus;
  bankSnapshot: BankSnapshot | null;
  createdAt: string;
  sentAt: string | null;
  detail: string | null;
}

export type AdjustmentKind =
  | 'refund_clawback'
  | 'chargeback'
  | 'setoff_subscription'
  | 'setoff_ad'
  | 'manual';

export interface LedgerAdjustment {
  id: string;
  sellerId: string;
  orderId: string | null;
  kind: AdjustmentKind;
  /** Signed. Negative reduces what we owe the seller. */
  amountAgorot: number;
  createdAt: string;
  detail: string;
}

interface PayoutRow {
  id: string;
  seller_id: string;
  period_key: string;
  amount_agorot: string | number;
  commission_agorot: string | number;
  status: PayoutStatus;
  bank_snapshot: unknown;
  created_at: Date | string;
  sent_at: Date | string | null;
  detail: string | null;
}

interface AdjustmentRow {
  id: string;
  seller_id: string;
  order_id: string | null;
  kind: AdjustmentKind;
  amount_agorot: string | number;
  created_at: Date | string;
  detail: string;
}

/** `bigint` arrives from `pg` as a string and from PGlite as a number — the same conversion
 *  `orders.ts` and `store-coupons.ts` do, for the same columns and the same reason. */
function big(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Re-validated on the way out rather than trusted for having been in our own `jsonb` column — the
 *  same stance `orders.ts` takes with `attribution`. A row written by an older shape degrades to
 *  "no snapshot" instead of putting a malformed account number in front of someone. */
function toBankSnapshot(v: unknown): BankSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const snap = { code: s('code'), branch: s('branch'), account: s('account'), holder: s('holder') };
  return snap.account ? snap : null;
}

function toPayout(row: PayoutRow): SellerPayout {
  return {
    id: row.id,
    sellerId: row.seller_id,
    periodKey: row.period_key,
    amountAgorot: big(row.amount_agorot),
    commissionAgorot: big(row.commission_agorot),
    status: row.status,
    bankSnapshot: toBankSnapshot(row.bank_snapshot),
    createdAt: iso(row.created_at)!,
    sentAt: iso(row.sent_at),
    detail: row.detail,
  };
}

function toAdjustment(row: AdjustmentRow): LedgerAdjustment {
  return {
    id: row.id,
    sellerId: row.seller_id,
    orderId: row.order_id,
    kind: row.kind,
    amountAgorot: big(row.amount_agorot),
    createdAt: iso(row.created_at)!,
    detail: row.detail,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

export async function getPayoutsForSeller(sellerId: string): Promise<SellerPayout[]> {
  if (!isUuid(sellerId)) return [];
  const result = await rows<PayoutRow>(
    'SELECT * FROM seller_payouts WHERE seller_id = $1 ORDER BY created_at DESC',
    [sellerId],
  );
  return result.map(toPayout);
}

export async function getAdjustmentsForSeller(sellerId: string): Promise<LedgerAdjustment[]> {
  if (!isUuid(sellerId)) return [];
  const result = await rows<AdjustmentRow>(
    'SELECT * FROM seller_ledger_adjustments WHERE seller_id = $1 ORDER BY created_at DESC',
    [sellerId],
  );
  return result.map(toAdjustment);
}

/** One seller's releasable total, as the database computed it. */
export interface ReleasableForSeller {
  sellerId: string;
  grossAgorot: number;
  commissionAgorot: number;
  /** gross − commission: what may actually be sent, before payouts and adjustments. */
  netAgorot: number;
}

/**
 * Every seller with money out of hold, aggregated in ONE query.
 *
 * **Why this is not "load the orders and use `seller-account.ts`".** That module is the right shape
 * for one seller's own screen, where the per-order list is the point. The payout run asks about
 * every seller on the platform at once, and doing it in JS means pulling every order ever placed
 * into memory once a month — the shape `feedback_scalability` exists to reject. So the run
 * aggregates in SQL, and the hold rule has a second spelling for it (`RELEASABLE_SQL`, which lives
 * beside its JS twin so the two cannot drift unnoticed).
 *
 * **The commission is rounded PER SLICE here too, and that is the fiddly part worth the join.**
 * `commissionOnAgorot` is `Math.round(net * pct / 100)` applied to each slice and then summed —
 * that is what the seller's screen shows and what `seller-balance.ts` reports. Applying the rate to
 * the seller's TOTAL instead would be off by a few agorot against those screens, which is precisely
 * the "two surfaces disagree about money" class `reporting-invariants.test.ts` was written for. So
 * the rate is joined per seller and `ROUND` is applied inside the `SUM`. Postgres' `ROUND` on
 * numeric rounds half away from zero and JS `Math.round` rounds half up; the net is `GREATEST(…, 0)`
 * and therefore never negative, so on this domain they are the same function.
 *
 * The tier→percent table is passed in from `lib/pricing.ts` as two parallel arrays rather than
 * written into the SQL, so pricing stays the single source and no rate is ever spelled in a query.
 */
export async function getReleasableBySeller(
  todayISO: string = businessTodayISO(),
): Promise<ReleasableForSeller[]> {
  const tiers = SELLER_TIERS.map((t) => t.id);
  const percents = SELLER_TIERS.map((t) => t.commissionPercent);
  const found = await rows<{ seller_id: string; gross: string | number; commission: string | number }>(
    `SELECT st.seller_id,
            SUM(${NET_SQL})                              AS gross,
            SUM(ROUND(${NET_SQL} * r.pct / 100.0))       AS commission
       FROM order_stores os
       JOIN orders  o   ON o.id = os.order_id
       JOIN stores  st  ON st.slug = os.store_slug
       JOIN sellers sel ON sel.id = st.seller_id
       JOIN unnest($7::text[], $8::numeric[]) AS r(tier, pct)
              ON r.tier = COALESCE(sel.tier, $9::text)
      WHERE ${RELEASABLE_SQL}
      GROUP BY st.seller_id`,
    [...releasableParams(todayISO), tiers, percents, DEFAULT_TIER],
  );
  return found.map((r) => {
    const grossAgorot = big(r.gross);
    const commissionAgorot = big(r.commission);
    return { sellerId: r.seller_id, grossAgorot, commissionAgorot, netAgorot: grossAgorot - commissionAgorot };
  });
}

/**
 * One seller's account, ready for their screen — the slices, the holds, and every sum.
 *
 * The counterpart to `getReleasableBySeller`, and the split between them is deliberate. That one
 * aggregates in SQL because it runs across every seller at once and must never load orders into
 * memory. This one is for ONE seller looking at their own page, where the per-order list IS the
 * point — "when does this release, and why" is the question the screen exists to answer, and a
 * SUM cannot answer it.
 *
 * Bounded rather than unbounded, and the bound is chosen not guessed: only orders whose money is
 * still in play. Anything already released is represented by the sums, and a seller who has traded
 * for three years does not need three years of settled slices rendered to be told what they are
 * owed today. `limit` caps the tail for a seller with an unusually large open book.
 */
export async function getSellerAccountRows(sellerId: string, limit = 500): Promise<AccountSlice[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<{
    order_id: string; store_slug: string; net: string | number;
    payment_status: Order['paymentStatus']; shipping_status: Order['shippingStatus'];
    paid_at: Date | string | null; delivered_at: Date | string | null;
  }>(
    `SELECT os.order_id, os.store_slug, ${NET_SQL} AS net,
            o.payment_status, o.shipping_status, o.paid_at, o.delivered_at
       FROM order_stores os
       JOIN orders o  ON o.id = os.order_id
       JOIN stores st ON st.slug = os.store_slug
      WHERE st.seller_id = $1
        AND o.payment_status = ANY($2::text[])
        AND o.shipping_status = ANY($3::text[])
      ORDER BY o.paid_at DESC NULLS LAST, os.order_id
      LIMIT $4`,
    [sellerId, REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES, limit],
  );
  return found.map((r) => ({
    orderId: r.order_id,
    storeSlug: r.store_slug,
    netAgorot: big(r.net),
    order: {
      paymentStatus: r.payment_status,
      shippingStatus: r.shipping_status,
      paidAt: iso(r.paid_at),
      deliveredAt: iso(r.delivered_at),
    },
  }));
}

/**
 * Everything one seller's payments screen needs, in one call and three queries.
 *
 * Assembled here rather than in the page so the seller's own view and the admin's view of the same
 * seller are literally the same function — `reporting-invariants.test.ts` exists because two
 * surfaces computing one number separately is how they came to disagree.
 */
export async function getSellerAccountFor(sellerId: string): Promise<{
  account: SellerAccount;
  payouts: SellerPayout[];
  adjustments: LedgerAdjustment[];
} | null> {
  if (!isUuid(sellerId)) return null;
  const seller = await getSellerById(sellerId);
  if (!seller) return null;

  // Independent reads, so one round trip rather than three sequential ones
  // (`project_sequential_await_latency`).
  const [slices, payouts, adjustments] = await Promise.all([
    getSellerAccountRows(sellerId),
    getPayoutsForSeller(sellerId),
    getAdjustmentsForSeller(sellerId),
  ]);

  return {
    account: buildSellerAccount(seller.tier, slices, payouts, adjustments),
    payouts,
    adjustments,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Create the payout for one seller and one period, or return null because it already exists.
 *
 * Returning null for "already there" rather than throwing is what lets the job loop over every
 * seller without a try/catch per iteration, and what makes a re-run a no-op instead of an incident.
 *
 * The journal entry is written only when a row was really created — an event log that records
 * attempts as if they were transfers is worse than no log, because it is the record a reconciliation
 * is checked AGAINST.
 */
export async function createPayout(input: {
  sellerId: string;
  periodKey: string;
  amountAgorot: number;
  /** Commission settled by THIS payout. Defaults to 0 for a manual or corrective payout that
   *  settles no commission — never guessed from the amount, because the two are not proportional
   *  once an adjustment is in play. */
  commissionAgorot?: number;
  bankSnapshot: BankSnapshot | null;
  detail?: string;
}): Promise<SellerPayout | null> {
  if (!isUuid(input.sellerId)) return null;
  // Guarded here as well as by the CHECK constraint: a zero or negative payout is a bug in the
  // caller's arithmetic, and the useful behaviour is to create nothing rather than to raise a
  // database error inside a loop over every seller on the platform.
  if (!Number.isInteger(input.amountAgorot) || input.amountAgorot <= 0) return null;

  const created = await firstRow<PayoutRow>(
    `INSERT INTO seller_payouts (seller_id, period_key, amount_agorot, commission_agorot, bank_snapshot, detail)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (seller_id, period_key) DO NOTHING
       RETURNING *`,
    [
      input.sellerId, input.periodKey, input.amountAgorot,
      Math.max(0, Math.round(input.commissionAgorot ?? 0)),
      input.bankSnapshot ?? null, input.detail ?? null,
    ],
  );
  if (!created) return null;

  const payout = toPayout(created);
  await recordMoneyEvent({
    type: 'payout_created',
    sellerId: input.sellerId,
    amountAgorot: payout.amountAgorot,
    actor: 'system',
    detail: `period=${payout.periodKey}; payout=${payout.id}`,
  });
  return payout;
}

/**
 * Move a payout along its lifecycle.
 *
 * `sent_at` is stamped on the first move to 'sent' and never cleared, the same "when did this
 * happen, not what is it now" rule as `orders.paid_at`. A payout that fails after being sent keeps
 * the timestamp: the transfer really was attempted at that moment, and that is the fact someone
 * chasing a bank will need.
 */
export async function setPayoutStatus(
  id: string,
  status: PayoutStatus,
  detail?: string,
): Promise<SellerPayout | null> {
  if (!isUuid(id)) return null;
  const updated = await firstRow<PayoutRow>(
    `UPDATE seller_payouts
        SET status  = $2,
            sent_at = CASE WHEN sent_at IS NULL AND $2 = 'sent' THEN now() ELSE sent_at END,
            detail  = COALESCE($3, detail)
      WHERE id = $1
  RETURNING *`,
    [id, status, detail ?? null],
  );
  if (!updated) return null;

  const payout = toPayout(updated);
  // Written as two literal calls rather than one call with a computed `type`, and that is not
  // style. `tests/money-owed-guards.test.ts` proves every event type in the vocabulary is actually
  // WRITTEN by some code path, by looking for the literal — a ternary is invisible to it, and the
  // guard would have reported `payout_failed` as a type nothing emits. It found exactly that here.
  // The point generalises: an event type assembled at runtime cannot be audited by reading the
  // tree, and this journal's whole value is that it can be.
  const common = {
    sellerId: payout.sellerId,
    amountAgorot: payout.amountAgorot,
    actor: 'system',
    to: status,
    detail: `period=${payout.periodKey}; payout=${payout.id}${detail ? `; ${detail}` : ''}`,
  };
  if (status === 'failed') await recordMoneyEvent({ type: 'payout_failed', ...common });
  else await recordMoneyEvent({ type: 'payout_sent', ...common });
  return payout;
}

/**
 * Record a debt against a seller — a clawback, a chargeback, a correction.
 *
 * Idempotent on (order, kind) through the partial unique index, for the same reason `createPayout`
 * is idempotent on (seller, period): a refund webhook that fires twice, or a seller cancelling an
 * order that was already cancelled, must debit once. An adjustment with no `orderId` (a manual
 * correction) is not covered by that index and is not meant to be — two deliberate corrections of
 * the same size are two corrections.
 */
export async function recordAdjustment(input: {
  sellerId: string;
  orderId?: string | null;
  kind: AdjustmentKind;
  amountAgorot: number;
  detail?: string;
}): Promise<LedgerAdjustment | null> {
  if (!isUuid(input.sellerId)) return null;
  if (!Number.isInteger(input.amountAgorot) || input.amountAgorot === 0) return null;

  const created = await firstRow<AdjustmentRow>(
    `INSERT INTO seller_ledger_adjustments (seller_id, order_id, kind, amount_agorot, detail)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id, kind) WHERE order_id IS NOT NULL DO NOTHING
       RETURNING *`,
    [input.sellerId, input.orderId ?? null, input.kind, input.amountAgorot, input.detail ?? ''],
  );
  if (!created) return null;

  const adjustment = toAdjustment(created);
  await recordMoneyEvent({
    type: 'seller_debited',
    sellerId: input.sellerId,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    amountAgorot: adjustment.amountAgorot,
    actor: 'system',
    detail: `${adjustment.kind}${adjustment.detail ? `; ${adjustment.detail}` : ''}`,
  });
  return adjustment;
}

/** Every seller with a payout in this period — the job's own "have I already run" check, used for
 *  reporting rather than for correctness, since the unique index is what actually prevents a
 *  double payment. */
export async function getPayoutsForPeriod(periodKey: string): Promise<SellerPayout[]> {
  const result = await rows<PayoutRow>(
    'SELECT * FROM seller_payouts WHERE period_key = $1 ORDER BY created_at',
    [periodKey],
  );
  return result.map(toPayout);
}

