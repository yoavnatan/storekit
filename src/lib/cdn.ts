/**
 * THE one place a raw image URL becomes an optimized delivery URL.
 *
 * Every <img> in the app — Astro markup, client-rendered template strings, ad
 * feeds, emails — must route its src through a function in this file. Nothing
 * else in the codebase is allowed to hand a raw uploaded/remote URL to an <img>;
 * `tests/image-optimization.test.ts` enforces that mechanically so it can't
 * silently regress in the next component somebody writes.
 *
 * Why it exists: a raw source URL is the WRONG image twice over.
 *   1. Size — a 1000px original painted into a 220px tile is ~8x the bytes it
 *      needs (measured on the demo set: 82KB → 10KB at w_220).
 *   2. Caching — third-party hosts routinely forbid caching. The demo dataset's
 *      host (cdn.dummyjson.com) sends `cache-control: no-store`, so every single
 *      page refresh re-downloaded every image from scratch. Nothing on our side
 *      can override that header; the only fix is to stop pointing at that host.
 *
 * Both are solved by delivering through Cloudinary:
 *   • Cloudinary uploads (what real sellers produce) get the transform injected
 *     into the /upload/ path — same as before.
 *   • ANY other reachable remote URL goes through Cloudinary's *fetch* delivery
 *     (`/image/fetch/<transform>/<encoded url>`): Cloudinary pulls the origin
 *     once, then serves a resized, auto-format (webp/avif), auto-quality copy
 *     with `max-age=604800`. No upload step, no storage, no seed migration.
 *
 * Cost note: fetch delivery bills a transformation per distinct URL, once, and
 * only for NON-Cloudinary origins — i.e. in practice only for the demo dataset.
 * Real seller images are Cloudinary uploads and never touch the fetch path.
 */

const CLOUD = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME as string | undefined;

/** A Cloudinary delivery URL — capture the cloud, the delivery type, and the rest. */
const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/(upload|fetch)\/(.+)$/;

/** A leading transform segment (`f_auto,q_auto,w_300/…`) — already optimized, leave it alone. */
const HAS_TRANSFORM = /^(f|q|c|w|h|g|e|b|bo|co|ar|fl|dpr)_/;

/**
 * Hosts Cloudinary's fetch delivery cannot reach: it pulls the origin from its
 * own servers, so a dev machine's URL would 404 on their side. Such URLs are
 * handed back untouched (unoptimized, but working) rather than broken.
 */
const UNREACHABLE_HOST = /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|::1$)|\.(test|local|localhost|internal)$/;

/** Builds the delivery URL for `url` under `transform`, or returns `url` unchanged
 *  when it can't be improved (relative path, data:/blob:, dev-only host, already
 *  transformed, or no Cloudinary cloud configured). Never throws.
 *  `replaceExisting` overwrites a transform that's already on the URL instead of
 *  leaving it alone — for callers that must guarantee the output dimensions. */
