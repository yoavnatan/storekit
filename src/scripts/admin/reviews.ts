import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { wireReviewTakedown } from '../../lib/review-takedown.js';

/**
 * The Reviews tab's client half.
 *
 * Every control does the same thing: rewrite this tab's query params and let the server re-render
 * the panel. Nothing filters DOM rows, because only one page of rows is ever present — the
 * narrowing runs in SQL (`product-reviews.ts#getAdminReviewsPage`).
 *
 * **Plain `<select>`s and `<input type="date">`, not the money journal's floating menus** (owner,
 * 2026-08-19: *"שיהיה פשוט. לא עמוס בעין"*). Two short lists and a date range do not need a portal,
 * and the native controls come with keyboard and screen-reader behaviour already correct.
 */
const PANEL_ID = 'dash-panel-reviews';

/** Current narrowing, read back off the DOM the server just rendered — so no control can drop
 *  another one's state (searching must not clear the store filter). */
function currentParams(): Record<string, string | undefined> {
  const toolbar = document.getElementById('admin-reviews-toolbar');
  const search = document.getElementById('admin-reviews-search') as HTMLInputElement | null;
  const state = toolbar?.dataset.state ?? 'all';
  return {
    vq: search?.value.trim() || undefined,
    vstore: toolbar?.dataset.store || undefined,
    vseller: toolbar?.dataset.seller || undefined,
    vstate: state !== 'all' ? state : undefined,
    vfrom: toolbar?.dataset.from || undefined,
    vto: toolbar?.dataset.to || undefined,
  };
}

/** Any change to the narrowing returns to page 1 — staying on page 7 of a result set that no longer
 *  has seven pages is the one thing every filtered pager gets wrong. */
function navigate(overrides: Record<string, string | undefined>): void {
  const url = buildAdminUrl('reviews', { ...currentParams(), ...overrides });
  void swapPanel(url, PANEL_ID, () => initAdminReviewsPanel());
}

function wireToolbar(): void {
  const search = document.getElementById('admin-reviews-search') as HTMLInputElement | null;
  search?.addEventListener('input', debounce(() => navigate({ vq: search.value.trim() || undefined }), 300));

  const onSelect = (id: string, param: string, blank: string) => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    el?.addEventListener('change', () => navigate({ [param]: el.value === blank ? undefined : el.value }));
  };
  onSelect('admin-reviews-store', 'vstore', '');
  onSelect('admin-reviews-seller', 'vseller', '');
  onSelect('admin-reviews-state', 'vstate', 'all');

  const onDate = (id: string, param: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.addEventListener('change', () => navigate({ [param]: el.value || undefined }));
  };
  onDate('admin-reviews-from', 'vfrom');
  onDate('admin-reviews-to', 'vto');

  document.getElementById('admin-reviews-clear')?.addEventListener('click', () => {
    // Every param explicitly `undefined` rather than navigating to a bare URL: `buildAdminUrl`
    // merges over what `currentParams()` just read, so an omitted key would be kept, not cleared.
    void swapPanel(buildAdminUrl('reviews', {}), PANEL_ID, () => initAdminReviewsPanel());
  });
}

export function initAdminReviewsPanel(): void {
  wireToolbar();
  // The takedown button is shared with the Messages tab, where a complaint carries its review
  // inline — one implementation, in `lib/review-takedown.ts`.
  wireReviewTakedown(PANEL_ID);
  wirePanelLinks(PANEL_ID, () => initAdminReviewsPanel());
  wirePopstateReload();
}
