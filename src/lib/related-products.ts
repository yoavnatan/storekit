import { resolveCategoryFilterIds, type StoreCategory } from './store-categories.js';
import type { StoreProduct } from './store-products.js';

/**
 * What "עוד מהחנות" on a product page shows, and in what order.
 *
 * It used to be `allStoreProducts.filter(not this one).slice(0, 4)` — the four NEWEST products
 * in the shop, which is a fact about the shop and not about the product being looked at (owner,
 * 2026-08-20: *"מרגיש לי שאין שם הגיון בין המוצר שהקונה עומד עליו לבין המוצרים האחרים"*). A
 * shopper reading a ₪39 mug got the ₪900 armchair uploaded last week.
 *
 * There is no product-to-product relationship in this schema and inventing one is not free —
 * so the connection is drawn from the two facts the seller has ALREADY given us, and nothing
 * is asked of them (a seller must never be handed a form to make a feature work):
 *
 *  1. **The category tree they built.** Same shelf is the strongest signal a shop carries; the
 *     shelf NEXT to it, under the same parent, is the nearest this data gets to "goes with" —
 *     a seller who put מגבות and חלוקים under אמבטיה has said they belong together.
 *  2. **Price.** Products near the same price are near the same purchase decision. Compared as
 *     a RATIO, not a difference: ₪40 beside ₪80 is the same step as ₪80 beside ₪160, where a
 *     difference would call the second pair four times further apart and rank every cheap item
 *     in a shop as "related" to every other one. The ratio is also what lets this read the LIST
 *     price and still be right during a store-wide sale — a percentage off every product scales
 *     both sides of the ratio and cancels — so the ranking needs no sale resolution and cannot
 *     disagree with a page that resolves one (`discounts.ts#resolvePrice` still owns what the
 *     card DISPLAYS). A sale scoped to one shelf does shift it slightly, and that is accepted:
 *     it moves a product a place or two in a suggestion row, it cannot make a wrong claim.
 *
 * The result is up to two groups, in the order they should be drawn, so the PAGE can name the
 * connection instead of leaving the shopper to guess at one — which is the other half of the
 * complaint. Naming it is also the honest part: a row headed "עוד ב<קטגוריה>" is a promise the
 * ranking can keep, where a bare row of four is a promise of relevance it cannot.
 */
export interface RelatedGroup {
  /** `category` — same shelf (and everything under it). `store` — the rest of the shop, sibling
   *  shelves first. The page maps these to headings; this module never holds copy. */
  kind: 'category' | 'store';
  /** Set on a `category` group: the shelf's own name, for the heading. */
  categoryName?: string;
  products: StoreProduct[];
}

/** Below this a labelled row is worse than no label — two cards under "עוד בכלים" reads as a
 *  shop that has almost nothing, where the same two at the head of one longer row read as the
 *  most relevant of many. So a short category group is merged back rather than shown. */
const MIN_LABELLED_GROUP = 3;

/** How many cards a row holds. Was 4, which is where "מעט דל מדי" came from — the strip scrolls
 *  horizontally, so the extra cards cost no vertical space and the row now reads as a shop with
 *  stock rather than as the tail of one. */
const RELATED_PER_GROUP = 8;

/** Distance in "price steps", symmetric and scale-free — 0 is the same price, 1 is double or
 *  half, 2 is quadruple or a quarter. A missing/zero price sorts last rather than dividing by
 *  zero: it is a product nobody can compare, not a product that matches everything. The cap
 *  (rather than Infinity) is what keeps the comparator below from ever producing `Infinity -
 *  Infinity` — a NaN out of a sort callback is unspecified behaviour, not a stable tie. */
const MAX_PRICE_DISTANCE = 1e6;
function priceDistance(a: number, b: number): number {
  if (a <= 0 || b <= 0) return MAX_PRICE_DISTANCE;
  return Math.log2(Math.max(a, b) / Math.min(a, b));
}

