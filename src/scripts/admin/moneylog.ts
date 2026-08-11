import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal, toolbarMenuTitle, type FloatingPortal } from '../../lib/toolbar-portal.js';
import { openRangePicker } from '../../lib/toolbar-range-picker.js';
import { MONEY_EVENT_GROUPS, MONEY_EVENT_LABELS } from '../../lib/money-event-types.js';
import { showToast, showErrorToast } from '../../lib/toast.js';

// Money-journal tab. The panel is still SSR-filtered — every control here does the
// same thing: rewrite this tab's query params and let the server re-render the panel
// (swapPanel). Nothing filters DOM rows, since only one page of rows is ever present.
// Added סשן ג׳ (owner: the tab could be filtered but not navigated): free-text search,
// a date window, a copyable per-row permalink, and the jump-to-row that permalink
// implies. The type filter became a menu in סשן ב׳ — AdminMoneyLogToolbar.astro says why.
const PANEL_ID = 'dash-panel-moneylog';

// Module-level, not per-init: initAdminMoneyLogPanel() re-runs on every panel swap to
// re-wire the fresh DOM, and createFloatingPortal registers document-level listeners
// on each call — building one per swap would pile them up. ONE portal for both menus:
// they are mutually exclusive by definition (the portal closes whatever it was showing
// before it opens the next), so a second instance would only add a second set of
// document listeners for a menu that can never be open at the same time.
let menuPortal: FloatingPortal | null = null;

/** Vocabulary, labels and sections all imported from `money-event-types.ts`, none of them re-typed
 *  here: the menu's labels are the SAME strings the free-text search matches against, and a copy in
 *  this file would be the second definition that quietly stops matching the day one changes. */
const MENU_ITEM_CLASS = 'product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]';

function typeItemHtml(id: string, label: string, active: string): string {
  const selected = id === active;
  return `<button type="button" class="${MENU_ITEM_CLASS}" data-money-type="${id}"${selected ? ' aria-current="true" style="font-weight:700;color:var(--color-primary)"' : ''}>${label}</button>`;
}

function sectionLabelHtml(text: string): string {
  return `<div class="px-3 pt-[.5rem] pb-[.2rem] text-[.7rem] font-semibold [color:var(--color-muted)] select-none">${text}</div>`;
}

/** "everything" first, then one section per subject. A type that belongs to no section would
 *  vanish from this menu, which is what the group guard test exists to prevent. */
function buildTypeMenu(active: string): string {
  return toolbarMenuTitle('סוג אירוע')
    + typeItemHtml('', 'כל סוגי האירועים', active)
    + MONEY_EVENT_GROUPS.map((g) =>
        sectionLabelHtml(g.label) + g.types.map((t) => typeItemHtml(t, MONEY_EVENT_LABELS[t], active)).join(''),
      ).join('');
}

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

/** The portal both menus share, built on first use. */
function getPortal(): FloatingPortal {
  if (!menuPortal) menuPortal = createFloatingPortal('admin-moneylog-menu-portal');
  return menuPortal;
}

/** The event-type menu — one narrowing with ten answers, which is a menu rather than ten
 *  chips (AdminMoneyLogToolbar.astro carries the reasoning). Picking one navigates
 *  immediately: there is a single value to choose, so an "apply" step would only add a
 *  click to every use. */
function wireTypePicker(): void {
  const toolbar = document.getElementById('admin-moneylog-toolbar');
  const trigger = document.getElementById('admin-moneylog-type-trigger');
  if (!toolbar || !trigger) return;
  const portal = getPortal();

  trigger.addEventListener('click', () => {
    if (portal.currentTrigger() === trigger) { portal.close(); return; }
    const active = toolbar.dataset.type ?? '';
    portal.open(trigger, '15rem', () => buildTypeMenu(active), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-money-type]').forEach((btn) => {
        btn.addEventListener('click', () => {
          portal.close();
          // `navigate` rebuilds the URL from the toolbar's own state, so the pager is dropped
          // here for free — which is what it has to be: page 4 of "everything" is not page 4
          // of one type, and landing past the end of the new result reads as an empty journal.
          navigate({ mtype: btn.dataset.moneyType || undefined });
        });
      });
    });
  });
}

function wireRangePicker(): void {
  const toolbar = document.getElementById('admin-moneylog-toolbar');
  const trigger = document.getElementById('admin-moneylog-range-trigger');
  if (!toolbar || !trigger) return;
  const portal = getPortal();

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
  wireTypePicker();
  wireRangePicker();
  wirePermalinks();
  revealTarget();
  wirePanelLinks(PANEL_ID, () => initAdminMoneyLogPanel());
  wirePopstateReload();
}
