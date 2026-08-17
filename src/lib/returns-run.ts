import { rows } from './db.js';
import { businessTodayISO } from './business-day.js';
import { getStoreBySlugOrPrevious } from './stores.js';
import { getOrderById } from './orders.js';
import { moveReturnRequest, getReturnRequest, type ReturnRequest } from './return-requests.js';
import {
  dueForAutoRefund, handoverExpired, responseOverdue,
  inTransitStale, offerUnanswered, type ReturnStatus,
} from './returns.js';
import { alertOnCriticalError } from './critical-alert.js';
import { notifySellerReturnDeadline, notifyBuyerReturnDeadline } from './return-notify.js';
import { addDaysISO } from './date-range.js';

/**
 * The returns mechanism, running itself.
 *
 * **The owner's instruction, 2026-08-16:** *"תעשה כמה שיותר אוטומטי... שלא אצטרך כל היום לבדוק את
 * הדשבורד אדמין... ולבדוק איפה אפשר לא לערב אותי בכלל"*. This module is the answer to the last
 * clause: of the eight states a case can be in, **exactly one requires a human being** — `disputed`,
 * where a seller says the parcel was empty and somebody has to decide. Every other clock closes
 * itself, on a schedule, whether or not anyone opens a screen.
 *
 * Three sweeps, and each is one of the owner's decisions turned into something that happens without
 * being asked:
 *
 *   1. **A request the seller may refuse and did not answer** → refused (decisions §3). Only outside
 *      the statutory window; inside it there was never a question to answer.
 *   2. **An approved case whose parcel was never handed over** → expired, and the seller's money
 *      stops being frozen (decisions §5). It does NOT extinguish the buyer's right — a parcel that
 *      turns up later is still refunded, through the clawback that already exists.
 *   3. **A parcel that reached the seller and sat there** → refunded (decisions §4). Counted from
 *      ARRIVAL, so a slow post or a seller on holiday never triggers it.
 *
 * ── Why it re-asks the pure functions instead of trusting a SQL WHERE ──
 * The candidate query is a cheap PREFILTER — it narrows by status and by a raw timestamp so the
 * indexes stay in the plan — and every row it returns is then put to the same predicate the seller's
 * own screen uses. A second copy of the deadline arithmetic in SQL is the shape this codebase has
 * been bitten by repeatedly, and here it would mean a case closing itself on a day the seller was
 * shown a different one.
 *
 * ── Never throws, and isolates each case ──
 * Same contract as every other job (`jobs/registry.ts`): one case whose store row has gone missing
 * must not stop the sweep for everyone else. Failures are counted and reported, not swallowed
 * silently — a sweep that reports "0 processed" while failing on all of them is the silent-failure
 * class this project has already audited once.
 */

export interface ReturnsRunResult {
  scanned: number;
  /** Requests the seller was entitled to refuse and did not answer. */
  autoRejected: number;
  /** Approved cases the buyer never sent — the seller's money is released. */
  expired: number;
  /** Parcels the seller received and left alone — the buyer is credited. */
  autoRefunded: number;
  /** Declared-sent parcels nobody could account for, handed to a person. */
  escalated: number;
  /** Sellers told today that something closes against them tomorrow. */
  warned: number;
  refundedAgorot: number;
  failed: number;
  /** Cases sitting in `disputed`, which is the ONE state a person has to resolve. Reported so the
   *  admin can be told without anyone having to look. */
  awaitingAdmin: number;
}

/** How many cases one run will act on. A sweep that tried to close ten thousand in one tick would
 *  hold its lease past the end of it; the rest are first in line next run, since the query is
 *  oldest-first and their deadlines have only got older. */
const BATCH = 200;

