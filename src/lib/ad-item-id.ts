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
 * deliberately — folding them would be exactly such a collapse. When the readable form would break
 * Google's 50-character cap the combo is hashed instead of dropped or truncated (see `ID_MAX`);
 * truncation would be that same collapse, arrived at from the other direction.
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
  const readable = `${productId}-${key.replace(/=/g, '-').replace(/,/g, '_')}`;
  return readable.length <= ID_MAX ? readable : `${productId}-${shortHash(key)}`;
}

/**
 * The product an advertising id belongs to — the only supported way to read one back.
 *
 * **Why a reverse map exists at all:** the ad networks answer in their own vocabulary. Merchant
 * Center's approval report and Meta's catalog diagnostics both name the offending row by the `id`
 * WE gave it, so the monitoring job (`merchant-status-check.ts`) cannot tell a seller their product
 * was rejected without turning that id back into a product. Doing it by hand at that call site would
 * be a second, drifting copy of this file's format — the exact mistake that made the feed and the
 * events disagree in the first place.
 *
 * **Only the product half is recoverable, and that is by design.** Both spellings above put the
 * product id first and everything else after a `-`, and a uuid's length is fixed, so the product is
 * always the leading 36 characters. The combo is NOT recovered: the hashed form is one-way, so a
 * caller that tried would work for short Hebrew combos and silently fail for long ones. Anything
 * needing the combo must ask the product for its combos and re-derive their ids forwards.
 *
 * Returns null for anything that is not one of our ids — an id the networks hold from an older feed,
 * or a row we never emitted. A null must be reported as "unrecognised", never skipped quietly.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function productIdFromAdItemId(itemId: string): string | null {
  if (!itemId) return null;
  const head = itemId.slice(0, 36);
  if (!UUID_RE.test(head)) return null;
  // Length 36 is the bare product; anything longer must be the combo form, i.e. `-` then a non-empty
  // key. `<uuid>x…` is not one of ours and must not be read as the product it happens to start with.
  if (itemId.length === 36) return head;
  return itemId[36] === '-' && itemId.length > 37 ? head : null;
}

/**
 * Google's hard cap on the `id` attribute: **50 characters** (Merchant Center product data spec,
 * checked against the published spec on 2026-08-04 — Meta's own limit is looser, so this is the
 * binding one). Over it the row is REJECTED, and rejected the way this whole file exists to prevent:
 * silently, one item at a time, with a storefront that still shows the product and no ad behind it.
 *
 * A uuid is 36, which leaves 13 for `-` + the combo — and a Hebrew combo does not fit in 13.
 * `צבע=אדום,מידה=42` alone is 17, so a two-dimension Hebrew variant product blew the cap on every
 * row it had. And a variant product emits NO parent row (see the header), so the product was not
 * partly advertised: it was absent from the catalogue entirely.
 */
const ID_MAX = 50;

/**
 * The combo key as a short, stable, id-safe token — used ONLY when the readable form does not fit.
 *
 * Deliberately not applied everywhere: an id that fits today keeps the exact string it already has,
 * so nothing that Merchant Center has already approved changes identity for the sake of tidiness.
 * The rows that change are the rows that were being thrown away.
 *
 * FNV-1a over the UTF-16 code units, twice with different offsets, so the token carries ~62 bits
 * rather than 32 — a collision would put two combos of one product on one id, which is the single
 * thing this module promises cannot happen. Hand-rolled because this file is bundled into the
 * BROWSER (every tracking call site imports it), where `node:crypto` does not exist and a hashing
 * dependency would be a network cost paid on the product page.
 *
 * **Exactly 12 characters, fixed width.** 36 (uuid) + 1 (`-`) + 12 = 49, which is the whole point:
 * the hashed form has to fit under ID_MAX for every input, so its length cannot depend on the
 * value. Each half is taken modulo 36⁶ and zero-padded to six.
 */
const BASE36_6 = 36 ** 6;

function shortHash(key: string): string {
  const fnv = (offset: number): string => {
    let h = offset;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      // `Math.imul` + `>>> 0` on every step: a plain `*` loses the high bits to float precision,
      // and JS bitwise operators are signed 32-bit.
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h % BASE36_6).toString(36).padStart(6, '0');
  };
  return `${fnv(0x811c9dc5)}${fnv(0x9dc5811c)}`;
}
