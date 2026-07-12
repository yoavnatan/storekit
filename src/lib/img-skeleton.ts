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
  // img.src (not just .complete) — an <img> with no src yet (e.g. still waiting on a
  // data-lazy-src swap) reads .complete as trivially true, which would strip the
  // shimmer immediately instead of waiting for the real image to actually load.
  if (img.src && img.complete && img.naturalWidth > 0) done();
  else {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }
}

export function initImageSkeletons(wrapSelector: string): void {
  document.querySelectorAll<HTMLElement>(`${wrapSelector}.is-loading`).forEach((wrap) => {
    const img = wrap.querySelector('img');
    if (img) clearSkeletonOnLoad(img, wrapSelector);
  });
}