/** Relevance order within one bucket. Stable on ties, so the caller's own order (newest first)
 *  still decides between two equally-close products. */
function byRelevance(current: StoreProduct) {
  return (a: StoreProduct, b: StoreProduct): number => {
    // In stock first, and before price: the nearest-priced product in the shop is worth nothing
    // as a suggestion if it cannot be bought today.
    const stockRank = Number(b.stock > 0) - Number(a.stock > 0);
    if (stockRank !== 0) return stockRank;
    const priceRank = priceDistance(current.price, a.price) - priceDistance(current.price, b.price);
    if (priceRank !== 0) return priceRank;
    // Only as a tie-break between two products the shopper would otherwise see as identical
    // choices — never as a rank of its own, or a shop's one reviewed product would follow every
    // page in it regardless of what that page is about.
    return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
  };
}

/**
 * `others` — every OTHER visible product in the store (the caller has already dropped the one
 * being viewed and anything blocked/hidden; this module makes no visibility decision, exactly
 * like `home-feed.ts` and for the same reason: it can only get that answer wrong).
 * `categories` — the store's own category rows, as `getCategoriesByStoreId` returns them.
 */
export function buildRelatedGroups(
  current: StoreProduct,
  others: readonly StoreProduct[],
  categories: readonly StoreCategory[],
  perGroup: number = RELATED_PER_GROUP,
): RelatedGroup[] {
  if (others.length === 0) return [];

  const cats = [...categories];
  const ownCategory = current.categoryId ? cats.find((c) => c.id === current.categoryId) : undefined;

  // No shelf on this product (or it points at a deleted one) — there is no connection to name,
  // so it stays one honest "more from this shop" row, just ordered by price instead of by date.
  if (!ownCategory) {
    return [{ kind: 'store', products: [...others].sort(byRelevance(current)).slice(0, perGroup) }];
  }

  // The shelf AND everything under it — the same answer clicking that chip gives, so a shopper
  // who follows the heading lands on a superset of what the row showed, never a different set.
  const sameShelf = new Set(resolveCategoryFilterIds(cats, ownCategory.id));
  // Sibling shelves = the parent's other children and their subtrees. Root-level products have
  // no parent, so their siblings are the other roots — which is still "the next aisle over".
  const parentId = ownCategory.parentId;
  const siblingShelf = new Set(
    cats.filter((c) => c.parentId === parentId && c.id !== ownCategory.id)
      .flatMap((c) => resolveCategoryFilterIds(cats, c.id)),
  );

  const inSame: StoreProduct[] = [];
  const inSibling: StoreProduct[] = [];
  const rest: StoreProduct[] = [];
  for (const p of others) {
    const cid = p.categoryId;
    if (cid && sameShelf.has(cid)) inSame.push(p);
    else if (cid && siblingShelf.has(cid)) inSibling.push(p);
    else rest.push(p);
  }

  const sort = byRelevance(current);
  inSame.sort(sort); inSibling.sort(sort); rest.sort(sort);

  // Sibling shelves lead the second row and the rest of the shop fills in behind them — one row,
  // because "everything that is not this shelf" is a single idea and two headings for it would be
  // a distinction only the code can see.
  const beyond = [...inSibling, ...rest];

  if (inSame.length < MIN_LABELLED_GROUP) {
    return [{ kind: 'store', products: [...inSame, ...beyond].slice(0, perGroup) }];
  }

  const groups: RelatedGroup[] = [
    // The category the heading names is the one the seller assigned — never a root ancestor,
    // which would promise a whole department and deliver one shelf of it.
    { kind: 'category', categoryName: ownCategory.name, products: inSame.slice(0, perGroup) },
  ];
  const overflow = inSame.slice(perGroup);
  const second = [...beyond, ...overflow].slice(0, perGroup);
  if (second.length > 0) groups.push({ kind: 'store', products: second });
  return groups;
}
