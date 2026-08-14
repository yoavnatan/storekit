/**
 * The dashboard's list pager — one implementation for every AJAX-paged list tab
 * (products, orders, messages).
 *
 * It replaces three byte-identical copies of an arrows-only pager, each of which
 * carried the same three complaints (owner, 2026-08-14, about the products tab):
 *
 *  1. **It only existed at the BOTTOM of the list**, so changing page meant scrolling
 *     past every row to reach the control and then back up to read the result. A tab
 *     mounts the same pager twice now — `renderListPagers` writes every nav carrying
 *     the tab's `data-list-pager` name — and the top one is the one a seller reaches.
 *  2. **Only "previous"/"next" existed**, so page 9 of 12 was eight clicks away and the
 *     total was a sentence rather than something to aim at. `pageWindow` puts the real
 *     numbers on screen, always including the first and the last.
 *  3. **The scroll fired before the rows changed.** The old click handler called its
 *     `apply…()` without awaiting it and scrolled on the next line, so the page jumped
 *     to the top of a list that was still showing the page the seller had just left —
 *     for the whole round trip. That reads as "the click did nothing, twice". Here the
 *     await is the point: the rows swap first, the scroll happens after, and the wait
 *     itself is not silent (see `markListBusy`).
 *
 * No language literals: every string arrives in `PagerLabels` from the caller, which is
 * what lets `orders.ts` (held to a stricter no-Hebrew rule by tests/orders-i18n.test.ts)
 * share this file.
 */
import { escapeHtml as esc } from '../../lib/html-escape.js';
import { LOADING_CUE_DELAY_MS } from '../../lib/loading-sweep.js';
import { animateScrollTo, pinnedTopChrome } from './scroll-utils.js';

export interface PagerLabels {
  /** "הקודם" */
  prev: string;
  /** "הבא" */
  next: string;
  /** "עמוד {page} מתוך {total}" — the nav's accessible name, since the numbers alone don't say what they are. */
  pageInfo: string;
  /** "מעבר לעמוד {page}" — each number button's accessible name. */
  goToPage: string;
  /** "קפיצה לעמוד" — the gap's own name, since what it stands for is "the pages you can't see". */
  jump: string;
}

/**
 * Rendered between two non-adjacent page numbers — and it is a BUTTON, because it stands for the
 * pages that are not on screen and those are exactly the ones a seller cannot reach in one click.
 *
 * Numbers alone are a window, so a far page costs several hops: on a 20-page catalogue any page is
 * within four clicks on a desktop and eight on a phone, and at 100 pages the numbers stop being
 * navigation at all. Pressing the gap turns it into a small field: type the page, Enter, done — one
 * action to anywhere, at any size, without spending a single pixel of the strip's width on a
 * control that would otherwise sit there unused for every store small enough not to need it.
 *
 * It is also in the right PLACE for what it does: the marker already means "pages 2–7 are here".
 */
const GAP = '…';

/* The pager is styled in utilities rather than a stylesheet (Tailwind v4 only), the same way the
   arrows-only pager it replaces already was. Muted at rest on purpose: a strip of full-contrast
   digits over a table of products would compete with the products, so only the page you are on
   takes a colour. `tabular-nums` because without it the strip re-flows by a pixel or two as the
   digits change under it, which reads as the whole pager twitching on every page. */
const NUM_BASE =
  'inline-flex items-center justify-center min-w-[1.85rem] h-[1.85rem] px-[.3rem] rounded-sm border border-transparent text-[.8rem] font-semibold tabular-nums transition-colors duration-[120ms]';
const NUM_BUTTON =
  `${NUM_BASE} bg-transparent [color:var(--color-muted)] cursor-pointer hover:[color:var(--color-text)] hover:[border-color:var(--color-border)] hover:bg-[color:var(--color-surface)]`;
/* Fill + border + weight — the site's own "pressed" recipe (AI_INSTRUCTIONS → elevation rule).
   Colour alone was not enough: `--color-primary` is a dark navy a shade off the body text, so a
   bold navy digit among muted ones read as "slightly darker", not as "this is where you are". */
