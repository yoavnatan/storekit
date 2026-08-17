import type { StoreProduct } from './store-products.js';
import { inferAudienceGender, inferAgeGroup } from './audience-infer.js';
import { deriveProductLabels, availabilityTier, AVAILABILITY_SLOT } from './product-labels.js';
import { variantLandingUrl } from './variant-landing.js';
import { adPolicyViolation } from './ad-policy.js';
import { generateCombos, comboKey, canonicalDimName } from './variant-combo.js';
import { adItemId, adComboItemId } from './ad-item-id.js';
import { isColorVariant } from './color-variants.js';
import { resolvePrice, activeDiscountWindow, type StoreSale } from './discounts.js';
import { businessDayISO, businessOffsetForDay } from './business-day.js';
import { toAbsoluteImageUrl } from './image-url.js';
import { xmlEscape, xmlCdata } from './xml-text.js';
import { feedShippingWeight } from './product-weight.js';

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
//   shipping_weight     → the seller's stated weight in grams, omitted when they
//                         have not stated one. The one attribute here that CAN'T
//                         be derived, and the only reason a weight field exists
//                         before shipping is priced on it (lib/product-weight.ts)
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
  /** `sale_price_effective_date` — the window `salePrice` is the price for, as Google's ISO-8601
   *  range. Present only alongside `salePrice`, and only when the winning discount has an end
   *  date; an open-ended markdown has no window to state and omitting it is how you say so.
   *  Built by `salePriceEffectiveDate` below, which is also where the format is documented. */
  salePriceEffectiveDate?: string;
  brand: string;
  condition: 'new' | 'used' | 'refurbished';
  gender: 'male' | 'female' | 'unisex';
  ageGroup: 'newborn' | 'infant' | 'toddler' | 'kids' | 'adult';
  mpn?: string;
  gtin?: string;
  /** `shipping_weight` — `"<n> g"`, the format Google's fixed unit vocabulary takes, built by
   *  lib/product-weight.ts#feedShippingWeight. Absent when the seller has not stated a weight, and
   *  absent is the honest answer: Merchant Center uses this to show a shipping estimate, and a
   *  guessed weight is a quoted delivery price that the checkout would then contradict. */
  shippingWeight?: string;
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
// Checked against the published product data spec on 2026-08-04. Everything here is a value a
// SELLER can make arbitrarily long — a store name (which becomes `brand` when no brand is set), a
// pasted SKU, a variant option, a deep category path — and none of them is capped at input, because
// none of them is an ad-platform field at input. Capping them there would put Google's rules on the
// seller's own storefront; capping them here puts them exactly where they apply.
const TITLE_MAX = 150;
const DESCRIPTION_MAX = 5000;
const BRAND_MAX = 70;
/** One colour value; the attribute allows 100 across all of them but only 40 per colour, and a
 *  feed row carries one. */
const COLOR_MAX = 40;
const SIZE_MAX = 100;
const PRODUCT_TYPE_MAX = 750;
const CUSTOM_LABEL_MAX = 100;
/** `mpn` is 70 — but an identifier is not clamped, it is DROPPED. Half a manufacturer part number
 *  is not a shorter part number, it is a different one, and `identifierExists` would then be
 *  asserting that a wrong identifier exists. */
const MPN_MAX = 70;

/** Cut to `max` CHARACTERS without splitting a surrogate pair — slicing an emoji in half
 *  produces a lone surrogate, which is exactly what XML_ILLEGAL would then have to strip,
 *  turning a length fix into mojibake at the end of every long title. */