function deliver(url: string, transform: string, replaceExisting = false): string {
  if (!url) return url;

  const cloudinary = url.match(CLOUDINARY_URL);
  if (cloudinary) {
    const [, cloud, type, rest] = cloudinary;
    if (!rest) return url;
    const transformed = HAS_TRANSFORM.test(rest);
    if (transformed && !replaceExisting) return url;
    const path = transformed ? rest.replace(/^[^/]*\//, '') : rest;
    if (!path) return url;
    return `https://res.cloudinary.com/${cloud}/image/${type}/${transform}/${path}`;
  }

  // Relative paths, data: and blob: URIs are already local/inline — nothing to gain.
  if (!/^https?:\/\//i.test(url)) return url;
  if (!CLOUD) return url;

  let host: string;
  try { host = new URL(url).hostname; } catch { return url; }
  if (UNREACHABLE_HOST.test(host)) return url;

  return `https://res.cloudinary.com/${CLOUD}/image/fetch/${transform}/${encodeURIComponent(url)}`;
}

/**
 * The default: an image scaled to `w` CSS pixels, auto format + auto quality.
 * Pair with `cdnSrcSet` + a `sizes` attribute whenever the tile is responsive.
 *
 * **`c_limit`, not a bare `w_`, and this is a correctness fix rather than a tuning knob
 * (2026-08-05).** A bare `w_` means `c_scale`, which happily invents pixels that were never in the
 * upload — so every width in `LIGHTBOX_WIDTHS`/`BANNER_WIDTHS` above the seller's own resolution was
 * being served as an upscale: softer than the source AND heavier than it. Measured on Cloudinary's
 * public `demo` cloud against `sample.jpg` (864x576 native), same URL otherwise:
 *
 *     f_jpg,q_auto,w_2048           → 2048x1365, 202KB   ← invented, blurry
 *     c_limit,f_jpg,q_auto,w_2048   →  864x576,   97KB   ← the actual picture, half the bytes
 *
 * `c_limit` is a CEILING: at or below the source it behaves exactly as before, above it it stops.
 * Nothing in the layout depends on the returned pixel size — every consumer draws into a CSS box
 * with `object-fit` — so a rung that caps out simply hands the browser the sharpest image that
 * exists. `image-derive.ts` warms its rungs through this same function, so the pre-rendered
 * transform stays byte-identical to what the markup asks for (the pairing `LIGHTBOX_WIDTHS`
 * describes below); that is why the ceiling belongs here and not at the call sites.
 */
export function cdnSrc(url: string, w = 400): string {
  return deliver(url, `c_limit,f_auto,q_auto,w_${w}`);
}

/**
 * The only widths a full-screen (lightbox) image is ever requested at, and the
 * widths `image-derive.ts` pre-renders when a seller saves a product.
 *
 * It lives HERE, not in either consumer, because the two must agree exactly: the
 * viewer picks a rung (`lightboxWidth`) and the save path derives the rungs. A
 * width the viewer asks for but nobody pre-derived costs the buyer ~1.2s of
 * Cloudinary render time before a byte moves, which is the whole thing this
 * pairing exists to prevent — so drifting them apart fails silently and slowly.
 * 800 doubles as the gallery main image, so all three are worth having warm.
 */
export const LIGHTBOX_WIDTHS = [800, 1200, 1600] as const;

/**
 * The store banner's frame, and the only widths it is ever requested at — which, for exactly the
 * reason written above `LIGHTBOX_WIDTHS`, are also the widths `image-derive.ts` pre-renders when a
 * seller saves their store.
 *
 * It lives HERE and not in the store page because THREE places have to agree: the page that builds
 * the `srcset`, the `<head>` preload that must request the byte-identical URL, and the warm-up that
 * renders them before the first visitor arrives. A width in the markup that nobody pre-derived is
 * the cold render this pairing exists to prevent — and the banner is the store page's LCP element,
 * making it the single worst place on the site to pay it. Measured 2026-08-03: ~0.80s of Cloudinary
 * render time on the first request for a given transform, ~0.19s on every one after.
 *
 * 3/1 because that is both the frame `.store-banner__image-wrap` paints into and the fixed aspect
 * the dashboard's own crop tool already produces (`seller/dashboard.astro`'s `#banner-frame`,
 * `aspect: 3`). So on a real seller upload `c_fill` is a pure resize with nothing left to re-frame,
 * and the pixels reaching the visible band are identical to an uncropped delivery's — the crop only
 * ever removes what `object-fit: cover` was going to throw away.
 */
export const BANNER_RATIO = 3;
export const BANNER_WIDTHS = [800, 1200, 1600, 2048] as const;

/**
 * Whether the delivery URL for `url` can have its pixels read back in a canvas
 * — i.e. whether it is safe to put `crossorigin="anonymous"` on that <img>.
 *
 * It lives here because the answer is a fact about Cloudinary, and this file
 * owns every Cloudinary fact: Cloudinary delivery sends
 * `access-control-allow-origin: *`, so anything `deliver()` routes through it is
 * readable. Anything it hands back untouched (relative path, dev-only host, no
 * cloud configured) is NOT — and there `crossorigin` would stop the image
 * loading altogether rather than merely leaving the canvas tainted, so callers
 * must ask before tagging. Width is irrelevant to the answer.
 */
export function cdnIsSampleable(url: string): boolean {
  return cdnSrc(url).startsWith('https://res.cloudinary.com/');
}

/**
 * Responsive `srcset` (width descriptors) — pair with a `sizes` attribute so
 * hi-DPI screens get enough pixels and the photo stays sharp (a single width
 * gets browser-upscaled → visibly blurry).
 * Returns '' when the URL can't be transformed, so the caller keeps its plain src.
 */
export function cdnSrcSet(url: string, widths: number[]): string {
  if (!widths.length || cdnSrc(url, widths[0]) === url) return '';
  return widths.map((w) => `${cdnSrc(url, w)} ${w}w`).join(', ');
}

/**
 * Responsive `srcset` for a box with a FIXED ASPECT RATIO — the same width
 * descriptors as `cdnSrcSet`, but every rung cropped to `w × w/ratio` at the CDN
 * rather than delivered at the source's own proportions. Pair it with a `src`
 * from `cdnThumb` at the same ratio.
 *
 * Why it exists, and when to reach for it: an `object-fit: cover` box discards
 * every pixel outside its aspect ratio — AFTER the browser has paid to download
 * and decode them. So a wide box fed a tall source is buying pixels it has
 * already decided to throw away. The store banner is the case that found this:
 * a 3/1 frame, and sellers routinely upload a square photo, so two thirds of the
 * bytes were waste. Measured 2026-08-03 against a 1000x1000 source, same visible
 * result: w_1600 uncropped 84.5KB / cropped 32.2KB; w_2048 112KB / 40.6KB.
 *
 * `g_auto` (inherited from cdnThumb) is what makes the crop safe — Cloudinary
 * picks the crop window from the image's own content, so the subject survives the
 * ratio change instead of being centre-cropped out of frame.
 *
 * Use `cdnSrcSet` instead whenever the box is `object-fit: contain`, or its
 * height is driven by the image: there the source's proportions are the point,
 * and cropping would cut the picture.
 *
 * Returns '' when the URL can't be transformed, so the caller keeps its plain src.
 */
export function cdnCropSrcSet(url: string, widths: number[], ratio: number): string {
  if (!widths.length || !ratio || cdnThumb(url, widths[0], 1) === url) return '';
  return widths.map((w) => `${cdnThumb(url, w, Math.round(w / ratio))} ${w}w`).join(', ');
}

/** A square-ish thumbnail cropped to fill exactly w×h, with Cloudinary choosing the
 *  crop window (`g_auto`) so the subject survives the aspect-ratio change.
 *  This is the right call for every fixed-size tile: cart rows, order rows,
 *  dashboard tables, search results. */
export function cdnThumb(url: string, w = 84, h = 84): string {
  // **`c_fill` STAYS, and `c_lfill` was tried and rejected here on 2026-08-05 — write this down so
  // it isn't "fixed" again.** `cdnSrc` gained `c_limit` that day to stop the CDN inventing pixels
  // above the source, and the same reasoning appears to apply to the banner's rungs, which reach
  // w_2048 through this function. It does not. Measured on the `demo` cloud, `sample.jpg` (864x576),
  // asking for a 3:1 band at 2048 wide:
  //     c_fill,g_auto,…,w_2048,h_683  → 2048x683, 112KB  ← upscaled, but cropped to the band
  //     c_lfill,g_auto,…,w_2048,h_683 →  864x576,  97KB  ← NOT cropped: the ratio is abandoned
  // `lfill` stops filling altogether once the box is bigger than the source, so it hands back the
  // whole uncropped photo — and `cdnCropSrcSet` exists precisely to stop shipping the pixels outside
  // that band (84.5KB → 32.2KB, measured 2026-08-03). It would trade a soft image for a heavier one
  // and re-introduce client-side cropping. The real fix for an undersized banner is to not OFFER a
  // rung above the source, which needs the stored dimensions this module does not have.
  return deliver(url, `c_fill,g_auto,f_auto,q_auto,w_${w},h_${h}`);
}

/**
 * A round icon cropped to exactly w×h with transparent corners — the browser-tab
 * icon for a store that uploaded a logo (store-image.ts#storeIconUrl).
 *
 * `r_max` is the circle. `f_png` rather than `f_auto` is the part worth keeping:
 * `f_auto` picks the format from the request's `Accept`, and for a photographic
 * source it can legitimately pick JPEG — which has no alpha, so the corners the
 * radius just cut would come back as black. A format that cannot express the
 * transformation must not be reachable from it.
 *
 * Returns '' when the URL can't be transformed, so callers fall back to the
 * generated mark rather than putting a full-size original in a 32px tab.
 */
export function cdnCircle(url: string, w: number, h: number): string {
  const out = deliver(url, `c_fill,g_auto,r_max,f_png,q_auto,w_${w},h_${h}`, true);
  return out === url ? '' : out;
}

/**
 * An image forced to EXACT pixel dimensions for OFF-SITE consumers (ad platforms,
 * social scrapers, structured-data crawlers). `f_jpg` is explicit rather than
 * `f_auto` because many of those fetch without an `Accept` header that `f_auto`
 * can read.
 *
 * Returns '' when the exact size CANNOT be guaranteed (unreachable host, no cloud
 * configured, or an already-transformed URL). Callers that promise a format — see
 * store-image.ts — treat '' as "no usable source" and fall back to the generated
 * mark, rather than handing an ad platform an image at whatever ratio it happens
 * to have.
 */
export function cdnFill(url: string, w: number, h: number): string {
  const out = deliver(url, `c_fill,g_auto,f_jpg,q_auto,w_${w},h_${h}`, true);
  return out === url ? '' : out;
}
