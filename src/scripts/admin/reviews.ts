import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { wireReviewTakedown } from '../../lib/review-takedown.js';
import { initSelectDropdown, COMPACT_TRIGGER_CLASS } from '../dashboard/select-dropdown.js';

/**
 * The Reviews tab's client half.
 *
 * Every control does the same thing: rewrite this tab's query params and let the server re-render
 * the panel. Nothing filters DOM rows, because only one page of rows is ever present — the
 * narrowing runs in SQL (`product-reviews.ts#getAdminReviewsPage`).
 *
 * **The `<select>`s are UPGRADED to the site's own dropdown** (`initSelectDropdown`), and the first
 * cut shipped them raw — which the owner caught twice in one session and then made standing:
 * *"אני לא מבין למה כל דרופדאון שאתה עושה הוא נייטיב, תרשום לך את זה"*. He had asked for simple,
 * and I read that as simple to BUILD. It means simple to read, and a native popup rendered in the
 * OS's styling is the one control on the page that belongs to somebody else.
 *
 * The native element stays in the DOM as the source of truth — a portal pick sets its value and
 * fires a real `change`, so the listeners below are unchanged by the upgrade.
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
    if (!el) return;
    initSelectDropdown(el, { triggerClassName: COMPACT_TRIGGER_CLASS });
    el.addEventListener('change', () => navigate({ [param]: el.value === blank ? undefined : el.value }));
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