const NUM_CURRENT = `${NUM_BASE} bg-[color:var(--color-bg)] [color:var(--color-primary)] [border-color:var(--color-primary)]`;
/* The gap. It takes the number buttons' own hover, which is what says it is pressable at all — a
   bare "…" reads as punctuation. `cursor-help` would be a lie (it does something), and a `title`
   would be the browser's tooltip; `icon-tooltips.ts` cannot label it either, since that only covers
   controls whose content is a glyph, so the name lives in `aria-label` for a screen reader and the
   hover state does the rest for a mouse. */
const GAP_BUTTON =
  `${NUM_BASE} min-w-[1.4rem] bg-transparent [color:var(--color-muted)] cursor-pointer hover:[color:var(--color-text)] hover:[border-color:var(--color-border)] hover:bg-[color:var(--color-surface)]`;
/* The field the gap becomes. Same height and border as a number so the strip does not jump when it
   opens; `dir=ltr` because a number typed into an RTL field puts the caret on the wrong side of it. */
const JUMP_INPUT =
  'w-[2.9rem] h-[1.85rem] px-[.2rem] text-center text-[.8rem] font-semibold tabular-nums rounded-sm border [border-color:var(--color-primary)] bg-[color:var(--color-surface)] [color:var(--color-text)] outline-none';

/**
 * Which page numbers to show. Always the first and the last (so the size of the list is
 * readable at a glance and its end is one click away), the current page, and as much of
 * its neighbourhood as `slots` allows.
 *
 * `slots` counts NUMBERS only; the two gap markers can add up to two more cells.
 */
export function pageWindow(page: number, totalPages: number, slots: number): (number | typeof GAP)[] {
  const max = Math.max(3, slots);
  const current = Math.min(Math.max(1, page), totalPages);
  if (totalPages <= max) return Array.from({ length: totalPages }, (_, i) => i + 1);

  // The first and last are always spent, so the moving window is `max - 2` wide and
  // sits strictly inside them.
  const inner = max - 2;
  let start = Math.max(2, current - Math.floor((inner - 1) / 2));
  let end = start + inner - 1;
  if (end > totalPages - 1) {
    end = totalPages - 1;
    start = Math.max(2, end - inner + 1);
  }

  // A gap standing in for exactly ONE page is strictly worse than the page: the marker is about
  // as wide as the number it hides, so the strip costs the same and offers one click less.
  if (start === 3) start = 2;
  if (end === totalPages - 2) end = totalPages - 1;

  const out: (number | typeof GAP)[] = [1];
  if (start > 2) out.push(GAP);
  for (let p = start; p <= end; p++) out.push(p);
  if (end < totalPages - 1) out.push(GAP);
  out.push(totalPages);
  return out;
}

/**
 * How many numbers fit. Measured off the nav's own width rather than the viewport's:
 * the pager sits inside a panel with its own padding, and on the dashboard a panel can
 * be `hidden` (width 0) when this first runs — which is why every nav is observed for
 * resize below instead of measured once.
 *
 * The steps are deliberately generous, because the failure mode is mild: the nav wraps
 * (`flex-wrap` in its markup), so an over-full strip becomes two lines rather than an
 * overflow. At the 375px this site designs up from, five numbers plus the two step
 * buttons measure ~310px inside ~343px of panel.
 */
function slotsFor(width: number): number {
  if (width < 340) return 3;
  if (width < 520) return 5;
  return 7;
}

