/**
 * Which plan a STORE is on, and what the seller's one monthly charge is made of.
 *
 * ── The ruling this implements (owner, 2026-08-24) ──
 * *"כל חנות צריכה לעלות כסף בנפרד"*. Until this file existed the plan lived on the account
 * (`sellers.tier`), so a seller with five shops paid for one. A store is what the platform actually
 * delivers — a storefront, an SEO surface, feed rows, campaigns — so a store is what is priced.
 *
 * ── One charge, not one per store ──
 * The seller has ONE standing order at PayMe, and its amount is the sum of the fees of the stores
 * he currently has on the site. Five standing orders would have been the other shape and it is
 * worse in the only way that costs real money: PayMe take a clearing fee per charge, so five shops
 * would pay five of them for nothing. `seller_subscriptions.store_fees` records the breakdown, so
 * "why ₪224" is answerable on his own screen rather than reconstructed.
 *
 * ── What is billed is what is PUBLISHED ──
 * A shop is built, previewed and edited for free (`store-publication.ts`); it enters the bill at the
 * moment it goes on the site and leaves it when it closes. That is why the billed set is derived
 * from `published_at`/`closed_at` and not from a flag somebody has to remember to set — the same
 * reason publication itself is derived rather than a button.
 *
 * **The one place the derivation cannot answer by itself** is the store being published right now:
 * it is not published yet (that is what is being paid for) and it must be in the price. So callers
 * pass it in explicitly — `including` below — and nothing has to invent an intermediate state.
 *
 * Pure except for the two functions that name a database; the arithmetic is separated so
 * `tests/store-plan.test.ts` can drive it with no database at all.
 */
import { firstRow, isUuid, query, rows } from './db.js';
import { monthlyFeeForTier, resolveTier, type SellerTierId } from './pricing.js';
import { toAgorot } from './money.js';

/** One line of the monthly charge: a store, the plan it is on, and what that costs per month. */
export interface StoreFeeLine {
  storeId: string;
  storeName: string;
  tier: SellerTierId;
  feeAgorot: number;
}

/** The store's effective plan. Falls back on purpose — a NULL column, a value written before this
 *  column existed and a corrupted string all answer Starter rather than breaking a render, exactly
 *  as `pricing.ts#resolveTier` does everywhere else. */
export function storeTier(store: { tier?: string }): SellerTierId {
  return resolveTier(store.tier).id;
}

/** The commission rate a sale in THIS store is charged at. Every sale belongs to exactly one store,
 *  so this is the only commission question the platform ever has to answer. */
export function commissionPercentForStore(store: { tier?: string }): number {
  return resolveTier(store.tier).commissionPercent;
}

/**
 * The monthly charge, itemised — pure, so the arithmetic is testable without a database and cannot
 * drift between the screen that shows it and the request that sets it at PayMe.
 */
export function buildStoreFeeLines(stores: { id: string; name: string; tier?: string }[]): StoreFeeLine[] {
  return stores.map((s) => {
    const tier = storeTier(s);
    return { storeId: s.id, storeName: s.name, tier, feeAgorot: toAgorot(monthlyFeeForTier(tier)) };
  });
}

/** What the card is charged. A sum of agorot integers — never a sum of shekel floats, which is the
 *  rounding the `money.ts` rules exist to prevent. */
export function totalFeeAgorot(lines: StoreFeeLine[]): number {
  return lines.reduce((sum, l) => sum + l.feeAgorot, 0);
}

/**
 * The stores this seller's standing order pays for, right now.
 *
 * On the site = `published_at` written and not closed. A PAUSED store stays in: pausing is an
 * operational halt with the storefront still up and still saying so (`store-status.ts`), so it is
 * still occupying the thing he is paying for. Closing is the exit, and it is what removes the line.
 *
 * `including` is the store being published in this very request — see the header.
 */
export async function billedStoresFor(sellerId: string, including?: string): Promise<StoreFeeLine[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<{ id: string; name: string; tier: string | null }>(
    `SELECT id, name, tier FROM stores
      WHERE seller_id = $1 AND deleted_at IS NULL AND closed_at IS NULL
        AND (published_at IS NOT NULL OR id = $2::uuid)
      ORDER BY created_at`,
    [sellerId, including && isUuid(including) ? including : null],
  );
  return buildStoreFeeLines(found.map((r) => ({ id: r.id, name: r.name, ...(r.tier ? { tier: r.tier } : {}) })));
}

/**
 * Record a store's plan. Returns the tier now stored, or null if the store does not exist.
 *
 * **Moving no money by itself, deliberately.** What a plan change costs is decided at PayMe by
 * `seller-subscription.ts#syncSubscriptionPrice`, and the order there is not negotiable: the
 * standing order moves FIRST and this write happens only if they accepted. A caller that writes the
 * tier and then fails to patch the gateway has produced the exact divergence — our row saying ₪199
 * while the card is charged ₪99 — that the tier propagation was written to remove.
 */
export async function setStoreTier(storeId: string, tier: SellerTierId): Promise<SellerTierId | null> {
  if (!isUuid(storeId)) return null;
  const row = await firstRow<{ tier: string | null }>(
    'UPDATE stores SET tier = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING tier',
    [storeId, tier],
  );
  if (!row) return null;
  return resolveTier(row.tier).id;
}

/**
 * Put a store's plan back exactly as it was, **including back to never-chosen**.
 *
 * The undo half of `setStoreTier`, and it exists because `setStoreTier` cannot express the state a
 * store starts in. `/api/seller/tier` writes the new plan provisionally — the price has to be
 * derived from the row — and rolls it back if PayMe refuse. Rolling back with `setStoreTier` was
 * impossible for a store that had never chosen: the column was NULL, there is no tier id for that,
 * and the refused plan simply stayed written. Our row would then say Enterprise while the card went
 * on paying the old amount — which is the exact divergence the write order exists to prevent, one
 * branch along.
 */
export async function restoreStoreTier(storeId: string, tier: string | undefined): Promise<void> {
  if (!isUuid(storeId)) return;
  await query('UPDATE stores SET tier = $2 WHERE id = $1 AND deleted_at IS NULL', [storeId, tier ?? null]);
}
