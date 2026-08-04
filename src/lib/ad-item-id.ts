/**
 * THE id Google and Meta know one sellable item by — one definition, used by both sides of a join
 * that only works when they agree.
 *
 * **The bug this exists to make impossible (found 2026-08-04).** The Merchant/Catalog feed sent the
 * product's uuid as `g:id`, while every `dataLayer`/`fbq` event sent the product SLUG. Both networks
 * join a catalog item to a browsing event by exactly that id, so the two sides matched on nothing:
 * dynamic remarketing had no product to show, and "which products do my ads actually sell" had no
 * answer. Nothing was visibly broken anywhere — the feed validated, the events fired, each side was
 * internally consistent — which is why it survived four call sites.
 *
 * The slug was also the wrong identifier on its own terms. It is unique per store, not globally:
 * migration 0001 measured **47 slugs shared across different stores** (which is why `wishlist_items`
 * keys by product id), so two unrelated products in two unrelated stores were reporting themselves
 * to Google and Meta as the same item. And a slug follows the product NAME, so a seller renaming a
 * product would have retired one id and invented another — for a feed, that is a new product with
 * no approval history and no performance record.
 *
 * **So the id is the uuid, and the uuid is why the feed was already right.** It is stable across
 * every rename, unique platform-wide by construction, and it is the one thing about a product that
 * never changes. The events moved to meet the feed, not the other way round.
 *
 * **Variants get their own id, because the feed gives them their own row.** A product with variants
 * emits NO parent row — only one row per combo, tied together by `item_group_id` (see
 * `product-feed.ts#buildFeedItems`). So an event that named the bare product id for a variant
 * product would still match nothing. Pass the combo the shopper actually chose and the id lines up
 * with its row; pass nothing (a product page before any choice is made, a product with no variants)
 * and it is the plain product id.
 */
import { comboKey, type VariantSelection } from './variant-combo.js';

/**
 * The advertising id for a product, optionally narrowed to one variant combo.
 *
 * Keeps the human-readable combo and only swaps the separators `comboKey` uses for id-safe ones, so
 * two combos can never collapse onto one id. Unicode option values (Hebrew included) are preserved
 * deliberately — folding them would be exactly such a collapse.
 *
 * An empty selection is treated as no selection: `{}` is what a caller passes when the shopper has
 * chosen nothing yet, and it must not produce a third id shaped like neither.
 */
export function adItemId(productId: string, selectedVariants?: VariantSelection): string {
  if (!selectedVariants || !Object.keys(selectedVariants).length) return productId;
  return adComboItemId(productId, comboKey(selectedVariants));
}

/** Same id from an already-built combo key — the form the feed has, since it walks combos rather
 *  than reading a shopper's selection. Both spellings must produce the same string, which is the
 *  property `tests/ad-item-id.test.ts` pins. */
export function adComboItemId(productId: string, key: string): string {
  return `${productId}-${key.replace(/=/g, '-').replace(/,/g, '_')}`;
}
