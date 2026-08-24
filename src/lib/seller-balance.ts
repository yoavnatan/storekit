import type { Seller } from './seller-auth.js';
import type { StoreRevenue } from './order-reporting.js';
import { blendedCommissionRate, commissionOnAgorot } from './pricing.js';
import { commissionPercentForStore } from './store-plan.js';

/**
 * What each seller has EARNED — the reporting view named in AI_INSTRUCTIONS.md's data models and in
 * GO_LIVE_CHECKLIST.md §3, and the two words in its description do all the work: **reporting only.**
 *
 * The platform never holds a seller's money. Each seller has a sub-merchant account with the
 * payment processor, which splits every charge at checkout — the seller's share to the seller, the
 * commission to us — because holding and disbursing seller funds would make this a regulated PSP
 * service in Israel rather than a software layer (AI_INSTRUCTIONS → Payment architecture). So there
 * is no payout queue, nothing here is ever marked "paid", and no admin action follows from this
 * number. It answers one question: how much has this seller earned through the mall.
 *
 * **Derived, never stored, and that is the decision worth defending.** A `seller_balances` table
 * would be a second place the same fact lives, and the two would drift the first time an order was
 * cancelled, refunded or repointed at a renamed store — this repo has a whole test file
 * (`reporting-invariants.test.ts`) about numbers that disagree across surfaces. Here the balance is
 * a function of orders, and there is exactly one way to be wrong about it.
 *
 * **What it is NOT net of: the monthly subscription fee.** The tier model is a fixed monthly fee
 * PLUS a per-sale commission, charged additively and never offset (lib/pricing.ts). The fee is
 * billed to the seller's card, not withheld from their sales, so subtracting it here would report a
 * balance the processor will not pay. Only the commission comes out.
 *
 * Every figure is integer agorot, like every other sum in this codebase (§7.7). The canonical model
 * line writes `totalEarned`; the field is `totalEarnedAgorot` for the same reason
 * `StoreRevenue.totalRevenueAgorot` is — the unit belongs in the name.
 */

/** One store's accrual for its owner. */
export interface SellerStoreBalance {
  storeId: string;
  storeSlug: string;
  storeName: string;
  /** Net subtotals of this store's revenue-counting orders, all time — the same basis and the same
   *  query every other per-store revenue figure on the platform reads (`order-reporting.ts`). */
  grossRevenueAgorot: number;
  /** The platform's cut, at the OWNING SELLER's tier rate. */
  commissionAgorot: number;
  /** gross − commission: what the processor pays the seller for this store. */
  totalEarnedAgorot: number;
}

/** One seller's accrual across every store they own. */
export interface SellerBalance {
  sellerId: string;
  /** The rate his own revenue actually produced, revenue-weighted across his stores' plans — see
   *  where it is computed. Carried so a surface can label the commission line without re-deriving
   *  it, and so the number and its explanation cannot come from different places. It is NOT any one
   *  plan's percent: a seller with shops on two plans has no single rate. */
  commissionRate: number;
  grossRevenueAgorot: number;
  commissionAgorot: number;
  totalEarnedAgorot: number;
  /** Per store, in the order the caller supplied the stores. */
  stores: SellerStoreBalance[];
}

/**
 * Sellers + their stores + all-time revenue per store slug → one balance per seller.
 *
 * Pure, and it takes the revenue map rather than reading it, because every caller already holds
 * one: the admin dashboard reads `getStoreRevenueBySlug` for the seller cards before this is
 * reached, so the balance costs no query at all. It also means the balance and the revenue figure
 * printed beside it are literally the same number rather than two reads that could disagree.
 *
 * **Commission is per store, then summed — not the seller's rate applied to their total.** For one
 * seller those are the same (all their stores share their account's tier), and writing it this way
 * is what keeps it correct if a rate ever becomes per-store: the rounding then happens where the
 * rate does. Same reasoning platform-performance.ts records for the platform total.
 */
export function buildSellerBalances(
  sellers: readonly Seller[],
  stores: ReadonlyArray<{ id: string; slug: string; name: string; sellerId: string; tier?: string }>,
  revenueBySlug: ReadonlyMap<string, StoreRevenue>,
): SellerBalance[] {
  const storesBySeller = new Map<string, Array<{ id: string; slug: string; name: string; tier?: string }>>();
  for (const store of stores) {
    const list = storesBySeller.get(store.sellerId) ?? [];
    list.push(store);
    storesBySeller.set(store.sellerId, list);
  }

  return sellers.map((seller) => {
    const storeBalances = (storesBySeller.get(seller.id) ?? []).map((store): SellerStoreBalance => {
      const grossRevenueAgorot = revenueBySlug.get(store.slug)?.totalRevenueAgorot ?? 0;
      // The rate of the STORE's own plan, not the account's — a seller may hold two shops on two
      // plans since 2026-08-24 (`store-plan.ts`), and a single rate applied across them would
      // report one of the two wrong in every figure derived from here.
      const commissionAgorot = commissionOnAgorot(grossRevenueAgorot, commissionPercentForStore(store));
      return {
        storeId: store.id,
        storeSlug: store.slug,
        storeName: store.name,
        grossRevenueAgorot,
        commissionAgorot,
        totalEarnedAgorot: grossRevenueAgorot - commissionAgorot,
      };
    });

    const grossRevenueAgorot = storeBalances.reduce((sum, s) => sum + s.grossRevenueAgorot, 0);
    const commissionAgorot = storeBalances.reduce((sum, s) => sum + s.commissionAgorot, 0);
    return {
      sellerId: seller.id,
      // **Revenue-weighted actual, not one plan's rate.** A seller may hold two shops on two plans
      // since 2026-08-24, so there is no single percent that is his — the only honest headline is
      // the one his own money produced. The same function the platform total uses for the same
      // reason (`pricing.ts#blendedCommissionRate`), so the two can never disagree about what a
      // mixed set of plans averages to.
      commissionRate: blendedCommissionRate(grossRevenueAgorot, commissionAgorot),
      grossRevenueAgorot,
      commissionAgorot,
      totalEarnedAgorot: storeBalances.reduce((sum, s) => sum + s.totalEarnedAgorot, 0),
      stores: storeBalances,
    };
  });
}
