/**
 * Which plan a seller is on — the one write that changes what the platform charges him.
 *
 * ── Why this is a module and not two lines in an API route ──
 * `pricing.ts` decides what each tier COSTS and is deliberately pure — no I/O, importable from a
 * client bundle. This is the other half: the single place the choice is recorded. Keeping it apart
 * from `seller-auth.ts#updateSeller` is the same call `updateSellerPayoutDetails` made, for a
 * sharper reason: `updateSeller` is a COALESCE shape, "a field this request did not carry keeps
 * what it holds", and a tier is chosen explicitly or not at all.
 *
 * ── The one thing a future caller must not forget ──
 * The monthly fee is read off the tier when the PayMe subscription is GENERATED
 * (`seller-subscription.ts` → `pricing.ts#monthlyFeeForTier`). So the normal path is safe by
 * construction: a seller picks a plan, and only then does anything charge him — that is the whole
 * shape of the build-free-pay-to-publish decision (`store-publication.ts`).
 *
 * **Changing the tier once a subscription is already running is a different act**, because PayMe
 * hold the amount at their end: the row here would say ₪199 while the card is still being charged
 * ₪99 every month, and nothing on either side would report the gap. That propagation belongs in
 * `seller-subscription.ts`, next to the code that owns the PayMe subscription — not here, and not
 * duplicated at a call site. Until it exists, `setSellerTier` refuses to be the place the two
 * quietly diverge: it reports what it wrote, and `sellerMayChangeTier` is the question a caller
 * asks first.
 */
import { firstRow, isUuid } from './db.js';
import { DEFAULT_TIER, SELLER_TIERS, type SellerTierId } from './pricing.js';

/** A value from the outside world narrowed to a real tier id, or null. Never falls back to the
 *  default: an unrecognised tier arriving at a WRITE is a bug or a tampered form, and recording
 *  Starter for it would silently charge a different plan from the one that was clicked. (Reading
 *  is the opposite case — `pricing.ts#resolveTier` falls back on purpose, so a bad stored value
 *  cannot break a dashboard render.) */
export function parseTierId(value: unknown): SellerTierId | null {
  return SELLER_TIERS.some((t) => t.id === value) ? (value as SellerTierId) : null;
}

/**
 * Whether this seller is still free to switch plans without anything having to be told.
 *
 * Today the answer is "yes while no subscription is running", and the caller supplies that fact
 * rather than this module importing the subscription layer — the dependency would run the wrong
 * way (money-collection knows about tiers; tiers need not know about collection) and would make
 * this file untestable without a PayMe credential.
 */
export function sellerMayChangeTier(hasRunningSubscription: boolean): boolean {
  return !hasRunningSubscription;
}

/**
 * Record the choice. Returns the tier now stored, or null if the seller row does not exist.
 *
 * Idempotent by nature — writing the same tier twice is one state — so the endpoint above it needs
 * no idempotency key: this moves no money, it only decides what a later charge will read.
 */
export async function setSellerTier(sellerId: string, tier: SellerTierId): Promise<SellerTierId | null> {
  if (!isUuid(sellerId)) return null;
  const row = await firstRow<{ tier: string | null }>(
    `UPDATE sellers SET tier = $2 WHERE id = $1 RETURNING tier`,
    [sellerId, tier],
  );
  if (!row) return null;
  // The column is nullable and "no tier recorded" means Starter everywhere else (`pricing.ts`), so
  // the answer given back is the effective one rather than the raw cell — a caller rendering
  // "you are on —" because the write stored a null would be reporting a state that does not exist.
  return (row.tier as SellerTierId | null) ?? DEFAULT_TIER;
}
