import { rows } from './db.js';
import { businessTodayISO } from './business-day.js';
import { addDaysISO } from './date-range.js';
import { fulfilmentStatus, type FulfilmentState } from './order-sla.js';
import { moveOrderStatus } from './order-status-change.js';
import { getOrderById } from './orders.js';
import { createNotification, existingNotificationRelatedIds } from './notifications.js';
import {
  REVENUE_PAYMENT_STATUSES,
  REVENUE_SHIPPING_STATUSES,
  PAYOUT_CLOCK_SHIPPING_STATUSES,
  PICKUP_PAYOUT_CLOCK_SHIPPING_STATUSES,
} from './order-status-rules.js';
import { SHIP_WARNING_DAYS, SHIP_AUTO_CANCEL_DAYS } from './payout-schedule.js';
import { formatBusinessDayLabel } from './format-date.js';
import type { Order } from './orders.js';
import type { DeliveryMethod } from './shipping.js';

/**
 * The job that acts on `order-sla.ts` — warns a late seller, and cancels an order they never sent.
 *
 * ── The hole this closes, stated plainly ──
 * `payout-hold.ts` refuses to release money for an order the seller never shipped. That was right
 * and it was half an answer: the buyer's money then sat with the platform **indefinitely** — not
 * paid out, not refunded, and no screen anywhere naming it. The rule for when that becomes
 * unacceptable was written and tested (`order-sla.ts`) and **nothing called it**. This is the
 * caller. GO_LIVE §5.0-ב.
 *
 * ── Why it does not re-implement the cancellation ──
 * It calls `order-status-change.ts#moveOrderStatus`, the same path the seller's own dashboard goes
 * through. That module was extracted for this job specifically: an automatic cancel that restocked
 * but recorded no `refund_due`, or recorded one but left the units off the shelf, would be a second
 * definition of what a cancellation means — on stock and on money, which are the two things the
 * platform cannot afford to have two opinions about.
 *
 * ── Idempotent, and by construction rather than by control flow ──
 * A cancelled order is excluded by `REVENUE_SHIPPING_STATUSES` on the next pass, so it is not even
 * a candidate; if a race got one through, `canTransition` refuses a move out of a terminal status.
 * The warning is deduplicated against the seller's own notification feed — the notification IS the
 * record, the same arrangement `merchant-status-check.ts` uses, and it needs no table of its own.
 *
 * ── SQL narrows, JS decides ──
 * The `WHERE` below is a NECESSARY condition for being late, never the rule itself: it exists so
 * the job reads a handful of rows instead of every order ever placed. `fulfilmentStatus` is what
 * says warn/overdue, exactly as `payout-hold.ts` splits the same way — and here it is the easier
 * half, because a candidate the SQL lets through and the rule rejects simply costs nothing.
 */

/** How many late orders one pass may act on. The cap is announced in the run's line rather than
 *  applied quietly — a job that silently truncates reads as "nothing left to do". */
const SLA_BATCH = 200;

export interface OrderSlaRunResult {
  /** Candidates the query returned. */
  scanned: number;
  /** Sellers told their order is late. Excludes the ones already told. */
  warned: number;
  /** Orders cancelled and restocked, with the buyer's refund obligation recorded. */
  cancelled: number;
  /** Total owed back to buyers by this run, in agorot. */
  refundOwedAgorot: number;
  /** Candidates that raised — one bad order must never stop the rest. */
  failed: number;
  /** True when the batch cap was reached, so the caller can say so. */
  capped: boolean;
}

interface CandidateRow {
  order_id: string;
  store_slug: string;
  store_name: string;
  seller_id: string;
  delivery_method: DeliveryMethod | null;
  payment_status: Order['paymentStatus'];
  shipping_status: Order['shippingStatus'];
  paid_at: Date | string | null;
  delivered_at: Date | string | null;
}

