import { rows, query } from './db.js';
import { getOrderById, type Order } from './orders.js';
import { REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES } from './order-status-rules.js';
import { orderIsReviewable } from './review-eligibility.js';
import { sendReviewInviteEmail } from './email/review-invite-email.js';

/**
 * The job that asks buyers how it was.
 *
 * ── Why a job and not a hook on the status change ──
 * The moment a seller presses "נשלח" is the moment the parcel LEAVES, not the moment it arrives.
 * Asking then produces an invitation that lands days before the product does, which is both useless
 * and the kind of mail that teaches a person to ignore the sender. So the invitation waits — see
 * `REVIEW_INVITE_DELAY_DAYS` — and something has to be awake to send it later.
 *
 * ── Idempotent ──
 * `orders.review_invited_at` is stamped before the send and is the query's own filter (migration
 * 0034), so a second pass over the same order is not even a candidate. The migration argues why the
 * stamp goes before the send and not after.
 *
 * ── SQL narrows, the table decides ──
 * The `WHERE` is a NECESSARY condition, chosen so the job reads a handful of rows rather than every
 * order ever placed; `orderIsReviewable` is what actually decides, from the same status table both
 * screens and the API read. Same split as `order-sla-run.ts`, for the same reason: a candidate the
 * SQL admits and the rule rejects costs nothing, while a rule spelled twice drifts.
 *
 * ── It never throws ──
 * One unreachable mailbox must not stop the other ninety-nine (`jobs/registry.ts` requires this of
 * everything it lists), so each order is isolated and the run reports counts.
 */

/**
 * How long after an order becomes reviewable the invitation goes out.
 *
 * Measured from `updated_at`, i.e. from the status change that made it reviewable — `shipped` for a
 * courier order, `delivered` for a collected one. Five days is a delivery time plus a day to open
 * the box, and it is deliberately generous: an invitation that arrives too early gets ignored once
 * and the buyer is never asked again.
 *
 * ⚠️ A guess until real delivery times exist. It is the same class of number as the hold periods in
 * `payout-schedule.ts` and should be revisited against the carrier's actual transit times once one
 * is connected (GO_LIVE §5) — not a placeholder that blocks anything, but not a measured value
 * either.
 */
export const REVIEW_INVITE_DELAY_DAYS = 5;

/** How many invitations one pass may send. Announced in the run's line rather than applied
 *  quietly — a job that truncates in silence reads as "nothing left to do". */
const INVITE_BATCH = 200;

export interface ReviewInviteRunResult {
  scanned: number;
  sent: number;
  skipped: number;
  /** The batch was full, so more are waiting. Said out loud in the run's line. */
  capped: boolean;
}

export async function runReviewInvites(nowMs: number = Date.now()): Promise<ReviewInviteRunResult> {
  const cutoff = new Date(nowMs - REVIEW_INVITE_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const candidates = await rows<{ id: string }>(
    `SELECT id FROM orders
      WHERE review_invited_at IS NULL
        AND updated_at <= $1
        AND payment_status = ANY($2)
        AND shipping_status = ANY($3)
      ORDER BY updated_at
      LIMIT $4`,
    [cutoff, REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES, INVITE_BATCH],
  );

  let sent = 0;
  let skipped = 0;
  for (const { id } of candidates) {
    let order: Order | null;
    try {
      order = await getOrderById(id);
    } catch {
      // A row that cannot be read this minute is left un-stamped and picked up next pass.
      skipped++;
      continue;
    }
    if (!order || !orderIsReviewable(order)) { skipped++; continue; }

    // Stamped first, and only for a row still un-stamped — so two overlapping runs cannot both
    // claim the same order. The affected-row count IS the claim, the same shape `decrementStock`
    // uses for the same reason.
    const claim = await query(
      'UPDATE orders SET review_invited_at = now() WHERE id = $1 AND review_invited_at IS NULL',
      [id],
    );
    if (claim.rowCount === 0) { skipped++; continue; }

    if (await sendReviewInviteEmail(order)) sent++;
    else skipped++;
  }

  return { scanned: candidates.length, sent, skipped, capped: candidates.length === INVITE_BATCH };
}

/** The one line the job records. The cap is SAID rather than applied quietly. */
export function reviewInviteRunLine(result: ReviewInviteRunResult): string {
  return `scanned ${result.scanned} · sent ${result.sent} · skipped ${result.skipped}`
    + (result.capped ? ` · capped at ${INVITE_BATCH}, the rest go next run` : '');
}
