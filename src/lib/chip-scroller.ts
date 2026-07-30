/**
 * One-line, horizontally scrolling chip row with floating edge arrows.
 *
 * Extracted from the store page (`[storeSlug]/index.astro`), which had this
 * working first, so the directory (`/stores`) reuses the mechanism instead of
 * growing a second one that drifts. The CSS is shared too — `.category-filters-wrap`
 * / `.category-filters-row` / `.category-filters-arrow` in `styles/pages/store.css`.
 *
 * Why a scroller and not `flex-wrap`: the directory's chip row wraps onto four or
 * five lines once there are a dozen-plus categories, pushing the actual store grid
 * below the fold. One row that scrolls keeps the filter a control instead of a wall.
 *
 * Each arrow shows only on the side there is still something to scroll toward, and
 * `Math.abs` handles RTL, where `scrollLeft` runs negative.
 */

export interface ChipScrollerRefs {
  row: HTMLElement | null;
  prev: HTMLElement | null;
  next: HTMLElement | null;
  /** Pixels per arrow click. */
  step?: number;
}

export interface ChipScroller {
  /** Re-measure — call after the row's contents or width change. */
  update: () => void;
}

const DEFAULT_STEP = 200;
/** Slack for sub-pixel scroll positions, so an arrow doesn't linger at an edge. */
const EDGE_EPSILON = 4;

export function initChipScroller({ row, prev, next, step = DEFAULT_STEP }: ChipScrollerRefs): ChipScroller {
  // Hoisted out of the `if (row)` block below so `update` can read it too — both
  // callers are browser `<script>` blocks, so `document` is always there.
  const isRtl = document.documentElement.dir === 'rtl';

  const update = (): void => {
    if (!row) return;
    const { scrollLeft, scrollWidth, clientWidth } = row;
    const atStart = Math.abs(scrollLeft) < EDGE_EPSILON;
    const atEnd = Math.abs(scrollLeft) + clientWidth >= scrollWidth - EDGE_EPSILON;
    prev?.toggleAttribute('hidden', atStart);
    next?.toggleAttribute('hidden', atEnd);

    // Same two edge facts drive the `.edge-fade` mask (utilities/utils.css), so the
    // fade can never disagree with the arrows — one measurement, two signals.
    // `data-fade` names PHYSICAL sides, so map logical start/end here, where the
    // direction is already known (this is also what `scrollBy` below reverses for).
    // A row that isn't scrollable at all is atStart AND atEnd, so this comes out ''
    // and no mask applies — the fade only ever means "there is more this way".
    const fadeLeft = isRtl ? !atEnd : !atStart;
    const fadeRight = isRtl ? !atStart : !atEnd;
    row.dataset.fade = `${fadeLeft ? 'l' : ''}${fadeRight ? 'r' : ''}`;
  };

  if (row) {
    row.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(row);
    prev?.addEventListener('click', () => row.scrollBy({ left: isRtl ? step : -step, behavior: 'smooth' }));
    next?.addEventListener('click', () => row.scrollBy({ left: isRtl ? -step : step, behavior: 'smooth' }));
    update();
    // Fonts/images can still be settling on the first pass; one more frame later
    // catches the width the row actually ends up with.
    requestAnimationFrame(update);
  }

  return { update };
}
