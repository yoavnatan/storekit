/**
 * Pre-render a product's images at the widths buyers will ask for, at SAVE time.
 *
 * Why: Cloudinary renders a given transform lazily, on the first request for it.
 * That first request costs ~1.2–2.0s of server-side render before a single byte
 * moves; every request after it is ~0.3s (measured 2026-07-29). Nothing in the
 * app was paying that cost at a harmless moment — so it landed on whichever
 * buyer happened to be the first to open a particular photo full-screen, who sat
 * watching a loading state for two seconds because they were unlucky.
 *
 * Moving it here spends it while a seller is saving a product — a moment that is
 * already asynchronous, already slow, and belongs to someone who is not waiting
 * on this. The buyer then always hits a warm render.
 *
 * `HEAD`, not `GET`: a HEAD triggers the derivation exactly like a GET (verified
 * — a cold HEAD takes the same ~1.7s, and the following GET is warm) while
 * transferring no image bytes to our server. Warming 5 images at 3 widths costs
 * us 15 requests and roughly nothing in bandwidth.
 *
 * Best-effort in the same sense as `indexnow.ts`: never awaited by a request
 * handler, never throws, and a failure just restores today's behaviour (the
 * buyer pays the cold render) rather than breaking the save.
 *
 * Wired to the single-product save paths only (`/api/product` add / edit /
 * patch-images). The bulk paths (CSV import, `/api/store-product/bulk`) are left
 * out ON PURPOSE, not by oversight: one import can create hundreds of products,
 * and a naive per-product call there is a burst of thousands of requests at the
 * CDN — `MAX_IMAGES` bounds a single call, not a loop around it. Warming a bulk
 * import needs its own paced queue; until that exists, bulk-created products
 * keep the old behaviour and the first buyer pays the render once.
 */
import { cdnSrc, cdnThumb, LIGHTBOX_WIDTHS, BANNER_WIDTHS, BANNER_RATIO } from './cdn.js';

/**
 * A hard ceiling on one call's fan-out. The product form caps a product at 5
 * images, so this is only ever reached by a caller passing something unbounded —
 * and a burst of derivations is exactly how you get rate-limited by the CDN.
 */
const MAX_IMAGES = 5;

/** Per-request timeout. A derivation that hasn't answered by now is not worth
 *  holding a socket for — the buyer's own request would trigger it anyway. */
const TIMEOUT_MS = 20_000;

/**
 * Ask the CDN to render `urls` at every lightbox width, without waiting.
 *
 * Pass only the images that are genuinely NEW to this product — a re-save that
 * didn't touch the gallery should not re-request renders that already exist.
 * Deliberately takes no memo/cache of its own: the caller comparing old images
 * against new is both cheaper and correct across server restarts, and a
 * process-local Set would be shared write state on a stateless route.
 */
export function warmImageDerivations(urls: string[]): void {
  void deriveImageRenders(urls);
}

/** The awaitable half — exported for tests; callers use `warmImageDerivations`. */
export async function deriveImageRenders(urls: string[]): Promise<void> {
  try {
    const targets = Array.from(new Set(urls.filter(Boolean))).slice(0, MAX_IMAGES);
    if (!targets.length) return;

    const requests: Promise<unknown>[] = [];
    for (const url of targets) {
      for (const w of LIGHTBOX_WIDTHS) {
        const delivery = cdnSrc(url, w);
        // `cdnSrc` hands back the input unchanged when it can't be improved —
        // a relative path, a dev-only host, no cloud configured. Nothing to warm
        // there, and firing at the original host would be a pointless hit on it.
        if (delivery === url) continue;
        requests.push(
          fetch(delivery, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined),
        );
      }
    }
    await Promise.all(requests);
  } catch {
    // best-effort; a cold render for the first buyer is the worst outcome
  }
}

/**
 * The same warm-up for a store's BANNER — the one image on the site where a cold render is most
 * expensive, because it is the store page's LCP element.
 *
 * It was the gap this whole mechanism existed to close and did not: product photos have been
 * pre-derived since 2026-07-29, while the banner — bigger, above the fold, and the thing Lighthouse
 * actually times — was left to whoever visited a store first. That visitor waited ~0.8s for
 * Cloudinary to render before a byte moved, and with one banner per store it is a different unlucky
 * visitor for every store in the mall (owner kept measuring it, 2026-08-03).
 *
 * Cropped rungs, not `cdnSrc` ones: these must be the exact URLs `[storeSlug]/index.astro` puts in
 * its `srcset` and its `<head>` preload, or the warm-up renders transforms nobody asks for and the
 * visitor still pays for the ones they do. All three read `BANNER_WIDTHS`/`BANNER_RATIO` from
 * `cdn.ts` so they cannot drift apart.
 */
export function warmBannerDerivations(url: string | undefined | null): void {
  void deriveBannerRenders(url);
}

/** The awaitable half — exported for tests; callers use `warmBannerDerivations`. */
export async function deriveBannerRenders(url: string | undefined | null): Promise<void> {
  try {
    if (!url) return;
    const requests = BANNER_WIDTHS.map((w) => {
      const delivery = cdnThumb(url, w, Math.round(w / BANNER_RATIO));
      // Handed back unchanged = nothing Cloudinary will serve (relative path, dev host, no cloud).
      if (delivery === url) return undefined;
      return fetch(delivery, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
    }).filter(Boolean);
    await Promise.all(requests);
  } catch {
    // best-effort, exactly as above
  }
}
