/**
 * What "34%" means on the leading-products list, in one place.
 *
 * It is a share of `productRevenueAgorot` — the gross revenue of EVERY product that sold in the
 * period (seller-performance.ts). It used to be a share of the five products on screen, which made
 * those five add to 100% by construction: the top seller read as a third of the platform whether
 * the tail behind it was two products or two thousand.
 *
 * Four surfaces draw this row — the admin's platform panel, the admin's per-store page, the
 * seller's own tab and the client re-render they all share — so the arithmetic AND the wording of
 * the small-share case live here rather than being typed out four times and drifting.
 */

export interface ProductShare {
  /** 0–100, rounded — the bar's width and the number on it. */
  pct: number;
  /** What to print. `<1%` rather than `0%` for a real but tiny share: a row showing 0% beside a
   *  four-figure revenue reads as a broken number, which is the opposite of what this list is for. */
  label: string;
}

export function productShare(revenueAgorot: number, totalAgorot: number): ProductShare {
  // A 0 total only happens with an empty list (nothing to divide) or a refunded-to-zero period;
  // either way there is no share to state, and dividing by a floor of 1 agora would print 0%.
  //
  // `!Number.isFinite` is not defensive typing — it is the ZERO-DOWNTIME DEPLOY case, and it is a
  // real few seconds: during a rollout a NEW client can be handed an OLD `/api/*` summary, which
  // has no `productRevenueAgorot` at all. Untreated that is `x / undefined` → `NaN`, and the row
  // renders `width:NaN%` with "NaN%" printed on it. 0% is wrong for one paint; NaN looks broken.
  if (!Number.isFinite(totalAgorot) || !Number.isFinite(revenueAgorot)) return { pct: 0, label: '0%' };
  if (totalAgorot <= 0 || revenueAgorot <= 0) return { pct: 0, label: '0%' };
  const exact = (revenueAgorot / totalAgorot) * 100;
  const pct = Math.round(exact);
  return { pct, label: pct < 1 ? '<1%' : `${pct}%` };
}
