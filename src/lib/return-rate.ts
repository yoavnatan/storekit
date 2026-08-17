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

export interface StoreReturnRate {
  storeSlug: string;
  /** Orders that actually reached the buyer — the only ones a return could ever come from. */
  deliveredOrders: number;
  returns: number;
  /** 0–1. `returns / deliveredOrders`. */
  rate: number;
}

export interface ReturnRateReport {
  /** Every shop past the floor, worst first. */
  stores: StoreReturnRate[];
  /** The whole platform's rate, which is what "unusual" is measured against. */
  platformRate: number;
  /** The shops at or above `RETURN_RATE_MULTIPLE ×` the platform's rate. */
  outliers: StoreReturnRate[];
}

/**
 * One query, and it deliberately counts REQUESTS rather than refunds.
 *
 * A request that was refused or that lapsed still says something about the product: the buyer wanted
 * it gone. Counting only refunds would measure how generous each seller is, which is a different
 * question and one the platform has no business scoring.
 */
export async function returnRateByStore(): Promise<ReturnRateReport> {
  const r = await rows<{ store_slug: string; delivered: string | number; returns: string | number }>(
    `SELECT os.store_slug,
            COUNT(DISTINCT o.id)  AS delivered,
            COUNT(DISTINCT rr.id) AS returns
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
      return {
        storeSlug: row.store_slug,
        deliveredOrders,
        returns,
        rate: deliveredOrders > 0 ? returns / deliveredOrders : 0,
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

  return { stores, platformRate, outliers };
}
