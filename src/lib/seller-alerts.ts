import { getStoresBySellerId } from './stores.js';
import { getStoreSlugsWithPendingOrders } from './orders.js';
import { getStoreIdsWithUnreadMessages } from './messages.js';
import { sellerNeedsBankDetails } from './payouts.js';
import { getSellerById } from './seller-auth.js';

/**
 * Everything about this seller that is waiting on them — the one source for every red dot.
 *
 * **The dots form a CHAIN, and the chain is the feature** (owner, סשן א׳ §5). A dot on the avatar
 * has to lead to a dot in the account dropdown, which leads to a dot on a store or a tab, which
 * leads to the field or the row that needs doing. A dot with no dot under it is a dead end, and a
 * thing that needs doing with no dot above it is invisible until the seller happens to look. So a
 * new "requires attention" state is added HERE and every surface reads it, rather than each surface
 * deciding for itself what counts.
 *
 * Two kinds, because they point at different places:
 *   • **per store** — a pending order, unread mail. Belongs to one shop, so it dots that shop's row
 *     in the switcher and its own tab inside that shop's dashboard.
 *   • **account-wide** — money released with no bank account to send it to. It is not any one
 *     shop's problem (a payout covers all of them), so it dots the avatar and the dashboard link
 *     and then the payments tab, and it deliberately does NOT dot every row of the store switcher:
 *     the same flag on every row says "all of your stores" when the truth is "none of them".
 *
 * ── Cost, which is the cost of the SITE ──
 * `sellerHasAnyAlert` runs in `Header.astro`, i.e. on every page a signed-in seller loads. Three
 * multi-store statements whatever the number of stores (AI_INSTRUCTIONS → Scalability), plus one
 * primary-key read for the seller row. The bank question adds nothing beyond that read for any
 * seller who has filled the form in — `sellerNeedsBankDetails` tests that first and short-circuits.
 * A seller who has NOT filled it in pays for three small sums, and is exactly the seller being
 * asked about.
 *
 * The unread rule itself lives in `messages.ts`, beside the seller's inbox, rather than here: a
 * buyer's follow-up inside an already-opened thread is new mail, and two places deciding that is
 * how the dot and the inbox come to disagree.
 */
export interface SellerAlerts {
  /** storeId → this shop has something waiting. */
  byStore: Record<string, boolean>;
  /** Account-wide: released money and no bank account on file. */
  needsBank: boolean;
}

export async function getSellerAlerts(sellerId: string): Promise<SellerAlerts> {
  // Independent reads, so one round trip rather than two sequential ones
  // (`project_sequential_await_latency`).
  const [stores, seller] = await Promise.all([
    getStoresBySellerId(sellerId),
    getSellerById(sellerId),
  ]);
  // No store means no orders, no mail and no balance — there is nothing this seller can be behind
  // on yet, and the account-wide question would cost three sums to answer "0".
  if (stores.length === 0) return { byStore: {}, needsBank: false };

  const [pendingSlugs, unreadStoreIds, needsBank] = await Promise.all([
    getStoreSlugsWithPendingOrders(stores.map((s) => s.slug)),
    getStoreIdsWithUnreadMessages(sellerId, stores.map((s) => s.id)),
    sellerNeedsBankDetails(sellerId, seller),
  ]);
  const byStore: Record<string, boolean> = {};
  for (const s of stores) {
    byStore[s.id] = pendingSlugs.has(s.slug) || unreadStoreIds.has(s.id);
  }
  return { byStore, needsBank };
}

/** The per-store map alone — what the store switcher's rows render. */
export async function getSellerStoreAlerts(sellerId: string): Promise<Record<string, boolean>> {
  return (await getSellerAlerts(sellerId)).byStore;
}

/** Anything at all, of either kind. The avatar dot and the "seller dashboard" link in the header
 *  dropdown, which are the top of the chain and therefore have to include the account-wide states
 *  as well as the per-store ones. */
export async function sellerHasAnyAlert(sellerId: string): Promise<boolean> {
  const alerts = await getSellerAlerts(sellerId);
  return alerts.needsBank || Object.values(alerts.byStore).some(Boolean);
}
