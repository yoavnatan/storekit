/**
 * The dashboard's list pager — one implementation for every AJAX-paged list tab
 * (products, orders, messages) and the buyer's order list.
 *
 * ## What it is
 *
 * Two steps and ONE control between them:
 *
 *     ‹ הקודם      עמוד [ 3 ▾ ] מתוך 12      הבא ›
 *
 * The middle is the site's own dropdown (`select-dropdown.ts`, the same one the "הצג בעמוד" pill
 * beside it uses), listing every page. That is the whole mechanism: nothing shifts as you page,
 * nothing is hidden behind an ellipsis, and it looks and behaves identically at three pages and at
 * forty. Every page is one action away at any width, on a phone as much as on a desktop.
 *
 * ## Why it is this and not a strip of numbers
 *
 * It WAS a strip of numbers with a moving window and `…` markers, and the owner threw that out
 * (2026-08-15): "כל הקטע שהמספרים משתנים ושיש שלוש נקודות... זה מסובך מדי למשתמש". He is right, and
 * the pattern is genuinely dated — a windowed pager exists because a page of links had to be
 * crawlable and static, which is not what a seller's dashboard table is. It also cost a
 * surprising amount of machinery for what it delivered: a window algorithm, a per-width slot count
 * measured through a `ResizeObserver`, a gap marker that turned into a jump field, and a rule about
 * gaps that hide exactly one page. All of that is gone, and the control got better rather than
 * worse — the numbers strip could not reach page 14 of 40 in one click and this can.
 *
 * ## What the tabs mount
 *
 * A tab mounts this TWICE — above the list and below it — keyed by `data-list-pager`, and one write
 * fills both. The top one is the one that gets used; a pager only under the table means scrolling
 * past every row to change page and back up to read the result, which is the complaint this whole
 * file started from.
 *
 * No language literals: every string arrives in `PagerLabels` from the caller, which is what lets
 * `orders.ts` (held to a stricter no-Hebrew rule by tests/orders-i18n.test.ts) share this file.
 */
import { animateScrollTo, pinnedTopChrome } from './scroll-utils.js';
import { COMPACT_TRIGGER_CLASS, initSelectDropdown, refreshSelectDropdown } from './select-dropdown.js';

export interface PagerLabels {
  /** "הקודם" */
  prev: string;
  /** "הבא" */
  next: string;
  /**
   * "עמוד {page} מתוך {total}" — and it is used as a TEMPLATE, not as a sentence: the pager splits
   * it at `{page}` and puts the page dropdown in the gap, so the words either side of the control
   * are the translation's own. That is why this key still carries `{page}` even though no number is
   * ever printed into it.
   */
  pageInfo: string;
}

