import type { StoreProduct } from './store-products.js';
import { inferAudienceGender, inferAgeGroup } from './audience-infer.js';
import { deriveProductLabels } from './product-labels.js';
import { generateCombos, comboKey, canonicalDimName } from './variant-combo.js';
import { isColorVariant } from './color-variants.js';
import { resolvePrice, type StoreSale } from './discounts.js';
import { toAbsoluteImageUrl } from './image-url.js';
import { urlSegment } from './url-base.js';
import { xmlEscape, xmlCdata } from './xml-text.js';

// Maps a StoreProduct to the standard Google Merchant Center / Meta Catalog
// product-feed attributes. The whole point (see CURRENT_TASK.md item 14): the
// product already carries everything the ad platforms need — so this derives
// every attribute from existing product/store data with sensible defaults and
// asks the seller for NOTHING extra. It's the single source the future bulk
// feed endpoint will map over; keeping it a pure function (all data passed in,
// no fs) makes it testable and reusable server-side.
//
// Attributes and how each is sourced:
//   gender / age_group  → inferred from category + name + tags (audience-infer)
//   brand               → the product's own `brand` when the seller set one (a
//                         reseller listing someone else's goods), else the store
//                         name (a small business is its own brand)
//   condition           → 'new' (platform sellers are registered businesses
//                         selling new goods — not a P2P used-goods marketplace)
//   mpn                 → the seller SKU; gtin stays optional (many SKUs have
//                         no barcode — identifierExists then rides on brand+mpn)
//   product_type        → the category path the product sits under
//   custom_labels       → five stable, positional campaign-segmentation buckets
//                         (price / performance / availability / audience / store
//                         type), all auto-derived — see product-labels.ts

export interface FeedAttributes {
  id: string;
  title: string;
  description: string;
  availability: 'in_stock' | 'out_of_stock';
  price: number; // ILS — the REGULAR price (what `sale_price` is struck through against)
  /** Present only while the product is discounted (discounts.ts). Google/Meta show it as the
   *  live price with `price` crossed out, which is exactly the storefront's own treatment —
   *  and a feed that omitted it would advertise a price the landing page contradicts, which
   *  is a Merchant Center disapproval, not just a cosmetic mismatch. */
  salePrice?: number;
  brand: string;
  condition: 'new' | 'used' | 'refurbished';
  gender: 'male' | 'female' | 'unisex';
  ageGroup: 'newborn' | 'infant' | 'toddler' | 'kids' | 'adult';
  mpn?: string;
  gtin?: string;
  identifierExists: boolean;
  productType?: string;
  customLabels: string[];
}

export interface FeedContext {
  storeName: string;
  /** The product's store-wide sale, if running — same input the storefront resolves with. */
  sale?: StoreSale | null;
  categoryPath?: string;
  /** Units sold — drives the performance custom label. */
  purchasedUnits?: number;
  /** The store's flat category tags (Store.categories) — the store-scope label. */
  storeTags?: string[];
  /** ms epoch for the "new" recency window; defaults to now. Pass a fixed value in tests. */
  nowMs?: number;
}

// Google Merchant / Meta Catalog hard limits. Over them the item is REJECTED, and rejected
// silently — the seller sees a product on the storefront and no ad behind it, with nothing
// anywhere saying why. Cut here rather than at the XML layer so every future consumer of a
// FeedItem (a JSON catalog, a per-store feed) inherits the same compliant values.
const TITLE_MAX = 150;
const DESCRIPTION_MAX = 5000;

/** Cut to `max` CHARACTERS without splitting a surrogate pair — slicing an emoji in half
 *  produces a lone surrogate, which is exactly what XML_ILLEGAL would then have to strip,
 *  turning a length fix into mojibake at the end of every long title. */
