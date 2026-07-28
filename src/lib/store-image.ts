import { cdnFill, store as platform } from '../config/store.config.js';

/**
 * The one place that answers "what image represents this store, at this exact
 * size?" — and it ALWAYS answers. Every off-site surface (ad creative,
 * `og:image`, structured data) goes through here, so none of them can end up
 * with an empty URL or an image at a ratio the consumer rejects.
 *
 * Two guarantees, in order:
 *  1. Exact dimensions. A seller's uploaded image is served through Cloudinary
 *     at the requested size (`cdnFill`). If it can't be transformed — a legacy
 *     or externally-hosted URL — it is NOT used, because "the right picture at
 *     the wrong ratio" is what gets an ad creative rejected.
 *  2. Never empty. With no usable upload, the store's generated mark
 *     (store-mark.ts) is rendered at exactly that size by /api/store-image.
 *
 * Deliberately NOT covered here: the product feed (product-feed.ts). Merchant
 * Center / Meta Catalog items carry the PRODUCT photo and a `brand` string; there
 * is no store-image field in a feed, and a product with no photo is dropped from
 * it on purpose. Store imagery is for store-level campaigns and shares.
 */

export type StoreImageFormat = 'logo' | 'square' | 'portrait' | 'landscape';

/** The sizes external platforms actually ask for. Kept small and fixed on
 *  purpose: the fallback endpoint renders pixels per request, so the set of
 *  renderable sizes has to be a closed whitelist, not a query parameter. */
export const STORE_IMAGE_FORMATS: Readonly<Record<StoreImageFormat, { width: number; height: number }>> = {
  /** Square brand slot — Merchant Center / Business Profile logo. */
  logo: { width: 512, height: 512 },
  /** 1:1 feed creative (Meta feed, Google PMax square). */
  square: { width: 1080, height: 1080 },
  /** 4:5 — the tallest ratio Meta's feed accepts. */
  portrait: { width: 1080, height: 1350 },
  /** 1.91:1 — Meta link ads, Google PMax landscape, and the `og:image` default. */
  landscape: { width: 1200, height: 628 },
};

/** The format `og:image` uses: 1.91:1 is what Facebook/WhatsApp/iMessage crop to. */
export const OG_IMAGE_FORMAT: StoreImageFormat = 'landscape';

export interface StoreImageSource {
  slug: string;
  profileImage?: string;
  bannerImage?: string;
}

export function isStoreImageFormat(value: string): value is StoreImageFormat {
  return Object.prototype.hasOwnProperty.call(STORE_IMAGE_FORMATS, value);
}

/** Wide formats lead with the banner (shot wide), square ones with the avatar. */
function preferredSources(store: StoreImageSource, format: StoreImageFormat): string[] {
  const wide = format === 'landscape' || format === 'portrait';
  const ordered = wide
    ? [store.bannerImage, store.profileImage]
    : [store.profileImage, store.bannerImage];
  return ordered.filter((url): url is string => !!url && url.trim().length > 0);
}

/** Path of the generated mark for a store — served by /api/store-image.
 *  Slug and format are separate path segments on purpose: a slug is `[a-z0-9-]`,
 *  so any in-filename separator could also occur inside the slug itself. */
export function storeMarkPath(slug: string, format: StoreImageFormat): string {
  return `/api/store-image/${encodeURIComponent(slug)}/${format}.png`;
}

/** The format in a `<format>.png` filename, or null if it isn't one of ours. */
export function parseStoreImageFile(file: string): StoreImageFormat | null {
  const m = file.match(/^([a-z]+)\.png$/);
  return m && m[1] && isStoreImageFormat(m[1]) ? m[1] : null;
}

/**
 * Site-relative-or-absolute image URL for `store` at `format`. Never returns ''.
 * `hasUpload` tells a caller whether it got the seller's own image or the
 * generated mark — used where the distinction is a factual claim (a generated
 * tile is the store's mark, but it is not the store's `logo` in schema.org's
 * sense, so structured data must not present it as one).
 */
export function resolveStoreImage(
  store: StoreImageSource,
  format: StoreImageFormat,
): { src: string; hasUpload: boolean } {
  const { width, height } = STORE_IMAGE_FORMATS[format];
  for (const source of preferredSources(store, format)) {
    const filled = cdnFill(source, width, height);
    if (filled) return { src: filled, hasUpload: true };
  }
  return { src: storeMarkPath(store.slug, format), hasUpload: false };
}

/** As `resolveStoreImage`, absolute — what every off-site consumer needs. */
export function storeImageUrl(
  store: StoreImageSource,
  format: StoreImageFormat,
  baseUrl: string = platform.url,
): string {
  const { src } = resolveStoreImage(store, format);
  return src.startsWith('http') ? src : `${baseUrl.replace(/\/+$/, '')}${src}`;
}

/**
 * Every store-level image asset a campaign needs, absolute, all four ratios
 * present — the shape Google Performance Max asset groups and Meta ad sets ask
 * for (a square, a landscape, a portrait, plus a logo slot).
 *
 * The point of returning the complete set unconditionally: an asset group is
 * rejected as a whole when a required ratio is missing, so a boost campaign
 * (`ad-campaigns.ts`, scope 'store') must never be in a position where it can't
 * be submitted because this particular seller skipped the upload step. There is
 * no partial state to handle — only "the seller's picture" or "the store's
 * mark", both at the exact required size.
 */
export function storeAdCreative(
  store: StoreImageSource,
  baseUrl: string = platform.url,
): Record<StoreImageFormat, string> {
  const formats = Object.keys(STORE_IMAGE_FORMATS) as StoreImageFormat[];
  return Object.fromEntries(formats.map((f) => [f, storeImageUrl(store, f, baseUrl)])) as Record<
    StoreImageFormat,
    string
  >;
}
