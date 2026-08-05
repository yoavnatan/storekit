import { cdnFill, cdnThumb, store as platform } from '../config/store.config.js';
import { stripTrailingSlashes } from './url-base.js';

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

/** The browser's own icon slots — a store page's tab and its iOS home screen.
 *
 *  DELIBERATELY NOT IN `STORE_IMAGE_FORMATS`, and this is the reason: that map is
 *  not a list of available sizes, it is the COMPLETE set of ratios an ad asset
 *  group requires, and `storeAdCreative` submits every entry of it. A favicon
 *  added there would be offered to Google and Meta as ad creative. Same renderer,
 *  same route, different question — so, a different map. */
export type StoreIconFormat = 'favicon' | 'touch';

export const STORE_ICON_FORMATS: Readonly<Record<StoreIconFormat, { width: number; height: number }>> = {
  /** 64px, not 32: it is the largest slot a browser picks from a single icon
   *  (tab strips ask for 32 at 2x DPR), and one file is cheaper than three. */
  favicon: { width: 64, height: 64 },
  /** 180px — what iOS asks for when a store page is added to the home screen. */
  touch: { width: 180, height: 180 },
};

/** Everything `/api/store-image` can rasterise, both maps at once. */
export type StoreRenderFormat = StoreImageFormat | StoreIconFormat;
export const STORE_RENDER_FORMATS: Readonly<Record<StoreRenderFormat, { width: number; height: number }>> = {
  ...STORE_IMAGE_FORMATS,
  ...STORE_ICON_FORMATS,
};

export interface StoreImageSource {
  slug: string;
  profileImage?: string;
  bannerImage?: string;
}

export function isStoreRenderFormat(value: string): value is StoreRenderFormat {
  return Object.prototype.hasOwnProperty.call(STORE_RENDER_FORMATS, value);
}

/**
 * Which uncropped original belongs with the image a settings save just decided on
 * (migration 0012, `*_image_source`).
 *
 * It exists because the settings form is merged FIELD BY FIELD against whatever a second tab
 * saved meanwhile (record-rev.ts), and a source is not a field in that sense — it is the photo
 * its crop was cut from. Merged independently, two tabs that both changed the picture could leave
 * tab A's crop stored beside tab B's original, and the next "adjust" would then re-frame a
 * different photo than the one on screen: the seller nudges the avatar and a completely different
 * image appears. So the merge settles the visible image and this follows it.
 *
 * `chosen` empty means the seller removed the image; the original it came from is then dead weight
 * that nothing can ever reach, so it goes too.
 *
 * The UNCHANGED case is checked before the submitted one, and that ordering is the whole safety of
 * this function: a save that leaves the picture alone must keep the stored original whatever the
 * request happens to carry. Otherwise a POST without the field — a tab still running the previous
 * deploy, a script, a form built by hand — silently strips a source it never knew existed, and the
 * loss only shows up much later as an "adjust" that has nothing to re-frame.
 */
export function pairedImageSource(image: {
  chosen: string | undefined;
  submitted: string | undefined;
  submittedSource: string | undefined;
  stored: string | undefined;
  storedSource: string | undefined;
}): string | undefined {
  if (!image.chosen) return undefined;
  if (image.chosen === image.stored) return image.storedSource;
  return image.chosen === image.submitted ? image.submittedSource : image.storedSource;
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
 *  Slug and format are separate path segments on purpose: a slug holds letters, digits and `-`
 *  (url-base.ts#toSlug), so any in-filename separator could also occur inside the slug itself.
 *  Those letters may be Hebrew since 2026-08-02, which is what `encodeURIComponent` is for —
 *  the route's `[slug]` param is decoded back by Astro before it reaches getStoreBySlug. */
export function storeMarkPath(slug: string, format: StoreRenderFormat): string {
  return `/api/store-image/${encodeURIComponent(slug)}/${format}.png`;
}

/** The format in a `<format>.png` filename, or null if it isn't one of ours. */
export function parseStoreImageFile(file: string): StoreRenderFormat | null {
  const m = file.match(/^([a-z]+)\.png$/);
  return m && m[1] && isStoreRenderFormat(m[1]) ? m[1] : null;
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

/**
 * The store's icon for a BROWSER slot — the tab and the iOS home screen.
 *
 * A separate function from `resolveStoreImage` rather than another format passed
 * to it, because the delivery differs where it matters. Off-site consumers get
 * `cdnFill`, which forces `f_jpg` (many scrapers send no `Accept` header that
 * `f_auto` could read) — and a JPEG has no alpha, so a logo uploaded with a
 * transparent background would arrive as a black square in the tab strip. A
 * browser always sends `Accept`, so this uses `cdnThumb`/`f_auto` and keeps
 * whatever transparency the seller uploaded.
 *
 * Same "never empty" guarantee as the rest of this file, and the same refusal:
 * a URL Cloudinary cannot transform falls back to the generated mark instead of
 * putting a full-size original in a 32px tab.
 */
export function storeIconUrl(store: StoreImageSource, format: StoreIconFormat): string {
  const { width, height } = STORE_ICON_FORMATS[format];
  const upload = store.profileImage?.trim();
  if (upload) {
    const thumb = cdnThumb(upload, width, height);
    if (thumb && thumb !== upload) return thumb;
  }
  return storeMarkPath(store.slug, format);
}

/** As `resolveStoreImage`, absolute — what every off-site consumer needs. */
export function storeImageUrl(
  store: StoreImageSource,
  format: StoreImageFormat,
  baseUrl: string = platform.url,
): string {
  const { src } = resolveStoreImage(store, format);
  return src.startsWith('http') ? src : `${stripTrailingSlashes(baseUrl)}${src}`;
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