function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function buildProductFeedAttributes(product: StoreProduct, ctx: FeedContext): FeedAttributes {
  const inferText = [ctx.categoryPath, product.name, ...(product.tags ?? [])];
  const g = inferAudienceGender(inferText);
  const gender: FeedAttributes['gender'] = g === 'men' ? 'male' : g === 'women' ? 'female' : 'unisex';
  const a = inferAgeGroup(inferText);
  const ageGroup: FeedAttributes['ageGroup'] = a === 'infant' ? 'infant' : a === 'kids' ? 'kids' : 'adult';

  // The seller's own brand field when they filled one in (a reseller listing someone else's
  // product), else the store name. Merchant Center matches listings across the market on brand,
  // so getting this wrong doesn't just mislabel the item — it stops it joining the real product.
  const brand = product.brand?.trim() || ctx.storeName;
  const mpn = product.sku || undefined;
  const gtin = undefined; // no barcode field yet — optional in the feed spec
  const identifierExists = Boolean(gtin || (mpn && brand));

  const pv = resolvePrice(product, ctx.sale);

  // Five stable, positional segmentation labels — all zero-touch (product-labels.ts).
  // Bucketed on the price a shopper would PAY, so a discounted product segments into the
  // band the ad actually competes in.
  const customLabels = deriveProductLabels({
    price: pv.price,
    stock: product.stock,
    createdAt: product.createdAt,
    purchasedUnits: ctx.purchasedUnits,
    audienceTexts: inferText,
    storeTags: ctx.storeTags,
    nowMs: ctx.nowMs,
  });

  // `description` is a REQUIRED Merchant attribute, but the product form defaults it to ''
  // (api/product.ts) — only `name` is enforced. An empty one is a disapproval, so fall back to
  // the title: never invented copy, always non-empty, and it describes the item as well as the
  // seller chose to. Both fields trimmed + capped; see TITLE_MAX/DESCRIPTION_MAX.
  const title = clampText(product.name.trim(), TITLE_MAX);
  const description = clampText(product.description.trim() || title, DESCRIPTION_MAX);

  return {
    id: product.id,
    title,
    description,
    availability: product.stock > 0 ? 'in_stock' : 'out_of_stock',
    price: pv.basePrice,
    ...(pv.isDiscounted ? { salePrice: pv.price } : {}),
    brand,
    condition: 'new',
    gender,
    ageGroup,
    ...(mpn ? { mpn } : {}),
    ...(gtin ? { gtin } : {}),
    identifierExists,
    ...(ctx.categoryPath ? { productType: ctx.categoryPath } : {}),
    customLabels,
  };
}

// ── Feed items (one row per purchasable unit) + Merchant/Catalog XML ──────────
//
// A FeedItem is one *row* in the Google Merchant / Meta Catalog feed. A product
// with variants (color/size) expands to one row per combination, all tied by a
// shared `itemGroupId` (Google's item_group_id) — that's how the platforms know
// they're facets of one product. A plain product is a single row. Each row also
// carries the absolute link + image(s) the derived attributes don't.

export interface FeedItem extends FeedAttributes {
  link: string;
  imageLink: string;
  additionalImageLinks: string[];
  itemGroupId?: string;
  color?: string;
  size?: string;
}

export interface FeedBuildContext extends FeedContext {
  storeSlug: string;
  baseUrl: string; // origin, no trailing slash — e.g. https://shop.example
}

// A feed row id must be stable + unique; keep the human-readable combo but
// swap the key/value separators for id-safe ones (Unicode option values, incl.
// Hebrew, are preserved so two combos never collapse to the same id).
function comboRowId(productId: string, key: string): string {
  return `${productId}-${key.replace(/=/g, '-').replace(/,/g, '_')}`;
}

/** Expand one product into its feed rows (variant combos → item_group_id rows).
 *  Returns [] when a required field is missing (no usable image, or price ≤ 0) so the
 *  caller simply skips it rather than emitting a row the platforms would reject. */
export function buildFeedItems(product: StoreProduct, ctx: FeedBuildContext): FeedItem[] {
  const base = buildProductFeedAttributes(product, ctx);
  // Every image the platforms are handed must be an ABSOLUTE url, and one bad entry
  // must not cost the product its listing: `toAbsoluteImageUrl` resolves a stored
  // site-relative path (which sanitizeImageUrl accepts by design) against this feed's
  // own origin, and drops only the entries that are unusable — so a product ships as
  // long as ANY of its images survives, and is skipped only when none does.
  const images = (product.images ?? [])
    .map((img) => toAbsoluteImageUrl(img, ctx.baseUrl))
    .filter((url): url is string => url !== null);
  const imageLink = images[0];
  if (!imageLink || product.price <= 0) return [];
  const additionalImageLinks = images.slice(1, 11); // Google caps additional images at 10
  // Encoded per segment: slugs carry Hebrew (store-products.ts#slugify) and Merchant Center
  // validates this as a URL, not as display text.
  const link = `${ctx.baseUrl}/${urlSegment(ctx.storeSlug)}/${urlSegment(product.slug)}`;

  const variants = product.variants ?? [];
  if (!variants.length) {
    return [{ ...base, link, imageLink, additionalImageLinks }];
  }

  const colorDim = variants.find((v) => isColorVariant(v.name));
  const sizeDim = variants.find((v) => canonicalDimName(v.name) === 'מידה');
  return generateCombos(variants).map((combo) => {
    const key = comboKey(combo);
    const stock = product.variantStock?.[key] ?? product.stock;
    // A per-combo SKU is this variant's own mpn — more specific than the product-level one, and it
    // makes identifierExists true (brand + mpn) even when the product itself carries no top sku.
    const comboMpn = product.variantSku?.[key];
    return {
      ...base,
      id: comboRowId(product.id, key),
      itemGroupId: product.id,
      availability: stock > 0 ? 'in_stock' : 'out_of_stock',
      link,
      imageLink,
      additionalImageLinks,
      ...(comboMpn ? { mpn: comboMpn, identifierExists: Boolean(base.brand) } : {}),
      ...(colorDim && combo[colorDim.name] ? { color: combo[colorDim.name] } : {}),
      ...(sizeDim && combo[sizeDim.name] ? { size: combo[sizeDim.name] } : {}),
    } as FeedItem;
  });
}

