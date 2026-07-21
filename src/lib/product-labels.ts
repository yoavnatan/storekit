import { inferAudienceGender, inferAgeGroup } from './audience-infer.js';

// Zero-touch product labeling for ad-campaign segmentation.
//
// Google Merchant / Meta Catalog give each product up to five free-form
// `custom_label_0..4` slots. Their entire value is that a campaign can bid
// differently on a *group* of products ("push bestsellers", "clear low stock",
// "premium-only campaign"). For that to work the slots must be STABLE and
// POSITIONAL — slot N must mean the same dimension on every product, always
// populated — otherwise "custom_label_2 = low_stock" filters nothing reliably.
//
// The whole thing is derived from data the product/store already carries, so
// the seller inputs NOTHING (the zero-touch principle): no label picker, no
// per-product tagging. A seller who wants none of this still gets a fully
// segmentable feed. The five dimensions cover the two scopes the labels serve:
//   slots 0-3 = product scope (price / performance / availability / audience)
//   slot  4   = store scope   (the store's own category identity)
// Platform scope isn't a per-product label — it's the owner's cross-store
// campaign structure (baseline/brand/promoWeight), which segments over these
// same values rather than needing a sixth slot.

export interface LabelThresholds {
  /** stock <= this (and > 0) → low_stock; 0 → out_of_stock. Mirrors LOW_STOCK_THRESHOLD. */
  lowStock: number;
  /** purchasedUnits >= this → popular. */
  popularUnits: number;
  /** purchasedUnits >= this → bestseller. */
  bestsellerUnits: number;
  /** purchasedUnits >= this → platform_bestseller (a stronger, rarer tier). */
  platformBestsellerUnits: number;
  /** created within this many days (and not yet popular) → new. */
  newWithinDays: number;
}

export const DEFAULT_LABEL_THRESHOLDS: LabelThresholds = {
  lowStock: 3,
  popularUnits: 3,
  bestsellerUnits: 10,
  platformBestsellerUnits: 25,
  newWithinDays: 30,
};

// The five stable slots, in order — the canonical positional contract the feed
// depends on (a test asserts deriveProductLabels stays this length).
export const LABEL_SLOTS = ['price_tier', 'performance', 'availability', 'audience', 'store_type'] as const;

export interface ProductLabelInput {
  price: number;
  stock: number;
  createdAt: string;
  /** Units sold — drives the performance tier. */
  purchasedUnits?: number;
  /** category path + name + tags — the same signal set audience-infer uses. */
  audienceTexts: (string | undefined | null)[];
  /** The owning store's flat category tags (Store.categories) — the store-scope label. */
  storeTags?: string[];
  /** ms epoch used for the "new" recency window. Defaults to now; pass a fixed value in tests. */
  nowMs?: number;
  thresholds?: Partial<LabelThresholds>;
}

const DAY_MS = 86_400_000;

function priceTier(price: number): string {
  if (price < 100) return 'budget';
  if (price < 500) return 'mid';
  return 'premium';
}

function availabilityTier(stock: number, lowStock: number): string {
  if (stock <= 0) return 'out_of_stock';
  if (stock <= lowStock) return 'low_stock';
  return 'in_stock';
}

function performanceTier(input: ProductLabelInput, t: LabelThresholds, nowMs: number): string {
  const units = input.purchasedUnits ?? 0;
  if (units >= t.platformBestsellerUnits) return 'platform_bestseller';
  if (units >= t.bestsellerUnits) return 'bestseller';
  if (units >= t.popularUnits) return 'popular';
  // "new" only for a product that hasn't proven itself yet — a recent product
  // that's already popular is described by its velocity, not its age.
  const created = Date.parse(input.createdAt);
  if (Number.isFinite(created) && nowMs - created <= t.newWithinDays * DAY_MS) return 'new';
  return 'standard';
}

// A single composite audience bucket for campaign grouping (distinct from the
// feed's separate gender + age_group *attributes*, which describe the product;
// this is one token a campaign filters on). Age wins over gender — a kids'
// product is bucketed by age first, its gender is the secondary facet.
function audienceBucket(texts: (string | undefined | null)[]): string {
  const age = inferAgeGroup(texts);
  if (age === 'infant') return 'baby';
  if (age === 'kids') return 'kids';
  const gender = inferAudienceGender(texts);
  if (gender === 'men') return 'men';
  if (gender === 'women') return 'women';
  return 'unisex';
}

// The store's own identity as a stable token, so a campaign can target a whole
// store-type ("all fashion stores"). Uses the store's first flat tag; falls
// back to 'general'. Lowercased + spaces→'_' for a clean, filterable token
// (Hebrew letters are kept — Merchant/Catalog accept UTF-8 label values).
function storeTypeTag(storeTags?: string[]): string {
  const raw = (storeTags ?? []).map((s) => s.trim()).find(Boolean);
  if (!raw) return 'general';
  return raw.toLowerCase().replace(/\s+/g, '_').slice(0, 100);
}

/** Derive the five stable, positional custom-label values for a product.
 *  Always returns exactly LABEL_SLOTS.length values, in slot order. */
export function deriveProductLabels(input: ProductLabelInput): string[] {
  const t = { ...DEFAULT_LABEL_THRESHOLDS, ...input.thresholds };
  const nowMs = input.nowMs ?? Date.now();
  return [
    priceTier(input.price),
    performanceTier(input, t, nowMs),
    availabilityTier(input.stock, t.lowStock),
    audienceBucket(input.audienceTexts),
    storeTypeTag(input.storeTags),
  ];
}