function pagerHtml(page: number, totalPages: number, labels: PagerLabels, slots: number): string {
  const cells = pageWindow(page, totalPages, slots);
  const cell = (p: number | typeof GAP, i: number): string => {
    if (p === GAP) {
      // The range this marker stands for, read off its neighbours — it is what the field opens
      // pre-filled with, so pressing it says what it covers instead of asking a blank question.
      const from = (cells[i - 1] as number) + 1;
      const to = (cells[i + 1] as number) - 1;
      return `<button type="button" class="${GAP_BUTTON}" data-page-jump aria-label="${esc(labels.jump)}" data-jump-from="${from}" data-jump-to="${to}">${GAP}</button>`;
    }
    // The current page is a <span>, not a button: pressing it would re-fetch the page
    // already on screen and move nothing (AI_INSTRUCTIONS → no-op interactions must be
    // invisible). `aria-current` is what tells a screen reader which one it is.
    if (p === page) return `<span class="${NUM_CURRENT}" aria-current="page">${p}</span>`;
    return `<button type="button" class="${NUM_BUTTON}" data-page-go="${p}" aria-label="${esc(labels.goToPage.replace('{page}', String(p)))}">${p}</button>`;
  };
  return `
    <button type="button" class="btn btn--ghost btn--sm shrink-0 disabled:opacity-40 disabled:cursor-default" data-page-prev${page <= 1 ? ' disabled' : ''}>${esc(labels.prev)}</button>
    <span class="flex items-center gap-[.15rem]">${cells.map(cell).join('')}</span>
    <button type="button" class="btn btn--ghost btn--sm shrink-0 disabled:opacity-40 disabled:cursor-default" data-page-next${page >= totalPages ? ' disabled' : ''}>${esc(labels.next)}</button>
  `;
}