export interface FeedChannelMeta { title: string; link: string; description: string; currency: string; }

/**
 * Characters XML 1.0 forbids OUTRIGHT — the C0 controls except tab/LF/CR, the two
 * non-characters, and an unpaired surrogate. Unlike `&` or `<` these cannot be escaped
 * into legality: a numeric reference to them is just as illegal as the raw byte. One of
 * them anywhere in the document makes the WHOLE feed unparseable, so Merchant Center
 * drops every product of every store, not the one row that carried it — the widest
 * possible version of "my products stopped appearing".
 *
 * They reach us because nothing upstream forbids them: a description pasted out of Word
 * or Excel carries U+000B, and both JSON and a form POST pass it through untouched.
 * Stripped rather than replaced — they carry no meaning a shopper would miss.
 */
/** The gate every text value passes through on its way into the document — both helpers below call
 *  it, so a new field cannot bypass it by picking the other one.
 *
 *  Moved to `lib/xml-text.ts` on 2026-08-02 and imported here: `sitemap.ts` had grown its own
 *  `xmlEscape` that did the five-character escaping WITHOUT this strip, so the same rule had two
 *  answers depending on which document you were writing. Re-exported under the local names so
 *  nothing below this line had to change. */
const cdata = xmlCdata;

function itemXml(it: FeedItem, currency: string): string {
  const g = (tag: string, val: string) => `  <g:${tag}>${xmlEscape(val)}</g:${tag}>`;
  const lines: string[] = [];
  lines.push(g('id', it.id));
  if (it.itemGroupId) lines.push(g('item_group_id', it.itemGroupId));
  lines.push(`  <title>${cdata(it.title)}</title>`);
  lines.push(`  <description>${cdata(it.description)}</description>`);
  lines.push(`  <link>${xmlEscape(it.link)}</link>`);
  lines.push(g('image_link', it.imageLink));
  for (const a of it.additionalImageLinks) lines.push(g('additional_image_link', a));
  lines.push(g('availability', it.availability));
  lines.push(g('price', `${it.price.toFixed(2)} ${currency}`));
  if (it.salePrice !== undefined) lines.push(g('sale_price', `${it.salePrice.toFixed(2)} ${currency}`));
  lines.push(g('brand', it.brand));
  lines.push(g('condition', it.condition));
  lines.push(g('gender', it.gender));
  lines.push(g('age_group', it.ageGroup));
  if (it.productType) lines.push(`  <g:product_type>${cdata(it.productType)}</g:product_type>`);
  if (it.color) lines.push(g('color', it.color));
  if (it.size) lines.push(g('size', it.size));
  if (it.mpn) lines.push(g('mpn', it.mpn));
  if (it.gtin) lines.push(g('gtin', it.gtin));
  if (!it.identifierExists) lines.push(g('identifier_exists', 'no'));
  it.customLabels.forEach((l, i) => lines.push(g(`custom_label_${i}`, l)));
  return `<item>\n${lines.join('\n')}\n</item>`;
}

/** Serialize feed rows to a Google Merchant Center RSS 2.0 feed (the `g:`
 *  namespace) — the same document Meta Catalog ingests as a data-feed URL, so
 *  one endpoint drives both. */
export function toMerchantXml(items: FeedItem[], meta: FeedChannelMeta): string {
  const body = items.map((it) => itemXml(it, meta.currency)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>${xmlEscape(meta.title)}</title>
<link>${xmlEscape(meta.link)}</link>
<description>${xmlEscape(meta.description)}</description>
${body}
</channel>
</rss>
`;
}
