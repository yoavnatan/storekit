import { realDimensions, type VariantDimension } from './variant-combo.js';

/**
 * **What a product is findable BY — the single definition, ported into SQL.**
 *
 * A product's colours, flavours and materials live in `variants` and nowhere else: the seller
 * types "אדום / צהוב / שחור" once as a variant dimension and never repeats those words in the
 * name or the tags, because on the product page they are already visible as swatches. Search did
 * not read that column, so a shopper typing "צהוב" got zero results in a store that sells yellow —
 * not a weak result, an empty one, which reads as "this store has none".
 *
 * This module is the source; `product_search_text()` (migration 0027) is its port, and
 * `tests/product-search-normalize.test.ts` compares the two character for character. The order of
 * the three parts is part of the contract — the pin test compares whole strings.
 *
 * **The rule for which variant values qualify, and why it is about the VALUE and not the
 * dimension.** A size rubric is `36, 37, 38…`, and folding those into the search text makes nearly
 * every garment in a clothing store answer to "38" — a relevance collapse in exchange for a query
 * nobody types on its own. Colours and flavours are the opposite: high-signal words a shopper
 * really does type alone. The tempting fix is a whitelist of dimension NAMES (colour in, size
 * out), and it fails in the wrong direction: sellers name dimensions freely, so an unlisted
 * "ניחוח" or "חומר" would be silently dropped, and those are exactly the words worth matching. A
 * test on the value fails in the right direction — an unrecognised dimension whose values are
 * words is included, and a numeric rubric is excluded whatever it is called. So: a value joins the
 * search text when it carries a letter and is at least two characters.
 *
 * Two characters, not one, because `S`/`M`/`L` are noise under the substring `LIKE` the stored
 * column is searched with, while `XL` survives. Nothing here caps the total — `MAX_VARIANT_COMBOS`
 * already bounds how many options a product can declare, and a second cap would be a second rule
 * to keep in sync with the SQL.
 *
 * **Not a duplicate of `tag-suggest.ts#isMeaningfulValue`, and the difference is the point.** That
 * one decides which variant values `/api/product` copies into the product's stored `tags` on save,
 * and it is deliberately narrower — it drops `XL`, `50ml` and `One Size`, because a TAG is a topic
 * the product is about, and "XL" is not a topic. This one decides what a shopper can TYPE, where
 * "חולצה XL" and "50ml" are real queries. The two coexist; neither is a stale copy.
 *
 * That copy is also why the gap this closes was invisible: a colour typed into the single-product
 * editor did land in `tags` and was findable. But CSV bulk import writes `tags` verbatim and never
 * derives (`store-products-bulk.ts`) — so the catalogue stores this platform is built for, the ones
 * that upload hundreds of rows at once, had none of it — and the derivation is a snapshot, so a
 * colour added later by any other path never reaches search. Reading `variants` at the source is
 * what makes the answer the same however the product got there.
 */

/** A variant value shorter than this is a size letter, not a word worth matching. */
const MIN_SEARCHABLE_VALUE_LENGTH = 2;

/** Hebrew (U+0590–U+05FF) or Latin. Written as an explicit range rather than a POSIX class:
 *  `[[:alpha:]]` resolves against the database's ctype, so the SQL port would mean one thing on
 *  Neon and another on a `C`-collation test database, and the divergence would be silent. */
const HAS_LETTER = /[a-zA-Z\u0590-\u05FF]/;

export function isSearchableVariantValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= MIN_SEARCHABLE_VALUE_LENGTH && HAS_LETTER.test(trimmed);
}

/** Every variant option a shopper can find this product by, in declaration order.
 *  Dimension NAMES are deliberately absent: "צבע" as a query should not return every product
 *  that happens to have colours, and the word is never what a shopper is looking for. */
export function searchableVariantValues(variants: VariantDimension[] | undefined): string[] {
  return realDimensions(variants).flatMap((dim) =>
    // `typeof` and not a cast: these arrive from a JSONB column, so the `string[]` in the type is
    // a claim about what we wrote, not about what is stored (same reasoning as realDimensions).
    dim.options.filter((opt) => typeof opt === 'string' && isSearchableVariantValue(opt)),
  );
}

/** The raw haystack, before normalisation — name, then tags, then variant values. Mirrors the
 *  concatenation inside `product_search_text()`; whitespace is not tidied here because the
 *  normaliser at either end collapses it. */
export function productSearchSource(product: {
  name?: string;
  tags?: string[];
  variants?: VariantDimension[];
}): string {
  return [
    product.name ?? '',
    (product.tags ?? []).join(' '),
    searchableVariantValues(product.variants).join(' '),
  ].join(' ');
}