interface Row {
  id: string; order_id: string; store_slug: string; status: string;
  within_statutory: boolean; created_at: Date | string;
  approved_at: Date | string | null; delivered_back_at: Date | string | null;
  sent_at: Date | string | null; offered_at: Date | string | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : (typeof v === 'string' ? v : v.toISOString());

export async function runReturnsSweep(todayISO: string = businessTodayISO()): Promise<ReturnsRunResult> {
  const result: ReturnsRunResult = {
    scanned: 0, autoRejected: 0, expired: 0, autoRefunded: 0, escalated: 0, warned: 0,
    refundedAgorot: 0, failed: 0, awaitingAdmin: 0,
  };

  // Only the three states a clock can act on. `disputed` is deliberately absent: it is the human
  // one, and a sweep that closed it would be the automation deciding a dispute.
  const candidates = await rows<Row>(
    `SELECT id, order_id, store_slug, status, within_statutory, created_at, approved_at,
            delivered_back_at, sent_at, offered_at
       FROM return_requests
      WHERE status IN ('requested', 'approved', 'in_transit', 'received', 'offered')
      ORDER BY created_at ASC
      LIMIT ${BATCH}`,
  );
  result.scanned = candidates.length;

  /**
   * One sentence to the buyer, the day before a clock closes on him.
   *
   * A closure inside the sweep rather than a module function: it needs the row, the order and the
   * store, and all three are already in hand here. It reaches the buyer the same way every other
   * buyer message does — `notifyBuyerReturnStatus` — by describing the state he is ABOUT to be in,
   * because that is the sentence that is true tomorrow and the one he needs today.
   */
  const warnBuyer = async (row: Row, which: 'handover' | 'offer'): Promise<void> => {
    const order = await getOrderById(row.order_id);
    if (!order) return;
    const store = await getStoreBySlugOrPrevious(row.store_slug);
    await notifyBuyerReturnDeadline(order, which, store?.name);
  };

  for (const row of candidates) {
    const status = row.status as ReturnStatus;
    let to: ReturnStatus | null = null;

    // ── One day's warning, before anything closes against him ──
    //
    // Asked by running the SAME predicates against TOMORROW: if a case would be overdue then but is
    // not now, today is the last day he can act. That is the whole rule, and it needs no second
    // definition of a deadline — which is the mistake this codebase pays for every time it is made.
    const tomorrowISO = addDaysISO(todayISO, 1);
    if (!responseOverdue(status, row.within_statutory, iso(row.created_at)!, todayISO)
        && responseOverdue(status, row.within_statutory, iso(row.created_at)!, tomorrowISO)) {
      const store = await getStoreBySlugOrPrevious(row.store_slug);
      const req = store ? await getReturnRequest(row.id) : null;
      if (store && req) await notifySellerReturnDeadline(store.sellerId, req, 'answer');
      result.warned++;
    } else if (!dueForAutoRefund(status, iso(row.delivered_back_at), todayISO)
        && dueForAutoRefund(status, iso(row.delivered_back_at), tomorrowISO)) {
      const store = await getStoreBySlugOrPrevious(row.store_slug);
      const req = store ? await getReturnRequest(row.id) : null;
      if (store && req) await notifySellerReturnDeadline(store.sellerId, req, 'open_parcel');
      result.warned++;
    } else if (status === 'in_transit'
        && !inTransitStale(iso(row.sent_at), todayISO)
        && inTransitStale(iso(row.sent_at), tomorrowISO)) {
      // The seller's last chance to say the parcel arrived before the case stops being his. He is not
      // late and he is not accused of anything — but tomorrow WE decide it, and that is worth a day's
      // notice to the one person who can end it with a single button.
      const store = await getStoreBySlugOrPrevious(row.store_slug);
      const req = store ? await getReturnRequest(row.id) : null;
      if (store && req) await notifySellerReturnDeadline(store.sellerId, req, 'missing_parcel');
      result.warned++;
    } else if (status === 'approved'
        && !handoverExpired(iso(row.approved_at), todayISO)
        && handoverExpired(iso(row.approved_at), tomorrowISO)) {
      // ── The buyer's first warning, and the gap it closes ──
      //
      // Until now the only person this sweep ever warned was the seller, on the reasoning that the
      // handover window is "the buyer's to miss". That is true and it is not a reason: the buyer is
      // the one who loses the money, he is the party who is not in a dashboard every day, and one
      // sentence the day before is the difference between a deadline and a trap.
      await warnBuyer(row, 'handover');
      result.warned++;
    } else if (status === 'offered'
        && !offerUnanswered(iso(row.offered_at), todayISO)
        && offerUnanswered(iso(row.offered_at), tomorrowISO)) {
      await warnBuyer(row, 'offer');
      result.warned++;
    }

    if (responseOverdue(status, row.within_statutory, iso(row.created_at)!, todayISO)) {
      to = 'rejected';
    } else if (status === 'approved' && handoverExpired(iso(row.approved_at), todayISO)) {
      // ONLY from `approved`, and that is the correction. It used to include `in_transit`, so a buyer
      // who had said he sent it still lost the case on day 7 — the clock deciding a factual dispute
      // in favour of whoever stayed silent. A buyer who never even claimed to send it is a different
      // matter: nothing was said and nothing was sent, and the money belongs with the sale.
      to = 'expired';
    } else if (status === 'in_transit' && inTransitStale(iso(row.sent_at), todayISO)) {
      // Neither side can prove anything and both have had a fortnight. A person decides — never an
      // automatic refund, which would make the buyer's word into proof, and never an expiry, which
      // would make the seller's silence into a defence.
      to = 'disputed';
    } else if (status === 'offered' && offerUnanswered(iso(row.offered_at), todayISO)) {
      // An offer nobody answered was freezing the case and that order's payout forever. Expiring it
      // releases the money and takes nothing from the buyer: their statutory right is untouched and
      // they may open a fresh request.
      to = 'expired';
    } else if (dueForAutoRefund(status, iso(row.delivered_back_at), todayISO)) {
      to = 'refunded';
    }
    if (!to) continue;

    try {
      const store = await getStoreBySlugOrPrevious(row.store_slug);
      if (!store) { result.failed++; continue; }
      const moved = await moveReturnRequest({
        id: row.id, to, actor: 'system',
        store: { slug: store.slug, name: store.name, sellerId: store.sellerId },
        sellerNote: to === 'rejected'
          ? 'נסגרה אוטומטית: לא התקבלה תשובה מהמוכר בתוך המועד'
          : undefined,
      });
      if ('error' in moved) { result.failed++; continue; }

      if (to === 'rejected') result.autoRejected++;
      if (to === 'expired') result.expired++;
      if (to === 'disputed') result.escalated++;
      if (to === 'refunded') {
        result.autoRefunded++;
        result.refundedAgorot += moved.request.refundAgorot;
      }
    } catch {
      // One broken case must not end the sweep for the rest — the job contract in
      // `jobs/registry.ts`. Counted rather than swallowed, so a run that fails on everything says so.
      result.failed++;
    }
  }

  // ── The one thing that reaches a person, and only when it has to ──
  //
  // A dispute cannot be closed by a clock — somebody has to decide whether the parcel was really
  // empty. So this is where the owner is told, by mail, instead of being expected to open a
  // dashboard: the sweep already knows the number, and `critical-alert.ts` already owns the
  // rate-limiting that stops a standing condition from mailing every single day.
  //
  // Nothing else here alerts. An auto-rejection, an expiry and an automatic refund are the
  // mechanism working exactly as decided, and a mail per working day is how a person learns to
  // filter the sender — which would cost us the one message that matters.
  // Counted AFTER the loop, and that ordering is the fix rather than a tidy-up: it used to be read
  // first, so a case the sweep escalated in this very run was not in the number, and the owner learned
  // about it a day late — on the one path where nothing else will ever tell him.
  const disputed = await rows<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM return_requests WHERE status = 'disputed'`,
  );
  result.awaitingAdmin = disputed[0]?.n ?? 0;

  if (result.awaitingAdmin > 0) {
    await alertOnCriticalError({
      createdAt: new Date().toISOString(),
      route: 'returns:dispute',
      severity: 'critical',
      message: `${result.awaitingAdmin} בקשות החזר ממתינות להכרעה שלך`,
      // Three ways in, and the hint names all three — it used to name only the first, which would
      // have sent the owner looking for an empty-parcel claim on a case that never had one.
      resolutionHint: 'מקרה מגיע להכרעה שלך בשלוש דרכים: מוכר שטוען שהחבילה חזרה ריקה או משומשת, '
        + 'קונה שמסר שהוא שלח את המוצר ואיש לא אישר שהוא הגיע, וקונה שמבקש לבדוק סירוב של מוכר. '
        + 'אלה המצבים היחידים במנגנון שאף שעון לא סוגר — הכסף עצור עד שתכריע. '
        + 'הרשימה נמצאת בלשונית ההחזרות באדמין.',
    });
  }

  return result;
}

/** Everything a case needs to be shown, for the surfaces that list them. Re-exported so a screen
 *  never has to import both this module and the store. */
export type { ReturnRequest };
