/**
 * What a per-combination code is allowed to be — one definition, because three places now decide
 * it: the input the seller types into, the parser that reads their form back, and the CSV importer
 * that has been writing the same field since 2026-07.
 *
 * The codes themselves belong to somebody else's system (a POS, an ERP, a supplier's catalogue), so
 * this deliberately validates almost nothing about their SHAPE — letters, digits, dashes, dots and
 * spaces are all real in the wild, and a platform inventing a format here would simply refuse to
 * hold what the seller's own software already calls the thing. The only two rules are the ones that
 * are ours to make: a length cap, and "blank means no code".
 */

/** Same cap as the product-level `sku` field in the form (product-fields.ts's limit table). */
export const COMBO_SKU_MAXLENGTH = 64;

/** Trim, cap, and read blank as absent. Returns `undefined` when there is no code to store — an
 *  empty string in the map would be a code that exists and matches nothing. */
export function normalizeComboSku(value: unknown): string | undefined {
  const text = String(value ?? '').trim().slice(0, COMBO_SKU_MAXLENGTH);
  return text || undefined;
}

/**
 * The codes a submitted map may actually store: normalized, restricted to combos the product still
 * declares, and refusing a code used twice within the same product.
 *
 * A duplicate INSIDE one product is the case only this can see (the store-wide check is a query),
 * and it is not cosmetic: two combos sharing a code make an inbound feed row ambiguous — the
 * importer resolves a code to exactly one combo, so the other one would silently stop syncing.
 */
export function collectComboSkus(
  submitted: Record<string, unknown> | undefined,
  validComboKeys: Set<string>,
): { skus: Record<string, string>; duplicate?: string } {
  const skus: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const [key, raw] of Object.entries(submitted ?? {})) {
    if (!validComboKeys.has(key)) continue;
    const sku = normalizeComboSku(raw);
    if (!sku) continue;
    if (seen.has(sku)) return { skus, duplicate: sku };
    seen.set(sku, key);
    skus[key] = sku;
  }
  return { skus };
}

/** What the seller is told when a code they typed is already live somewhere in their own store —
 *  on another product, or on one of its combinations. It names the code, because a combo table can
 *  hold two hundred rows and "that SKU is taken" would send them looking through all of them. */
export function comboSkuTakenMessage(sku: string): string {
  return `המק"ט ${sku} כבר בשימוש במוצר אחר בחנות. בחרו קוד אחר לשילוב הזה.`;
}
