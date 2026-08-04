/** Removes `is-loading` (the shared shimmer class, see utils.css's skeleton-shimmer
 *  keyframe) off `wrapSelector`'s closest ancestor once `img` actually loads or errors —
 *  never a fixed timer, so a slow/broken image can't flash the shimmer away early or get
 *  stuck showing a blank gap. Shared by every page that renders a shimmer-while-loading
 *  image grid (homepage shelves/carousels, /stores directory) instead of each page
 *  re-wiring the same load/error listener pair. */
export function clearSkeletonOnLoad(img: HTMLImageElement, wrapSelector: string): void {
  const wrap = img.closest<HTMLElement>(wrapSelector);
  if (!wrap) return;
  const done = () => wrap.classList.remove('is-loading');
  // This only STOPS THE SHIMMER — it does not reveal the image. The image paints
  // over the shimmer on its own (the CSS keeps the shimmer underneath it), because
  // gating visibility on this module meant a warm-cache refresh sat on invisible,
  // already-decoded photos until the page bundle executed — see store-card.css.
  // img.src (not just .complete) — an <img> with no src yet reads .complete as
  // trivially true, which would strip the shimmer immediately instead of waiting for
  // the real image to actually load.
  if (img.src && img.complete && img.naturalWidth > 0) done();
  else {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }
}

/**
 * How early a tile is allowed to start saying "loading" — it must match the margin the
 * BROWSER uses to trigger `loading="lazy"`, so the shimmer starts at roughly the moment
 * the fetch does.
 *
 * It was 250px, chosen as "about when the lazy fetch starts", and that guess was wrong in
 * the expensive direction: Chrome begins a lazy fetch far earlier than that (viewport
 * distance, well over a thousand pixels, and more on a slow connection), so a tile only
 * reached 250px long after its image had finished. Measured 2026-08-04 on the homepage
 * over a throttled connection: at 250px, scrolling the whole page produced **zero**
 * shimmers — every tile hit `img.complete` and was skipped, i.e. the feature was silently
 * inert and the only shimmer anyone ever saw was the false server-rendered one. At 1600px
 * the same scroll produces 12 tiles shimmering while their image is genuinely in flight,
 * with the post-load overlap still at zero. Re-measure with both probes before changing it.
 */
const SHIMMER_START_MARGIN = '1600px';

/**
 * The attribute a page renders on a shimmer-capable image wrap. It is deliberately NOT
 * the `is-loading` class and carries no styling of its own: server-rendered markup may
 * say "this box can shimmer", never "this box is shimmering". Only this module, at
 * runtime, knows whether a fetch is actually in flight — see initImageSkeletons.
 * Enforced by tests/skeleton-ssr-class.test.ts.
 */
export const SKELETON_ATTR = 'data-skeleton';

/**
 * Wire the shimmer for every `wrapSelector` on the page: a tile shimmers only while its
 * image is genuinely in flight.
 *
 * **The bug this fixes, measured on the homepage.** The shimmer sits UNDER the image by
 * design (putting it on top cost ~700ms of invisible cached photos — store-card.css has
 * the measurement). That is right for a photograph, but a background-removed product photo
 * is TRANSPARENT, so a shimmer running behind a fully-painted subject is visible straight
 * through it. The owner reported this repeatedly, against three different attempted fixes.
 *
 * The first fix (2026-08-03) removed the shimmer from tiles that were merely off-screen —
 * real, but it only addressed half the window, and its instrumentation reported "zero
 * overlap" because it ran INSIDE this module and so was structurally blind to everything
 * that happens before this module executes. That blind spot was the remaining bug: the
 * class was rendered SERVER-SIDE, so it animated from first paint until the page bundle
 * loaded, parsed and ran — and the image, especially a cached or eager one, paints long
 * before that. Re-measured 2026-08-04 with the probe installed before any page script:
 * **96 of 97 homepage tiles ran the shimmer after their image already had pixels, for up
 * to 726ms — and up to 3.9s at 4x CPU throttle.** Exactly the reported symptom.
 *
 * So the class is not rendered server-side at all any more. Markup renders `SKELETON_ATTR`,
 * which is inert; this module adds `is-loading` only when the tile comes within
 * `SHIMMER_START_MARGIN` of the viewport (about when the lazy fetch starts) AND the image
 * is not already there. An off-screen tile is a plain surface; a tile you are about to
 * reach shimmers while it genuinely waits; a loaded tile is the photo, with nothing behind
 * it. Nothing about the photo's visibility depends on JS — the image is never held at
 * opacity 0 — so the cost of this module arriving late is now a missing shimmer rather
 * than a false one. Without IntersectionObserver the shimmer simply never starts, which is
 * the honest degradation: no claim beats a wrong claim.
 *
 * The one legitimate exception, which is why this is an attribute and not a rule against
 * the class: a wrap whose `<img>` has no `src` at all (only `data-src`, fetched later by
 * its own code — the product page's sticky mini-bar, the quick-view modal's slides). There
 * the box is genuinely empty until JS acts, so a server-rendered `is-loading` states
 * something true. tests/skeleton-ssr-class.test.ts encodes exactly that boundary.
 *
 * `root` scopes the sweep to a subtree, for callers that inject rows/cards and want to wire
 * only what they just built (the seller dashboard's products table does this per row). It
 * is only an efficiency knob: the marker is consumed as each wrap is taken, so calling this
 * against the whole document repeatedly is correct, just wasteful.
 */
export function initImageSkeletons(wrapSelector: string, root: ParentNode = document): void {
  const wraps = [...root.querySelectorAll<HTMLElement>(`${wrapSelector}[${SKELETON_ATTR}]`)];
  if (!wraps.length) return;

  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          obs.unobserve(entry.target);
          const wrap = entry.target as HTMLElement;
          const img = wrap.querySelector('img');
          // Already there by the time we got here — no reason to flash a shimmer on.
          if (img?.src && img.complete && img.naturalWidth > 0) continue;
          wrap.classList.add('is-loading');
          if (img) clearSkeletonOnLoad(img, wrapSelector);
        }
      }, { rootMargin: SHIMMER_START_MARGIN })
    : null;

  for (const wrap of wraps) {
    const img = wrap.querySelector('img');
    if (!img) continue;
    // Taking ownership: drop the marker so a second call for the same selector (the store
    // grid and /stores both re-init after injecting cards) cannot observe this wrap twice.
    wrap.removeAttribute(SKELETON_ATTR);
    if (!observer) continue;
    observer.observe(wrap);
  }
}