/** Every nav belonging to one tab — the top one and the bottom one carry the same name. */
function navsOf(name: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-list-pager="${name}"]`)];
}

/**
 * Write the tab's pagers. Safe to call as often as the state changes — it is the ONLY
 * thing that writes them, so the two copies can never disagree.
 */
export function renderListPagers(name: string, page: number, totalPages: number, labels: PagerLabels): void {
  navsOf(name).forEach((nav) => {
    // Written back on every render, not only by the server: the count changes with a
    // filter or a page-size, and this attribute is what the click handler reads to know
    // where "next" stops.
    nav.dataset.totalPages = String(totalPages);
    nav.dataset.page = String(page);
    if (totalPages <= 1) { nav.hidden = true; nav.innerHTML = ''; return; }
    const slots = slotsFor(nav.clientWidth || nav.parentElement?.clientWidth || 0);
    nav.hidden = false;
    nav.dataset.pagerSlots = String(slots);
    nav.setAttribute('aria-label', labels.pageInfo.replace('{page}', String(page)).replace('{total}', String(totalPages)));
    nav.innerHTML = pagerHtml(page, totalPages, labels, slots);
  });
}

/**
 * Dim the list while its next page is in flight — but only once the wait has earned the
 * right to say so, on the site's ONE threshold (`LOADING_CUE_DELAY_MS`, whose header
 * carries the measurement and the reasoning). These fetches normally answer inside it, so
 * normally nothing is drawn at all and the new rows are the feedback. A local number here
 * would be the third answer to a question that already has one.
 *
 * Returns the function that ends it; call it on every exit path, failure included.
 *
 * `aria-busy` goes on immediately regardless: it costs nothing visually and it is the only
 * signal a screen reader gets that the rows are about to be replaced.
 */
const BUSY_CLASSES = 'opacity-[.45] pointer-events-none';

export function markListBusy(el: HTMLElement | null): () => void {
  if (!el) return () => {};
  const classes = BUSY_CLASSES.split(' ');
  el.setAttribute('aria-busy', 'true');
  const timer = window.setTimeout(() => el.classList.add(...classes), LOADING_CUE_DELAY_MS);
  return () => {
    window.clearTimeout(timer);
    el.classList.remove(...classes);
    el.removeAttribute('aria-busy');
  };
}

export interface ListPagerOptions {
  /** The `data-list-pager` name shared by this tab's navs. */
  name: string;
  /** A function, not a value: every tab reads its dictionary at render time, and a snapshot taken
   *  at init would be one more thing that has to be right for the pager to speak the seller's
   *  language (tests/orders-i18n.test.ts, memory `project_client_renderer_i18n_drift`). */
  labels: () => PagerLabels;
  getPage: () => number;
  setPage: (page: number) => void;
  /** Re-fetches the list for the current page. Must resolve AFTER the rows are on screen. */
  apply: () => Promise<void>;
  /** The element to bring back into view once the new rows have landed. */
  scrollTarget: () => HTMLElement | null;
}

/**
 * Bring the target's top back below the pinned chrome — but only when it is actually
 * above it. A seller who paged from the TOP pager is already looking at the first row,
 * and scrolling a page that is already in the right place is the no-op movement the
 * design rules forbid.
 */
function scrollListTopIntoView(el: HTMLElement | null): void {
  if (!el) return;
  const top = pinnedTopChrome(el);
  const rectTop = el.getBoundingClientRect().top;
  if (rectTop >= top) return;
  animateScrollTo(Math.max(0, Math.ceil(rectTop + window.scrollY - top - 12)));
}

/** Wire both navs of one tab: clicks, and a re-render when the width changes what fits. */
export function initListPager(opts: ListPagerOptions): void {
  const navs = navsOf(opts.name);
  if (!navs.length) return;

  const rerender = (totalPages: number): void =>
    renderListPagers(opts.name, opts.getPage(), totalPages, opts.labels());

  const totalPagesNow = (): number => parseInt(navs[0]!.dataset.totalPages ?? '1', 10) || 1;

  /** Go to `target`, if it is a real page and not the one already on screen. */
  const goTo = (target: number): void => {
    const total = totalPagesNow();
    if (!Number.isFinite(target)) return;
    const page = Math.min(Math.max(1, Math.trunc(target)), total);
    if (page === opts.getPage()) return;
    opts.setPage(page);
    // Repainted BEFORE the fetch, so the number the seller pressed is marked as theirs
    // on the same frame as the press. The list underneath is still the old page for as
    // long as the round trip takes, and this plus the dim is what says so.
    rerender(total);
    void opts.apply().then(() => scrollListTopIntoView(opts.scrollTarget()));
  };

  /**
   * Turn a gap marker into the field that replaces it. Nothing else in the pager changes, so the
   * numbers on either side stay put and stay clickable — the seller can abandon the idea by
   * clicking one of them, without having to find a way to close this first.
   */
  const openJump = (gap: HTMLElement): void => {
    const from = gap.dataset.jumpFrom ?? '';
    const to = gap.dataset.jumpTo ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    // `text` + `inputmode`, not `type=number`: a number input brings spinner arrows and a scroll
    // wheel that changes the value, both of which this page already refuses elsewhere (the ad
    // budget field carries the same note).
    input.inputMode = 'numeric';
    input.dir = 'ltr';
    input.className = JUMP_INPUT;
    input.setAttribute('data-page-jump-input', '');
    input.setAttribute('aria-label', gap.getAttribute('aria-label') ?? '');
    input.placeholder = from && to && from !== to ? `${from}–${to}` : from;
    const close = (): void => { if (input.isConnected) rerender(totalPagesNow()); };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); const v = parseInt(input.value, 10); close(); goTo(v); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    });
    // Leaving without committing puts the marker back. Deferred a frame because a click on a page
    // NUMBER blurs this field first, and re-rendering inside that blur would delete the button the
    // click is still travelling to.
    input.addEventListener('blur', () => { window.setTimeout(close, 0); });
    gap.replaceWith(input);
    input.focus();
  };

  navs.forEach((nav) => {
    nav.addEventListener('click', (e) => {
      const gap = (e.target as Element).closest<HTMLButtonElement>('[data-page-jump]');
      if (gap) { openJump(gap); return; }
      const btn = (e.target as Element).closest<HTMLButtonElement>('[data-page-prev], [data-page-next], [data-page-go]');
      if (!btn || btn.disabled) return;
      goTo(btn.dataset.pageGo
        ? parseInt(btn.dataset.pageGo, 10)
        : opts.getPage() + (btn.hasAttribute('data-page-prev') ? -1 : 1));
    });

    // A nav that is 0-wide (its panel is still `hidden`) measures 3 slots and would keep
    // them once the panel opened; a window resize changes what fits just as much. Both
    // arrive here, and only a changed slot count causes a repaint — writing innerHTML on
    // every resize frame would fight the scroll and drop focus.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (nav.hidden) return;
        // Never while the jump field is open: a repaint would delete it mid-typing, and the
        // resize that triggers it is often the on-screen keyboard opening under the field.
        if (document.querySelector('[data-page-jump-input]')) return;
        const slots = slotsFor(nav.clientWidth);
        if (String(slots) === nav.dataset.pagerSlots) return;
        rerender(totalPagesNow());
      }).observe(nav);
    }
  });
}
