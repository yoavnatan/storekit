import { rows, query } from './db.js';
import { getOrderById, type Order } from './orders.js';
import { REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES } from './order-status-rules.js';
import { orderIsReviewable } from './review-eligibility.js';
import { sendReviewInviteEmail } from './email/review-invite-email.js';
import { hasOpenReturn } from './return-requests.js';
// The two numbers live in a file with no imports, because a PAGE reads them too — see there.
import {
  REVIEW_INVITE_DAYS_AFTER_DELIVERY, REVIEW_INVITE_DAYS_AFTER_DISPATCH,
  REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT,
} from './review-timing.js';

/**
 * The job that asks buyers how it was.
 *
 * ── Why a job and not a hook on the status change ──
 * The moment a seller presses "נשלח" is the moment the parcel LEAVES, not the moment it arrives.
 * Asking then produces an invitation that lands days before the product does, which is both useless
 * and the kind of mail that teaches a person to ignore the sender. So the invitation waits — see
 * the constants below — and something has to be awake to send it later.
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

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runReviewInvites(nowMs: number = Date.now()): Promise<ReviewInviteRunResult> {
  const cutoff = (days: number) => new Date(nowMs - days * DAY_MS).toISOString();
  const deliveredCutoff = cutoff(REVIEW_INVITE_DAYS_AFTER_DELIVERY);
  const dispatchCutoff = cutoff(REVIEW_INVITE_DAYS_AFTER_DISPATCH);
  const paidCutoff = cutoff(REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT);

  // **The three clocks are EXCLUSIVE, not alternatives** — a `CASE` ladder, never an `OR`. Each one
  // knows more than the one below it, so the best available column decides alone and the others
  // stop applying (`review-timing.ts` ranks them). An `OR` would let the most patient clock fire
  // for an order we know arrived this morning; a `COALESCE` into one column has the same fault from
  // the other side, since the three deadlines are different lengths on purpose.
  const candidates = await rows<{ id: string }>(
    `SELECT id FROM orders
      WHERE review_invited_at IS NULL
        AND payment_status = ANY($4)
        AND shipping_status = ANY($5)
        AND (CASE WHEN delivered_at IS NOT NULL THEN delivered_at <= $1
                  WHEN shipped_at   IS NOT NULL THEN shipped_at   <= $2
                  ELSE paid_at IS NOT NULL AND paid_at <= $3 END)
      ORDER BY COALESCE(delivered_at, shipped_at, paid_at)
      LIMIT $6`,
    [deliveredCutoff, dispatchCutoff, paidCutoff,
     REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES, INVITE_BATCH],
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

    // **A buyer with an open case is not asked how it was** (owner, 2026-08-17). The status columns
    // cannot see this: a return sits in its own table and does not move the ORDER until it is
    // refunded, so an order whose parcel never arrived — the buyer has already told us so, under
    // reason `not_arrived` — still satisfies every clock above. "איך היה?" landing in that inbox is
    // the platform asking a frustrated person to rate a product they never received, and the star
    // it earns is about us rather than about the goods.
    //
    // Left UN-stamped on purpose: the case will close, and when it does this order becomes an
    // ordinary one that deserves the question. Skipping is not the same as deciding never to ask.
    if (await hasOpenReturn(id)) { skipped++; continue; }

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