interface Candidate {
  orderId: string;
  store: { slug: string; name: string; sellerId: string };
  state: FulfilmentState;
  dueDayISO: string | null;
  cancelDayISO: string | null;
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Orders that MIGHT be late, newest deadline last so the most overdue is acted on first.
 *
 * The prefilter subtracts a day from `SHIP_WARNING_DAYS` on purpose. The clock the rule runs on is
 * the BUSINESS calendar (`business-day.ts`) and this comparison is on a raw `timestamptz`, so the
 * two disagree by up to a few hours around a boundary — Israel is UTC+2/+3. Erring wide costs one
 * extra row that `fulfilmentStatus` then answers `ok` for; erring narrow silently skips a seller's
 * deadline for a day, which is the kind of drift nobody ever notices.
 */
export async function getSlaCandidates(limit = SLA_BATCH, todayISO = businessTodayISO()): Promise<Candidate[]> {
  const found = await rows<CandidateRow>(
    `SELECT os.order_id, os.store_slug, os.delivery_method,
            st.name AS store_name, st.seller_id,
            o.payment_status, o.shipping_status, o.paid_at, o.delivered_at
       FROM order_stores os
       JOIN orders o  ON o.id = os.order_id
       JOIN stores st ON st.slug = os.store_slug
      WHERE o.payment_status = ANY($1::text[])
        AND o.shipping_status = ANY($2::text[])
        -- The seller has NOT yet reached their own milestone. Same CASE as the payout rule's SQL
        -- half (payout-hold.ts) and for the same reason: a collected order never passes through
        -- 'shipped', so 'ready' is its milestone. A NULL delivery_method is NULL = 'pickup', i.e.
        -- not true, so orders predating the field take the stricter courier list — which here means
        -- they stay candidates a status longer, the safe direction for a warning.
        AND NOT (o.shipping_status = ANY(
              CASE WHEN os.delivery_method = 'pickup' THEN $4::text[] ELSE $3::text[] END))
        AND o.paid_at IS NOT NULL
        AND o.paid_at <= now() - make_interval(days => $5::int)
      ORDER BY o.paid_at
      LIMIT $6`,
    [
      REVENUE_PAYMENT_STATUSES,
      REVENUE_SHIPPING_STATUSES,
      PAYOUT_CLOCK_SHIPPING_STATUSES,
      PICKUP_PAYOUT_CLOCK_SHIPPING_STATUSES,
      Math.max(0, SHIP_WARNING_DAYS - 1),
      limit,
    ],
  );

  const candidates: Candidate[] = [];
  for (const row of found) {
    const status = fulfilmentStatus({
      paymentStatus: row.payment_status,
      shippingStatus: row.shipping_status,
      paidAt: iso(row.paid_at),
      deliveredAt: iso(row.delivered_at),
      deliveryMethod: row.delivery_method,
    }, todayISO);
    if (status.state === 'ok') continue;
    candidates.push({
      orderId: row.order_id,
      store: { slug: row.store_slug, name: row.store_name, sellerId: row.seller_id },
      state: status.state,
      dueDayISO: status.dueDayISO,
      cancelDayISO: status.cancelDayISO,
    });
  }
  return candidates;
}

/** The dedup key for "I have already told this seller their order is late". Prefixed rather than
 *  the bare order id, because a `new_order` notification already carries that value and a lookback
 *  window would match it — the seller would be warned about nothing, once, and never again. */
function lateKey(orderId: string): string {
  return `sla-late:${orderId}`;
}

/**
 * Warn, cancel, and report.
 *
 * `todayISO` is a parameter with a default for the same reason `orderHold` and `fulfilmentStatus`
 * take one: the job, a dry run and a test must be able to ask about the same day.
 */
export async function runOrderSla(todayISO: string = businessTodayISO()): Promise<OrderSlaRunResult> {
  const result: OrderSlaRunResult = {
    scanned: 0, warned: 0, cancelled: 0, refundOwedAgorot: 0, failed: 0, capped: false,
  };

  const candidates = await getSlaCandidates(SLA_BATCH, todayISO);
  result.scanned = candidates.length;
  result.capped = candidates.length === SLA_BATCH;

  // One query for every "have I already said this", rather than one per order. The window is the
  // warn period itself — a warning older than the auto-cancel deadline cannot belong to an order
  // that is still a candidate, so a longer lookback would only suppress a warning that ought to
  // fire again.
  const warnable = candidates.filter((c) => c.state === 'warn');
  const alreadyWarned = warnable.length
    ? await existingNotificationRelatedIds(warnable.map((c) => lateKey(c.orderId)), `${addDaysISO(todayISO, -SHIP_AUTO_CANCEL_DAYS)}T00:00:00.000Z`)
    : new Set<string>();

  for (const candidate of candidates) {
    try {
      if (candidate.state === 'warn') {
        if (alreadyWarned.has(lateKey(candidate.orderId))) continue;
        await createNotification({
          userId: candidate.store.sellerId,
          role: 'seller',
          type: 'order_update',
          title: 'הזמנה ממתינה לשליחה',
          // The date is what makes it actionable: a seller told "late" and not "cancelled on the
          // 24th" has been told to hurry without being told by when. It is the rule's OWN
          // `cancelDayISO`, never re-derived here — the same day the cancellation will use.
          body: `הזמנה בחנות ${candidate.store.name} עדיין לא נשלחה. אם לא תישלח עד ${formatBusinessDayLabel(candidate.cancelDayISO ?? todayISO)} היא תבוטל והכסף יוחזר לקונה.`,
          relatedId: lateKey(candidate.orderId),
          storeSlug: candidate.store.slug,
          storeName: candidate.store.name,
        });
        result.warned++;
        continue;
      }

      // Overdue. The full order is read here rather than in the candidate query because the
      // cancellation needs every item to put back on the shelf, and loading them for the warn case
      // (much the commoner one) would be a join paid for nothing.
      const order = await getOrderById(candidate.orderId);
      if (!order) { result.failed++; continue; }

      const moved = await moveOrderStatus({
        order,
        to: 'cancelled',
        store: candidate.store,
        actor: 'system',
        detail: `בוטלה אוטומטית: החנות ${candidate.store.slug} לא מסרה את ההזמנה תוך ${SHIP_AUTO_CANCEL_DAYS} ימים מהתשלום. לקונה מגיע הסכום המלא, בלי דמי ביטול.`,
      });
      if (!moved.ok) { result.failed++; continue; }

      result.cancelled++;
      result.refundOwedAgorot += moved.outcome.refundOwedAgorot;

      // The seller is told too. The buyer already is — `moveOrderStatus` runs the same notification
      // pipeline a manual cancellation does — but nothing else would tell the seller that an order
      // left their dashboard, and finding out by noticing it missing is not a state to leave anyone
      // in. Failure is swallowed: the cancellation and the refund obligation both stand.
      await createNotification({
        userId: candidate.store.sellerId,
        role: 'seller',
        type: 'order_update',
        title: 'הזמנה בוטלה אוטומטית',
        body: `הזמנה בחנות ${candidate.store.name} לא נשלחה בזמן ובוטלה. הפריטים חזרו למלאי והכסף מוחזר לקונה.`,
        relatedId: candidate.orderId,
        storeSlug: candidate.store.slug,
        storeName: candidate.store.name,
      }).catch(() => null);
    } catch {
      // One order that cannot be read, cancelled or announced must not stop the rest of the
      // platform's late orders from being handled — the same isolation every per-store job in the
      // registry applies. The count is what the run reports.
      result.failed++;
    }
  }

  return result;
}
