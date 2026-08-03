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
 * How early a tile is allowed to start saying "loading". Deliberately close to the
 * margin a browser uses to trigger `loading="lazy"`, so the shimmer starts at roughly
 * the moment the fetch does rather than long before it.
 */
const SHIMMER_START_MARGIN = '250px';

/**
 * Wire the shimmer for every `wrapSelector` on the page — and, since 2026-08-03, make
 * it wait for the image to actually be loading.
 *
 * **The bug this fixes, measured on the homepage.** The class is rendered server-side on
 * every non-eager tile, but the images are `loading="lazy"` and most tiles sit HORIZONTALLY
 * off-screen inside the shelves. So 32 store-card tiles and 46 product tiles — the large
 * majority of the page — were animating a shimmer permanently, for images the browser had
 * not requested and would not request until that shelf was scrolled. A shimmer means "this
 * box is fetching something"; nothing was in flight, so it was a permanent claim that was
 * simply untrue, and 78 infinite animations of it.
 *
 * It is also what the owner kept reporting and what no amount of tint-tuning could fix.
 * The shimmer sits UNDER the image by design (putting it on top cost ~700ms of invisible
 * cached photos — store-card.css has the measurement), which is right for a photograph but
 * means a background-removed product shows the band THROUGH its subject. With the band
 * running forever on most tiles, "the skeleton is on top of the product" is exactly what
 * you see. Instrumented every frame: wraps where the image had loaded and the shimmer was
 * still running came to ZERO, so the overlap was never the timing — it was that the
 * shimmer had no business running at all yet.
 *
 * So: strip the class immediately, and give it back only when the tile comes within
 * `SHIMMER_START_MARGIN` of the viewport, which is about when the lazy fetch starts. An
 * off-screen tile is a plain surface; a tile you are about to reach shimmers while it
 * genuinely waits; a loaded tile is the photo. Without IntersectionObserver, the old
 * behaviour stands — a shimmer that starts early is a far smaller problem than none.
 */
export function initImageSkeletons(wrapSelector: string): void {
  const wraps = [...document.querySelectorAll<HTMLElement>(`${wrapSelector}.is-loading`)];
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
    if (!observer) { clearSkeletonOnLoad(img, wrapSelector); continue; }
    wrap.classList.remove('is-loading');
    observer.observe(wrap);
  }
}
