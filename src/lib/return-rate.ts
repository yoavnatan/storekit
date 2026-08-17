import { rows } from './db.js';
import { REVENUE_PAYMENT_STATUSES } from './order-status-rules.js';

/**
 * Which shops are having far more returns than everyone else — the admin's only signal about
 * quality, and deliberately the weakest one that could work (decisions §8).
 *
 * **The owner's answer was "התראה לאדמין בלבד. בלי אזהרה אוטומטית ובלי חסימה"**, and that is the
 * whole design. A high return rate is not misconduct: it is a category (clothing returns more than
 * kettles, everywhere), a new shop with four sales, or one genuinely bad batch. Every automatic
 * consequence built on it would fire on all three.
 *
 * ── Why a floor of orders before a rate means anything ──
 * One return out of two orders is 50% and says nothing at all. The floor is what stops a brand-new
 * shop being flagged for its first unlucky week — which is precisely the shop least able to argue
 * with it, and the one this platform exists to make possible.
 *
 * ── Why it is compared against the PLATFORM, not against a fixed number ──
 * A threshold like "20%" is a guess that ages: it is wrong for a swimwear shop from the day it is
 * written, and it stops meaning anything as the catalogue's mix changes. A shop that returns three
 * times what the platform does is unusual by the only standard that stays true — the platform
 * itself, this month.
 */

/** Below this many delivered orders a rate is noise, not a signal. */
export const RETURN_RATE_MIN_ORDERS = 20;

/** How many times the platform's own rate counts as unusual. */
export const RETURN_RATE_MULTIPLE = 3;

/** Below this many returns, "most of them were contested" is one or two cases. */
export const DISPUTE_MIN_RETURNS = 5;

/** Contesting this share of the returns received is what counts as habitual. */
export const DISPUTE_RATE_THRESHOLD = 0.5;

export interface StoreReturnRate {
  storeSlug: string;
  /** Orders that actually reached the buyer — the only ones a return could ever come from. */
  deliveredOrders: number;
  returns: number;
  /** 0–1. `returns / deliveredOrders`. */
  rate: number;
  /** How many of this shop's returns the seller DISPUTED — "the parcel came back empty".
   *
   *  **This is the brake on the one accusation the mechanism cannot verify** (owner, 2026-08-17:
   *  *"זה בסדר? לא מזמין בעיות?"*). A seller must be able to say a parcel came back empty, or a
   *  seller who was really defrauded has no recourse and starts refusing every return outright. But
   *  the claim costs him nothing to make, lands on a person, and stops the buyer's money — so
   *  something has to be able to see a shop that makes it habitually. Nothing did.
   *
   *  Counted, never acted on: same decision as the return rate itself. */
  disputes: number;
  /** 0–1. `disputes / returns` — of the returns this shop had, how many it contested. */
  disputeRate: number;
}

export interface ReturnRateReport {
  /** Every shop past the floor, worst first. */
  stores: StoreReturnRate[];
  /** The whole platform's rate, which is what "unusual" is measured against. */
  platformRate: number;
  /** The shops at or above `RETURN_RATE_MULTIPLE ×` the platform's rate. */
  outliers: StoreReturnRate[];
  /** Shops contesting most of the returns they receive — the brake on the one accusation nothing can
   *  verify. Separate from `outliers` because it is a different problem with a different answer: a
   *  high return rate is usually the product, a high dispute rate is usually the shop. */
  disputeOutliers: StoreReturnRate[];
}

/**
 * One query, and it deliberately counts REQUESTS rather than refunds.
 *
 * A request that was refused or that lapsed still says something about the product: the buyer wanted
 * it gone. Counting only refunds would measure how generous each seller is, which is a different
 * question and one the platform has no business scoring.
 */
export async function returnRateByStore(): Promise<ReturnRateReport> {
  const r = await rows<{ store_slug: string; delivered: string | number; returns: string | number; disputes: string | number }>(
    `SELECT os.store_slug,
            COUNT(DISTINCT o.id)  AS delivered,
            COUNT(DISTINCT rr.id) AS returns,
            COUNT(DISTINCT rr.id) FILTER (WHERE rr.status = 'disputed' OR rr.seller_note <> '') AS disputes
       FROM order_stores os
       JOIN orders o ON o.id = os.order_id
       LEFT JOIN return_requests rr ON rr.order_id = o.id
      WHERE o.payment_status = ANY($1::text[])
        AND o.delivered_at IS NOT NULL
      GROUP BY os.store_slug`,
    [REVENUE_PAYMENT_STATUSES],
  );

  const stores: StoreReturnRate[] = r
    .map((row) => {
      const deliveredOrders = Number(row.delivered);
      const returns = Number(row.returns);
      const disputes = Number(row.disputes ?? 0);
      return {
        storeSlug: row.store_slug,
        deliveredOrders,
        returns,
        rate: deliveredOrders > 0 ? returns / deliveredOrders : 0,
        disputes,
        // Out of this shop's own RETURNS, not out of its orders: the question is "when goods come
        // back, how often does this shop say something was wrong with them", and dividing by orders
        // would make a shop with few returns look clean for contesting all of them.
        disputeRate: returns > 0 ? disputes / returns : 0,
      };
    })
    .filter((s) => s.deliveredOrders >= RETURN_RATE_MIN_ORDERS)
    .sort((a, b) => b.rate - a.rate);

  const totalDelivered = stores.reduce((n, s) => n + s.deliveredOrders, 0);
  const totalReturns = stores.reduce((n, s) => n + s.returns, 0);
  const platformRate = totalDelivered > 0 ? totalReturns / totalDelivered : 0;

  // A platform with no returns at all has no baseline to be a multiple of, and every shop with one
  // return would be infinitely above it. Below that, nothing is an outlier — which is correct: there
  // is nothing yet to be unusual against.
  const outliers = platformRate > 0
    ? stores.filter((s) => s.rate >= platformRate * RETURN_RATE_MULTIPLE)
    : [];

  // A shop that contested more than half the returns it received, with enough of them for that to
  // mean anything. Deliberately a flat threshold and not a multiple of the platform: "most of them"
  // is the claim being made, and it is the same claim whatever everyone else does.
  const disputeOutliers = stores.filter((s) => s.returns >= DISPUTE_MIN_RETURNS
    && s.disputeRate >= DISPUTE_RATE_THRESHOLD);

  return { stores, platformRate, outliers, disputeOutliers };
}