function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `sale_price_effective_date` — one string, `<start>/<end>`, each side
 * `YYYY-MM-DDThh:mm±hhmm` (checked against the attribute's own Merchant Center help page,
 * 2026-08-10; the spec's example is `2016-02-24T13:00-0800/2016-02-29T15:30-0800`).
 *
 * **Why send it at all, when it is optional.** Without it Google's own wording is that "the sale
 * price will be used for your product immediately" — with no end. Our feed is not pushed, it is
 * FETCHED on Google's schedule, so between the hour a seller's sale expires and the next fetch,
 * the feed advertises a price the landing page has already stopped honouring. That is a
 * feed/landing mismatch, the one family that gets accounts suspended (memory
 * `project_merchant_brand_mismatch_verified`) — and the seller never did anything wrong: they set
 * an end date and it arrived. This attribute is Google holding the expiry itself, so the gap
 * closes without depending on how fast anyone re-crawls.
 *
 * **The times are the seller's calendar day made explicit.** A schedule here is a date-only string
 * on the business calendar (`discounts.ts`), where `endsAt` is INCLUSIVE — the sale runs through
 * the end of that day. Written out that is 00:00 on the first day to 23:59 on the last, at the
 * offset Israel was actually on for each (`business-day.ts#businessOffsetForDay`, resolved per day
 * so a range crossing a DST change is right at both ends). Sending bare dates instead would let
 * Google apply its documented default of UTC, which retires an Israeli sale two or three hours
 * early on its last evening — the same off-by-one `priceValidUntil` exists to avoid, in hours
 * rather than days.
 */
function salePriceEffectiveDate(endsAt: string, startsAt: string | undefined, todayISO: string): string {
  // A discount with no start has been running since before anyone asked; the feed can only speak
  // for the catalogue it is generating, so today is the honest opening bound. The schedule is
  // known OPEN at this point (an unopened one is not discounted at all, so there is no sale price
  // to date), which is what guarantees start <= end.
  const from = startsAt ?? todayISO;
  return `${from}T00:00${businessOffsetForDay(from)}/${endsAt}T23:59${businessOffsetForDay(endsAt)}`;
}

/**
 * The two identifiers Google matches a product on, derived ONCE for every feed that names it.
 *
 * Split out of `buildProductFeedAttributes` (2026-08-17) when the product REVIEWS feed arrived and
 * needed the same two values. A review is joined to a product by `brand` + `mpn` + `product_url`,
 * so a review feed that derived them independently would attach a store's reviews to nothing the
 * moment either rule moved — and would do it silently, which is this project's known feed failure
 * mode (memory `project_feed_silent_rejection_class`). Same reasoning as `ad-item-id.ts`: one
 * product, one identity, whoever is asking.
 */
export function feedBrand(product: Pick<StoreProduct, 'brand'>, storeName: string): string {
  // The seller's own brand field when they filled one in (a reseller listing someone else's
  // product), else the store name. Merchant Center matches listings across the market on brand,
  // so getting this wrong doesn't just mislabel the item — it stops it joining the real product.
  return clampText((product.brand?.trim() || storeName).trim(), BRAND_MAX);
}

/** Over-length → no mpn at all, not a cut one (see MPN_MAX). */
export function feedMpn(product: Pick<StoreProduct, 'sku'>): string | undefined {
  return product.sku && product.sku.length <= MPN_MAX ? product.sku : undefined;
}

export function buildProductFeedAttributes(product: StoreProduct, ctx: FeedContext): FeedAttributes {
  const inferText = [ctx.categoryPath, product.name, ...(product.tags ?? [])];
  const g = inferAudienceGender(inferText);
  const gender: FeedAttributes['gender'] = g === 'men' ? 'male' : g === 'women' ? 'female' : 'unisex';
  const a = inferAgeGroup(inferText);
  const ageGroup: FeedAttributes['ageGroup'] = a === 'infant' ? 'infant' : a === 'kids' ? 'kids' : 'adult';

  const brand = feedBrand(product, ctx.storeName);
  const mpn = feedMpn(product);
  const gtin = undefined; // no barcode field yet — optional in the feed spec
  const identifierExists = Boolean(gtin || (mpn && brand));

  // One clock for the whole row. `nowMs` used to reach only the recency label while the PRICE read
  // the wall clock, so a test (or a feed rebuilt from a fixed instant) could pin one and not the
  // other; a scheduled sale would then be resolved against a different moment than the row it
  // labels. Same instant to both, and to the date range below.
  const now = ctx.nowMs !== undefined ? new Date(ctx.nowMs) : new Date();
  const pv = resolvePrice(product, ctx.sale, now);
  const saleWindow = activeDiscountWindow(product, ctx.sale, now);

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
  const shippingWeight = feedShippingWeight(product.weightGrams);
  const title = clampText(product.name.trim(), TITLE_MAX);
  const description = clampText(product.description.trim() || title, DESCRIPTION_MAX);

  return {
    // Through the shared helper even though it is the bare uuid: this line and the tracking
    // events are the two halves of one join, and `ad-item-id.ts` is where that is stated once.
    id: adItemId(product.id),
    title,
    description,
    availability: product.stock > 0 ? 'in_stock' : 'out_of_stock',
    price: pv.basePrice,
    ...(pv.isDiscounted ? { salePrice: pv.price } : {}),
    ...(pv.isDiscounted && saleWindow?.endsAt
      ? { salePriceEffectiveDate: salePriceEffectiveDate(saleWindow.endsAt, saleWindow.startsAt, businessDayISO(now)) }
      : {}),
    brand,
    condition: 'new',
    gender,
    ageGroup,
    ...(mpn ? { mpn } : {}),
    ...(gtin ? { gtin } : {}),
    ...(shippingWeight ? { shippingWeight } : {}),
    identifierExists,
    ...(ctx.categoryPath ? { productType: clampText(ctx.categoryPath, PRODUCT_TYPE_MAX) } : {}),
    customLabels: customLabels.map((l) => clampText(l, CUSTOM_LABEL_MAX)),
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
  /**
   * One product slug → the URL this feed publishes for it. Must be `custom-domain.ts#adLandingUrl`
   * bound to this store, which is also the URL that page serves and declares canonical when it is
   * reached this way.
   *
   * A closure rather than a slug + base, because the two must be one value and not two that agree.
   * They stopped agreeing the moment custom domains shipped: the feed built
   * `${platform.url}/${store}/${product}`, while a store on a verified domain 301s that URL to
   * `https://their-domain/${product}` and declares THAT its canonical. Merchant Center follows the
   * `<link>`, lands on a redirect to a domain the account has not claimed, and disapproves the item
   * — for the sellers who did the most to look professional. Nothing was wrong on either side alone:
   * the feed's URL resolved, the page's canonical was correct, and only the join was broken.
   *
   * **Publishing the seller's domain instead was the wrong half to move (corrected 2026-08-06).**
   * It made the two sides agree on a domain the advertising account cannot claim, which is the same
   * disapproval reached from the other direction — and unclaimable at any scale, since verification
   * is performed from the advertiser's account. The join is closed on the PLATFORM domain instead:
   * see `custom-domain.ts#AD_LANDING_PARAM` for why one marker settles link, redirect and canonical
   * together, and why the seller loses no SEO by it.
   */
  productLink: (productSlug: string) => string;
  baseUrl: string; // origin, no trailing slash — e.g. https://shop.example; used to absolutize images
}

/**
 * Can this product be ADVERTISED at all — i.e. will `buildFeedItems` emit anything for it?
 *
 * `image_link` and `price` are required attributes, so a product missing either is not a lesser
 * listing, it is no listing: the row would be rejected, and the platforms reject silently. That is
 * the whole of the feed's exclusion rule, stated once here because a second consumer needs it.
 *
 * **That second consumer is why this is exported (found 2026-08-06).** `ad-campaign-health.ts`
 * counts a campaign's products as `live` when they are visible on the STOREFRONT, which is a
 * different question — a product with no photo sits happily on the shelf and cannot be advertised.
 * So a campaign could report three live, buyable products while Merchant Center had rows for two,
 * and the seller paid for a campaign that was quietly smaller than its own card said. Both modules
 * were internally right; only the join was wrong, which is this project's recurring shape (see
 * `ad-item-id.ts` and `custom-domain.ts#AD_LANDING_PARAM`).
 *
 * Deliberately NOT a check on stock: a sold-out product still belongs in the catalogue, marked
 * `out_of_stock`. Availability is a state the feed reports, not a reason to withhold the item.
 *
 * **Not the same question `merchant-status.ts` asks, and the two must not be merged.** That module
 * asks the NETWORKS what they did with a row we sent — external truth, and only once the accounts
 * exist. This one is what we will not send in the first place: knowable offline, today, with no
 * account. A product excluded here never reaches Merchant Center at all, so it can never appear in
 * a rejection report — which is precisely the blind spot the two of them cover between them.
 */
export function isProductAdvertisable(product: StoreProduct, baseUrl: string): boolean {
  return adExclusionReason(product, baseUrl) === null;
}

/**
 * WHY a product will not be sent, or null when it will — the same rule as `isProductAdvertisable`,
 * with the answer kept rather than collapsed to a boolean.
 *
 * The reason is what lets the seller be TOLD. An exclusion he cannot see the cause of is the
 * silent-rejection failure this whole area exists to end: the product sits on his storefront
 * looking perfectly fine and no ad ever runs behind it.
 *
 * The three are not the same kind of problem, which is why they stay apart:
 *  · `no-image` / `no-price` — mechanical, his to fix in a minute, and self-healing.
 *  · `policy` — the ad networks' own prohibited-content list (`ad-policy.ts`). NOT self-healing and
 *    not merely this product's problem: both networks suspend the ACCOUNT, and this platform
 *    advertises every seller through one. Excluding the row is the whole protection.
 */
export type AdExclusionReason = 'no-price' | 'no-image' | 'policy';

export function adExclusionReason(product: StoreProduct, baseUrl: string): AdExclusionReason | null {
  if (product.price <= 0) return 'no-price';
  if (!(product.images ?? []).some((img) => toAbsoluteImageUrl(img, baseUrl) !== null)) return 'no-image';
  // Last, because it is the most expensive question and the other two already exclude the row.
  if (adPolicyViolation(product)) return 'policy';
  return null;
}

/** Expand one product into its feed rows (variant combos → item_group_id rows).
 *  Returns [] when a required field is missing (no usable image, or price ≤ 0) so the
 *  caller simply skips it rather than emitting a row the platforms would reject —
 *  `isProductAdvertisable` is that same rule, asked ahead of time. */
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
  // Through the shared rule, not a second copy of it: `isProductAdvertisable` is what
  // `ad-campaign-health.ts` counts with, and a feed that excluded a different set from the one the
  // seller's card reports would be the same join failure this file keeps being bitten by. It also
  // carries the prohibited-content check, which is the one exclusion here that protects the shared
  // ad ACCOUNT rather than this row (ad-policy.ts).
  if (!imageLink || !isProductAdvertisable(product, ctx.baseUrl)) return [];
  const additionalImageLinks = images.slice(1, 11); // Google caps additional images at 10
  // Colour option value → that colour's own photo, absolutized the same way the gallery was.
  // Membership in `images` is required rather than assumed: the product form only lets the seller
  // link a photo the product already has, but an image DELETED afterwards leaves the link behind,
  // and publishing a URL the product no longer shows is a landing-page mismatch. An entry that
  // fails either step is simply absent, and the row falls back to the gallery's first image.
  const galleryUrls = new Set(images);
  const variantImageByOption = new Map<string, string>();
  for (const [option, raw] of Object.entries(product.variantImages ?? {})) {
    const abs = toAbsoluteImageUrl(raw, ctx.baseUrl);
    if (abs && galleryUrls.has(abs)) variantImageByOption.set(option, abs);
  }
  // The page's own canonical, built by the page's own function — see FeedBuildContext.productLink.
  // (It percent-encodes per segment: slugs carry Hebrew and Merchant Center validates this as a
  // URL, not as display text.)
  const link = ctx.productLink(product.slug);

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
    const colorValue = colorDim ? combo[colorDim.name] : undefined;
    // **This row's own photo.** `variantImages` is keyed by the raw colour option value (not a
    // comboKey — a colour implies the photo regardless of size), and the seller can only point it
    // at one of this product's own images, so it is already trusted. Before this, every row of a
    // variant product shipped `images[0]`: a row declaring `color: אדום` carried the blue photo,
    // which for a colour variant is the one mismatch Merchant Center checks a variant row FOR, and
    // is a wrong-product ad even when it is not disapproved. Falls back to the gallery's first
    // image whenever the seller has linked no photo to this colour, or the linked one does not
    // resolve — the row keeps the image it had rather than losing its listing over a nicety.
    const comboImage = (colorValue ? variantImageByOption.get(colorValue) : undefined) ?? imageLink;
    return {
      ...base,
      id: adComboItemId(product.id, key),
      itemGroupId: product.id,
      availability: stock > 0 ? 'in_stock' : 'out_of_stock',
      // Slot 2 recomputed from THIS combo's stock — the other four describe the product and are
      // correct as inherited (product-labels.ts#AVAILABILITY_SLOT).
      customLabels: base.customLabels.map((l, i) => (i === AVAILABILITY_SLOT ? availabilityTier(stock) : l)),
      // The landing carries the combo, so an ad click arrives on the variant it advertised rather
      // than on an unselected page (variant-landing.ts).
      link: variantLandingUrl(link, combo),
      imageLink: comboImage,
      // Never repeat the main image in the additional list — Google reads a duplicate as a second
      // picture and shows the same photo twice in the gallery.
      additionalImageLinks: images.filter((u) => u !== comboImage).slice(0, 10),
      ...(comboMpn && comboMpn.length <= MPN_MAX ? { mpn: comboMpn, identifierExists: Boolean(base.brand) } : {}),
      ...(colorValue ? { color: clampText(colorValue, COLOR_MAX) } : {}),
      ...(sizeDim && combo[sizeDim.name] ? { size: clampText(combo[sizeDim.name]!, SIZE_MAX) } : {}),
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
  // Emitted only next to a sale_price — on its own it is an attribute dating a price that has no
  // sale, which the builder above cannot produce and this line must not invent.
  if (it.salePrice !== undefined && it.salePriceEffectiveDate) {
    lines.push(g('sale_price_effective_date', it.salePriceEffectiveDate));
  }
  lines.push(g('brand', it.brand));
  lines.push(g('condition', it.condition));
  lines.push(g('gender', it.gender));
  lines.push(g('age_group', it.ageGroup));
  if (it.productType) lines.push(`  <g:product_type>${cdata(it.productType)}</g:product_type>`);
  if (it.color) lines.push(g('color', it.color));
  if (it.size) lines.push(g('size', it.size));
  if (it.mpn) lines.push(g('mpn', it.mpn));
  if (it.gtin) lines.push(g('gtin', it.gtin));
  if (it.shippingWeight) lines.push(g('shipping_weight', it.shippingWeight));
  if (!it.identifierExists) lines.push(g('identifier_exists', 'no'));
  it.customLabels.forEach((l, i) => lines.push(g(`custom_label_${i}`, l)));
  return `<item>\n${lines.join('\n')}\n</item>`;
}

/**
 * The document, in its three pieces — because it is no longer built in one go.
 *
 * The feed is written to storage a part at a time by a job (`feed-document.ts` → `artifacts.ts`),
 * so the header, each item and the footer have to be obtainable separately. They are exported
 * rather than inlined at the call site for the obvious reason: two places writing the same
 * document's frame is two places to get an `<rss>` attribute wrong, and the one that ships is the
 * one Google parses. `toMerchantXml` below is now composed of exactly these, which is what makes
 * "the streamed document equals the single-shot one" a property rather than a hope — and
 * `tests/catalog-artifacts.test.ts` asserts it byte for byte over real rows anyway, because the
 * risk that remains is the ORDER the parts are produced in, not the parts.
 */
export function feedXmlHeader(meta: FeedChannelMeta): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>${xmlEscape(meta.title)}</title>
<link>${xmlEscape(meta.link)}</link>
<description>${xmlEscape(meta.description)}</description>
`;
}

/** Items are joined with a newline, so the separator belongs to whoever emits the SECOND one — the
 *  footer's leading newline closes the last item's line, and an empty feed keeps the blank line the
 *  single-shot version always produced. */
export const FEED_XML_FOOTER = `
</channel>
</rss>
`;

/** One `<item>`, the unit the streamed build emits. */
export function feedItemXml(item: FeedItem, currency: string): string {
  return itemXml(item, currency);
}

/** Serialize feed rows to a Google Merchant Center RSS 2.0 feed (the `g:`
 *  namespace) — the same document Meta Catalog ingests as a data-feed URL, so
 *  one endpoint drives both. */
export function toMerchantXml(items: FeedItem[], meta: FeedChannelMeta): string {
  const body = items.map((it) => itemXml(it, meta.currency)).join('\n');
  return `${feedXmlHeader(meta)}${body}${FEED_XML_FOOTER}`;
}
