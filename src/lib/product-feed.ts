import type { StoreProduct } from './store-products.js';
import { inferAudienceGender, inferAgeGroup } from './audience-infer.js';
import { deriveProductLabels } from './product-labels.js';
import { generateCombos, comboKey, canonicalDimName } from './variant-combo.js';
import { isColorVariant } from './color-variants.js';

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
//   brand               → the store name (a small business is its own brand;
//                         a future optional product override can supersede it)
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
  price: number; // ILS
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
  categoryPath?: string;
  /** Units sold — drives the performance custom label. */
  purchasedUnits?: number;
  /** The store's flat category tags (Store.categories) — the store-scope label. */
  storeTags?: string[];
  /** ms epoch for the "new" recency window; defaults to now. Pass a fixed value in tests. */
  nowMs?: number;
}

export function buildProductFeedAttributes(product: StoreProduct, ctx: FeedContext): FeedAttributes {
  const inferText = [ctx.categoryPath, product.name, ...(product.tags ?? [])];
  const g = inferAudienceGender(inferText);
  const gender: FeedAttributes['gender'] = g === 'men' ? 'male' : g === 'women' ? 'female' : 'unisex';
  const a = inferAgeGroup(inferText);
  const ageGroup: FeedAttributes['ageGroup'] = a === 'infant' ? 'infant' : a === 'kids' ? 'kids' : 'adult';

  const brand = ctx.storeName;
  const mpn = product.sku || undefined;
  const gtin = undefined; // no barcode field yet — optional in the feed spec
  const identifierExists = Boolean(gtin || (mpn && brand));

  // Five stable, positional segmentation labels — all zero-touch (product-labels.ts).
  const customLabels = deriveProductLabels({
    price: product.price,
    stock: product.stock,
    createdAt: product.createdAt,
    purchasedUnits: ctx.purchasedUnits,
    audienceTexts: inferText,
    storeTags: ctx.storeTags,
    nowMs: ctx.nowMs,
  });

  return {
    id: product.id,
    title: product.name,
    description: product.description,
    availability: product.stock > 0 ? 'in_stock' : 'out_of_stock',
    price: product.price,
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
 *  Returns [] when a required field is missing (no image, or price ≤ 0) so the
 *  caller simply skips it rather than emitting a row the platforms would reject. */
export function buildFeedItems(product: StoreProduct, ctx: FeedBuildContext): FeedItem[] {
  const base = buildProductFeedAttributes(product, ctx);
  const images = product.images ?? [];
  const imageLink = images[0];
  if (!imageLink || product.price <= 0) return [];
  const additionalImageLinks = images.slice(1, 11); // Google caps additional images at 10
  const link = `${ctx.baseUrl}/store/${ctx.storeSlug}/${product.slug}`;

  const variants = product.variants ?? [];
  if (!variants.length) {
    return [{ ...base, link, imageLink, additionalImageLinks }];
  }

  const colorDim = variants.find((v) => isColorVariant(v.name));
  const sizeDim = variants.find((v) => canonicalDimName(v.name) === 'מידה');
  return generateCombos(variants).map((combo) => {
    const key = comboKey(combo);
    const stock = product.variantStock?.[key] ?? product.stock;
    return {
      ...base,
      id: comboRowId(product.id, key),
      itemGroupId: product.id,
      availability: stock > 0 ? 'in_stock' : 'out_of_stock',
      link,
      imageLink,
      additionalImageLinks,
      ...(colorDim && combo[colorDim.name] ? { color: combo[colorDim.name] } : {}),
      ...(sizeDim && combo[sizeDim.name] ? { size: combo[sizeDim.name] } : {}),
    } as FeedItem;
  });
}

export interface FeedChannelMeta { title: string; link: string; description: string; currency: string; }

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// CDATA for free text; a literal "]]>" inside would close the section early, so split it.
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

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
