import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { showErrorToast } from '../../lib/toast.js';

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

/**
 * The takedown buttons. Moved here with the panel — they used to live in `alerts.ts` because the
 * list did.
 *
 * Delegated off the panel rather than bound per row, so it survives `swapPanel` re-rendering the
 * tab. Optimistic in the same shape as the product-block toggle in `stores.ts`: the server's answer
 * is what the button ends up reflecting, never the click.
 *
 * No `ConfirmModal` here, unlike blocking a store: hiding a review is instantly reversible from the
 * same button, and a confirm dialog on a two-way switch is friction with nothing behind it.
 */
function wireReviewToggles(): void {
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.dataset.togglesWired) return; // container survives every swap — wire once
  panel.dataset.togglesWired = '1';
  panel.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.admin-review-toggle');
    if (!btn) return;
    const wasBlocked = btn.dataset.blocked === '1';
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: wasBlocked ? 'show-review' : 'hide-review', reviewId: btn.dataset.reviewId }),
      });
      if (!res.ok) throw new Error('request failed');
      const { blocked } = await res.json() as { blocked: boolean };
      btn.dataset.blocked = blocked ? '1' : '';
      btn.textContent = blocked ? 'החזר לפרסום' : 'הסתר';
      btn.classList.toggle('btn--ghost', !blocked);
      const row = btn.closest<HTMLElement>('[data-review-row]');
      if (row) row.style.opacity = blocked ? '0.55' : '1';
    } catch {
      showErrorToast('הפעולה נכשלה, נסו שוב');
    } finally {
      btn.disabled = false;
    }
  });
}

export function initAdminReviewsPanel(): void {
  wireToolbar();
  wireReviewToggles();
  wirePanelLinks(PANEL_ID, () => initAdminReviewsPanel());
  wirePopstateReload();
}
