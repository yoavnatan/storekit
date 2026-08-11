/**
 * Per-product discoverability hints — the "what should I write so this product gets found"
 * guidance the seller dashboard had no answer for.
 *
 * Deliberately modelled on lib/seller-onboarding.ts, and for the same reasons:
 *  · **Derived, state-free.** Every hint is computed from fields the seller already owns, so
 *    there is nothing persisted, nothing to dismiss, nothing to migrate, and no way for the
 *    advice to disagree with the actual product. A seller who empties the description sees the
 *    hint return — that is the honest state, not a bug.
 *  · **`required` separates a real refusal from a recommendation.** Only ONE thing here is a
 *    hard fact: a product with no usable image is dropped from the ad feed outright
 *    (product-feed.ts#buildProductFeedItems returns [] without an image_link), so it cannot be
 *    advertised at all. Everything else costs quality, not operability — and none of it blocks
 *    a save. Gating publication on prose length would trade the platform's "a first product
 *    takes a minute" promise for advice a seller can act on later.
 *  · **Pure/isomorphic** (no node:fs, no Astro) — the dashboard SSRs it for the products table
 *    AND the browser bundle re-runs it on every keystroke in the editor, off the same function.
 *    Two copies of this rule is how the table and the form end up disagreeing.
 *
 * Nothing here is a ranking guarantee. Each check maps to a field a machine actually reads:
 * the description becomes the meta description and is what an AI answer engine quotes, `specs`
 * become schema.org `additionalProperty` (the part that answers "does it fit a 5-year-old?"),
 * the category drives the breadcrumb, and the name is the title tag.
 *
 * Covered by tests/product-seo-hints.test.ts.
 */

/** Stable ids — the UI maps them to translated copy, exactly like OnboardingStepId. */
export type ProductSeoHintId = 'image' | 'name' | 'description' | 'category' | 'specs';

export interface ProductSeoHint {
  id: ProductSeoHintId;
  done: boolean;
  /** true = something downstream REFUSES this product without it (today: the ad feed drops an
   *  image-less product). false = a recommendation; skipping it costs reach, not operability. */
  required: boolean;
}

/** Everything the hints need, as plain values — the caller already holds all of it. */
export interface ProductSeoInput {
  name: string;
  description: string;
  /** Count only; the hint doesn't care WHICH images, and the editor holds unsaved ones. */
  imageCount: number;
  hasCategory: boolean;
  specCount: number;
}

/** Google truncates a search snippet around 150-160 characters, so a description shorter than
 *  this leaves the snippet to be filled from page furniture instead of the product. It is also
 *  roughly the floor at which an answer engine has something to quote. */
export const MIN_DESCRIPTION_LENGTH = 120;

/** A bare "כיסא" matches no phrase anyone searches. Long-tail intent ("כיסא עץ לפינת אוכל")
 *  is where a small catalog actually competes, and the name is the title tag. */
export const MIN_NAME_LENGTH = 12;

/** Two attributes is the point where `additionalProperty` stops being decoration and starts
 *  answering a question ("what size", "what material") that a shopper actually typed. */
export const MIN_SPECS = 2;

/** More than one photo is what turns a listing into something a shopper trusts enough to open;
 *  the feed also exports up to 10 as additional_image_link. One is the floor, not the target. */
export const MIN_IMAGES = 1;

/**
 * A stored product, in the shape the hints read.
 *
 * Lives here rather than at each call site because there are three of them — the SSR products
 * table, the SSR edit form, and the client rebuild of that same form — and a mapping that differs
 * in any one of them makes the table's marker disagree with the panel it opens. The spec count is
 * the subtle part: a row with no label is dropped on save (`product-form.ts#parseSpecs`), so
 * counting it here would promise a hint the save then takes away.
 */
export function productSeoInputFrom(product: {
  name: string;
  description: string;
  images?: string[];
  categoryId?: string;
  specs?: Array<{ label: string }>;
}): ProductSeoInput {
  return {
    name: product.name,
    description: product.description,
    imageCount: product.images?.length ?? 0,
    hasCategory: !!product.categoryId,
    specCount: (product.specs ?? []).filter((s) => s.label.trim()).length,
  };
}

/**
 * The full hint list for one product, in the order the dashboard shows them: the hard one first,
 * then the recommendations by how much reach they buy.
 *
 * Always returns EVERY hint, done or not — the caller decides whether to show the satisfied ones
 * (the editor shows all, so progress is visible; the table counts only the open ones).
 */
export function productSeoHints(input: ProductSeoInput): ProductSeoHint[] {
  const name = input.name.trim();
  const description = input.description.trim();
  return [
    { id: 'image', done: input.imageCount >= MIN_IMAGES, required: true },
    { id: 'description', done: description.length >= MIN_DESCRIPTION_LENGTH, required: false },
    { id: 'specs', done: input.specCount >= MIN_SPECS, required: false },
    { id: 'category', done: input.hasCategory, required: false },
    { id: 'name', done: name.length >= MIN_NAME_LENGTH, required: false },
  ];
}

/** Just the ones still open — what the editor highlights and the table counts. */
export function openProductSeoHints(input: ProductSeoInput): ProductSeoHint[] {
  return productSeoHints(input).filter((h) => !h.done);
}

/**
 * How well this listing is set up, as a band rather than a number.
 *
 * There are exactly three, and the boundaries are NOT new thresholds — they are the two rules
 * this module already had, reused so the editor's meter and the products table's marker can
 * never say different things about the same product:
 *  · `weak`    = `needsSeoAttention` is true (no image, or three-plus hints open).
 *  · `strong`  = nothing open at all.
 *  · `partial` = everything in between — worth improving, not worth flagging in the table.
 *
 * Deliberately no `danger` band. Nothing here is broken; a half-filled form is a form being
 * filled, and colouring that as an error is the nag this whole module refuses to be (see the
 * header). The strongest signal it gives is the amber of `weak`, which is also the only state
 * that carries a real consequence — an image-less product is dropped from the ad feed.
 */
export type ProductSeoLevel = 'weak' | 'partial' | 'strong';

export interface ProductSeoScore {
  done: number;
  total: number;
  /** 0-100, for the meter's width. Rounded, so 3-of-5 is exactly 60. */
  percent: number;
  level: ProductSeoLevel;
}

export function productSeoScore(input: ProductSeoInput): ProductSeoScore {
  const hints = productSeoHints(input);
  const done = hints.filter((h) => h.done).length;
  const total = hints.length;
  const level: ProductSeoLevel = needsSeoAttention(input) ? 'weak' : done === total ? 'strong' : 'partial';
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100), level };
}

/**
 * Is this listing thin enough to be worth marking in the products table?
 *
 * Deliberately NOT "has any open hint". A catalog where most products sit at 4-of-5 would then
 * show a marker on every row, which reads as decoration and gets ignored — the mark has to mean
 * something a seller would act on. Two ways to earn it:
 *  · it misses the REQUIRED item (no image → it cannot be advertised at all), or
 *  · three or more hints are open, which is a listing that was filled in with a name and a price.
 */
export function needsSeoAttention(input: ProductSeoInput): boolean {
  const open = openProductSeoHints(input);
  return open.some((h) => h.required) || open.length >= 3;
}
