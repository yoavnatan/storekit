/** Shared "liquid" dot indicators for the horizontal scroll-snap image
 * carousels used across the site (product-card grid, store product modal,
 * global quick-view). While the strip is scrolling, the active dot's width
 * transfers to its neighbour proportionally to scroll progress — driven
 * per-frame with no CSS transition, so it flows with the finger/wheel rather
 * than snapping. Once scrolling settles it eases to the final widths with a
 * spring transition. Returns `setActive(idx)` for programmatic jumps (a dot
 * click, or a colour-variant's linked image).
 *
 * Callers own the markup/click/touch wiring; this only animates the dots and
 * reports the settled index via `onSettle`. Dot widths/colours are written
 * inline, so they win over whatever resting CSS the dots carry. */
const BASE_W = 6;
const ACTIVE_W = 18;
const ACTIVE_BG = '#fff';
const IDLE_BG = 'rgba(255,255,255,0.7)';
const SNAP_TRANSITION = 'width 220ms cubic-bezier(0.34,1.56,0.64,1)';

export interface LiquidDots {
  setActive: (idx: number) => void;
}

export function initLiquidDots(
  slides: HTMLElement,
  dots: HTMLElement[],
  onSettle?: (idx: number) => void,
): LiquidDots {
  const count = dots.length;

  function applyWidths(widths: number[], transition: boolean): void {
    const tr = transition ? SNAP_TRANSITION : 'none';
    dots.forEach((d, i) => {
      d.style.transition = tr;
      d.style.width = `${widths[i]}px`;
      d.style.background = (widths[i] ?? 0) > BASE_W ? ACTIVE_BG : IDLE_BG;
    });
  }

  function setActive(idx: number): void {
    applyWidths(dots.map((_, i) => (i === idx ? ACTIVE_W : BASE_W)), true);
  }

  // Cache slide width — read once, refresh on resize, never in the scroll path.
  let slideW = slides.offsetWidth || 1;
  new ResizeObserver(() => { slideW = slides.offsetWidth || 1; }).observe(slides);

  let rafId: number | undefined;
  let snapTimer: ReturnType<typeof setTimeout> | undefined;

  slides.addEventListener('scroll', () => {
    clearTimeout(snapTimer);
    if (rafId !== undefined) cancelAnimationFrame(rafId);

    rafId = requestAnimationFrame(() => {
      rafId = undefined;
      const frac = Math.abs(slides.scrollLeft) / slideW;
      const src = Math.min(Math.floor(frac), count - 1);
      const tgt = Math.min(src + 1, count - 1);
      const t = frac - Math.floor(frac);
      applyWidths(dots.map((_, i) => {
        if (src === tgt) return i === src ? ACTIVE_W : BASE_W;
        if (i === src) return ACTIVE_W - (ACTIVE_W - BASE_W) * t;
        if (i === tgt) return BASE_W + (ACTIVE_W - BASE_W) * t;
        return BASE_W;
      }), false);
    });

    snapTimer = setTimeout(() => {
      const idx = Math.min(Math.round(Math.abs(slides.scrollLeft) / slideW), count - 1);
      setActive(idx);
      onSettle?.(idx);
    }, 80);
  }, { passive: true });

  return { setActive };
}