/** Every nav belonging to one tab — the top one and the bottom one carry the same name. */
function navsOf(name: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-list-pager="${name}"]`)];
}

const STEP_CLASS = 'btn btn--ghost btn--sm shrink-0 disabled:opacity-40 disabled:cursor-default';

/** Build the three parts once. Called again only when the pager was empty (a list that grew past
 *  one page), never on an ordinary page change — the dropdown is a live widget with a generated
 *  trigger, and rebuilding it on every press would throw that away mid-interaction. */
function buildPager(nav: HTMLElement, labels: PagerLabels): void {
  // Only the leading half is needed at build time; the trailing half carries `{total}`, which
  // changes with a filter, so it is written on every render instead.
  const [before] = labels.pageInfo.split('{page}');

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = STEP_CLASS;
  prev.setAttribute('data-page-prev', '');
  prev.textContent = labels.prev;

  const middle = document.createElement('span');
  middle.className = 'inline-flex items-center gap-[.35rem] text-[.82rem] [color:var(--color-muted)]';

  const beforeEl = document.createElement('span');
  beforeEl.textContent = (before ?? '').trim();

  const select = document.createElement('select');
  select.setAttribute('data-page-select', '');
  // Never actually seen: `initSelectDropdown` hides it and mirrors it with the site's dropdown.
  // It stays the value holder, so `change` and `.value` work exactly as on any other select here.
  select.className = 'font-[inherit] text-[.82rem]';

  const afterEl = document.createElement('span');
  afterEl.setAttribute('data-pager-after', '');

  middle.append(beforeEl, select, afterEl);

  const next = document.createElement('button');
  next.type = 'button';
  next.className = STEP_CLASS;
  next.setAttribute('data-page-next', '');
  next.textContent = labels.next;

  nav.replaceChildren(prev, middle, next);
  initSelectDropdown(select, { triggerClassName: COMPACT_TRIGGER_CLASS, menuAutoWidth: true });
}

/**
 * Write the tab's pagers. Safe to call as often as the state changes — it is the ONLY thing that
 * writes them, so the two copies can never disagree.
 *
 * Below two pages there is nothing to page through, so the nav is emptied: its `:empty` rule is
 * what hides it (the `hidden` ATTRIBUTE loses to a `flex` class — memory
 * `project_css_cascade_traps`), and emptying it is also what lets the pager be rebuilt with
 * a fresh dropdown if the list later grows.
 */
export function renderListPagers(name: string, page: number, totalPages: number, labels: PagerLabels): void {
  navsOf(name).forEach((nav) => {
    // Written back on every render, not only by the server: the count changes with a filter or a
    // page size, and this attribute is what the click handler reads to know where "next" stops.
    nav.dataset.totalPages = String(totalPages);
    nav.dataset.page = String(page);
    if (totalPages <= 1) { nav.hidden = true; nav.replaceChildren(); return; }
    nav.hidden = false;

    if (!nav.querySelector('[data-page-select]')) buildPager(nav, labels);

    const select = nav.querySelector<HTMLSelectElement>('[data-page-select]')!;
    // Options are rebuilt only when the COUNT changed. On an ordinary page change the list of pages
    // is the same list — rewriting it would be work the dropdown then has to re-measure.
    if (select.options.length !== totalPages) {
      select.replaceChildren(...Array.from({ length: totalPages }, (_, i) => {
        const o = document.createElement('option');
        o.value = String(i + 1);
        o.textContent = String(i + 1);
        return o;
      }));
    }
    select.value = String(page);
    // Setting `.value` fires no event, so the visible trigger has to be told (select-dropdown.ts).
    refreshSelectDropdown(select);

    const label = labels.pageInfo.replace('{page}', String(page)).replace('{total}', String(totalPages));
    // The whole sentence is the control's accessible name: "עמוד 3 מתוך 12" says what it is AND
    // where you are, which the bare number in the trigger cannot.
    select.setAttribute('aria-label', label);
    nav.setAttribute('aria-label', label);

    const after = nav.querySelector<HTMLElement>('[data-pager-after]');
    if (after) after.textContent = (labels.pageInfo.split('{page}')[1] ?? '').replace('{total}', String(totalPages)).trim();

    const prev = nav.querySelector<HTMLButtonElement>('[data-page-prev]');
    const next = nav.querySelector<HTMLButtonElement>('[data-page-next]');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= totalPages;
  });
}

/**
 * Dim the list while its next page is in flight — IMMEDIATELY, not after a threshold.
 *
 * It waited for `LOADING_CUE_DELAY_MS` (450ms, the site's one cue threshold) and these fetches
 * normally answer inside that, so in practice the dim never appeared. The owner asked for it back
 * (2026-08-15): "קודם זה היה יותר טוב, לפחות המוצרים לרגע הפכו לאפורים בין ההחלפות, עכשיו סתם
 * מחכים".
 *
 * That is not a contradiction of the shared threshold, and the difference is worth stating because
 * the next person will be tempted to "fix" this back. That constant governs a cue that REPLACES
 * content — a skeleton standing where rows will be — and a skeleton that appears and vanishes
 * inside a tenth of a second is the flicker it exists to prevent. This is the same rows at lower
 * opacity: nothing appears, nothing is displaced, and the only thing a short one costs is a brief
 * fade. What it buys is that a press is never answered by a completely still screen.
 *
 * Returns the function that ends it; call it on every exit path, failure included.
 *
 * `aria-busy` rides along: it costs nothing visually and it is the only signal a screen reader gets
 * that the rows are about to be replaced.
 */
const BUSY_CLASSES = 'opacity-[.45] pointer-events-none';

/** The busy period each element is currently in. Fast paging starts several, and only the newest
 *  may end one — otherwise a superseded caller's cleanup lifts the dim of the request that replaced
 *  it, and the list looks settled while it is still loading. */
const busyTokens = new WeakMap<HTMLElement, number>();
let busySeq = 0;

export function markListBusy(el: HTMLElement | null): () => void {
  if (!el) return () => {};
  const classes = BUSY_CLASSES.split(' ');
  // A new period supersedes the previous one, and the token it hands back is what tells a
  // superseded caller's cleanup to stand down — otherwise fast paging has one request lifting the
  // dim of the request that replaced it.
  const token = ++busySeq;
  busyTokens.set(el, token);
  el.setAttribute('aria-busy', 'true');
  el.classList.add(...classes);
  return () => {
    if (busyTokens.get(el) !== token) return; // superseded — not ours to end
    busyTokens.delete(el);
    el.classList.remove(...classes);
    el.removeAttribute('aria-busy');
  };
}

/**
 * One list's in-flight fetch, so that PAGING FAST cannot corrupt what is on screen.
 *
 * The bug this exists for (owner, 2026-08-15): pressing next/previous quickly went 2 → 3 → back to
 * 2. Each press fires its own request and each answer wrote `currentPage = data.page` and repainted
 * the strip — so whichever answer arrived LAST won, and a slow request for page 2 landing after a
 * fast one for page 3 rewound both the number and the rows. Nothing was wrong with the click; it
 * was the network being allowed to decide the order.
 *
 * The fix is not to slow the clicks down. A debounce would make fast paging feel worse, which is
 * the thing being asked for ("בן אדם לפעמים רוצים לדפדף מהר"), so every press still fires
 * immediately and still repaints on the same frame. What changes is that only the NEWEST request
 * may touch state or DOM, and the ones it supersedes are `abort()`ed rather than left to finish
 * into a result nobody will read — a browser caps parallel connections to one origin, so an
 * abandoned request is not free.
 *
 * `begin()` at the top of an apply; `signal` on the fetch; `isCurrent()` after every `await` that
 * could have let a newer press through.
 *
 * Prior art in this repo: `buyer/dashboard.astro`'s `ordersRequestSeq`, which has guarded exactly
 * this since before the shared pager existed — it stays inline there because it also gates that
 * list's skeleton timer.
 */
export interface FetchGate {
  /** Claim the list. Aborts whatever was in flight and returns this request's own liveness check. */
  begin: () => { isCurrent: () => boolean; signal: AbortSignal };
}

export function createFetchGate(): FetchGate {
  let seq = 0;
  let inFlight: AbortController | null = null;
  return {
    begin() {
      const mine = ++seq;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      return {
        isCurrent: () => mine === seq,
        signal: controller.signal,
      };
    },
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

/** Wire both navs of one tab: the two steps and the page dropdown. */
export function initListPager(opts: ListPagerOptions): void {
  const navs = navsOf(opts.name);
  if (!navs.length) return;

  const totalPagesNow = (): number => parseInt(navs[0]!.dataset.totalPages ?? '1', 10) || 1;

  /** Go to `target`, if it is a real page and not the one already on screen. */
  const goTo = (target: number): void => {
    const total = totalPagesNow();
    if (!Number.isFinite(target)) return;
    const page = Math.min(Math.max(1, Math.trunc(target)), total);
    if (page === opts.getPage()) return;
    opts.setPage(page);
    // Repainted BEFORE the fetch, so the page the seller chose is showing on the same frame as the
    // press. The list underneath is still the old page for as long as the round trip takes, and
    // this plus the dim is what says so.
    renderListPagers(opts.name, page, total, opts.labels());
    void opts.apply().then(() => scrollListTopIntoView(opts.scrollTarget()));
  };

  navs.forEach((nav) => {
    nav.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('[data-page-prev], [data-page-next]');
      if (!btn || btn.disabled) return;
      goTo(opts.getPage() + (btn.hasAttribute('data-page-prev') ? -1 : 1));
    });
    // Delegated rather than bound to the select: `change` bubbles, so this survives the options
    // being rebuilt when a filter changes the number of pages.
    nav.addEventListener('change', (e) => {
      const select = (e.target as Element).closest<HTMLSelectElement>('[data-page-select]');
      if (select) goTo(parseInt(select.value, 10));
    });
  });
}
