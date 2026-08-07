import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal, type FloatingPortal } from '../../lib/toolbar-portal.js';
import { openRangePicker } from '../../lib/toolbar-range-picker.js';
import { showToast, showErrorToast } from '../../lib/toast.js';

// Money-journal tab. The panel is still SSR-filtered — every control here does the
// same thing: rewrite this tab's query params and let the server re-render the panel
// (swapPanel). Nothing filters DOM rows, since only one page of rows is ever present.
// Added סשן ג׳ (owner: the tab could be filtered but not navigated): free-text search,
// a date window, a copyable per-row permalink, and the jump-to-row that permalink
// implies.
const PANEL_ID = 'dash-panel-moneylog';

// Module-level, not per-init: initAdminMoneyLogPanel() re-runs on every panel swap to
// re-wire the fresh DOM, and createFloatingPortal registers document-level listeners
// on each call — building one per swap would pile them up.
let rangePortal: FloatingPortal | null = null;

/** Current narrowing, read back off the DOM the server just rendered — so no control
 *  can drop another one's state (searching must not clear the date window). */
function currentParams(): Record<string, string | undefined> {
  const toolbar = document.getElementById('admin-moneylog-toolbar');
  const search = document.getElementById('admin-moneylog-search') as HTMLInputElement | null;
  return {
    mtype: toolbar?.dataset.type || undefined,
    mq: search?.value.trim() || undefined,
    mfrom: toolbar?.dataset.from || undefined,
    mto: toolbar?.dataset.to || undefined,
  };
}

function navigate(overrides: Record<string, string | undefined>, afterSwap?: () => void): void {
  const url = buildAdminUrl('moneylog', { ...currentParams(), ...overrides });
  swapPanel(url, PANEL_ID, () => {
    initAdminMoneyLogPanel();
    afterSwap?.();
  });
}

function wireSearch(): void {
  const input = document.getElementById('admin-moneylog-search') as HTMLInputElement | null;
  // Refocuses itself after the swap (the input node is replaced) so typing continues
  // uninterrupted — same as the Orders tab's search box.
  input?.addEventListener('input', debounce(() => navigate({}, () => {
    const fresh = document.getElementById('admin-moneylog-search') as HTMLInputElement | null;
    if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
  }), 250));
}

function wireRangePicker(): void {
  const toolbar = document.getElementById('admin-moneylog-toolbar');
  const trigger = document.getElementById('admin-moneylog-range-trigger');
  if (!toolbar || !trigger) return;
  if (!rangePortal) rangePortal = createFloatingPortal('admin-moneylog-range-portal');
  const portal = rangePortal;

  trigger.addEventListener('click', () => {
    if (portal.currentTrigger() === trigger) { portal.close(); return; }
    // The panel itself is `lib/toolbar-range-picker.ts`, shared with the Alerts tab — this file
    // only says what a chosen window means in THIS tab's query params.
    openRangePicker(portal, trigger, {
      from: toolbar.dataset.from ?? '',
      to: toolbar.dataset.to ?? '',
      // "נקה" here returns to the default 30-day window, not to the whole journal: the money log
      // never opens unbounded (admin-moneylog-filter.ts#MONEY_LOG_DEFAULT_DAYS says why), so
      // offering "everything" would name a state the tab cannot be in.
      clearLabel: 'חזרה לברירת המחדל',
      onApply: ({ from, to }) => navigate({ mfrom: from || undefined, mto: to || undefined }),
      onClear: () => navigate({ mfrom: undefined, mto: undefined }),
    });
  });
}

/** Copies the row's own `?mev=` URL. The page a row sits on depends on the filters and
 *  on rows appended since, so the link carries the event id and the SERVER resolves it
 *  to a page — that is what makes it survive the journal growing. */
function wirePermalinks(): void {
  const rows = document.getElementById('admin-moneylog-rows');
  if (!rows || rows.dataset.copyWired) return;
  rows.dataset.copyWired = '1';
  rows.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.admin-moneylog-link-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const url = new URL(btn.dataset.permalink ?? '', location.origin).href;
    navigator.clipboard.writeText(url)
      .then(() => showToast('הקישור לשורה הועתק'))
      .catch(() => showErrorToast('לא ניתן היה להעתיק את הקישור'));
  });
}

/** Brings the `?mev=` row into view. `block:'nearest'` and no smooth behaviour on
 *  purpose (AI_INSTRUCTIONS → Scroll): the row is already highlighted server-side, so
 *  this only has to stop it being off-screen, not perform a journey. */
function revealTarget(): void {
  const rows = document.getElementById('admin-moneylog-rows');
  const id = rows?.dataset.highlight;
  if (!id) return;
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.hidden) return; // linked-to row on a tab the admin isn't looking at
  document.querySelector(`[data-event-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

export function initAdminMoneyLogPanel(): void {
  wireSearch();
  wireRangePicker();
  wirePermalinks();
  revealTarget();
  wirePanelLinks(PANEL_ID, () => initAdminMoneyLogPanel());
  wirePopstateReload();
}
