// Two small pieces of tab-navigation glue for /admin (CURRENT_TASK.md → סשן ב׳):
import { initGotoPanelLinks } from '../dashboard/ui.js';
import { stripForeignTabParams } from '../../lib/admin-nav.js';

const TRACKED_TABS = new Set(['sellers', 'stores', 'orders', 'alerts']);

// Everything that says "this tab has new rows" is cleared together, the moment
// the tab is left — the count on the tab, the "חדש" chip on each row, and the
// "חדשים בלבד (N)" filter chip. They're three views of ONE fact (the server-side
// last-viewed boundary that recordLeft is about to advance), so they must not be
// able to disagree. They can, without this: the panels are server-rendered HTML
// and switching tabs only toggles `hidden` — nothing re-renders — so the chips
// used to keep claiming rows were new long after the count had gone, right up
// until the next full page load (owner feedback, 2026-07-29).
function clearTabBadge(panel: string): void {
  const span = document.getElementById(`tab-count-${panel}`);
  if (span) {
    span.hidden = true;
    span.textContent = '';
  }

  const panelEl = document.getElementById(`dash-panel-${panel}`);
  if (!panelEl) return;
  panelEl.querySelectorAll('.admin-new-chip').forEach((chip) => chip.remove());

  // The toggle itself stays (it may be the active filter) — only its now-stale
  // count is dropped.
  const newOnlyToggle = document.getElementById(`admin-${panel}-new-toggle`);
  if (newOnlyToggle) {
    newOnlyToggle.textContent = (newOnlyToggle.textContent ?? '').replace(/\s*\(\d+\)\s*$/, '');
  }
}

// Advancing the "last viewed" boundary is what turns a row from new to seen —
// so it must happen on LEAVING the tab, never on entering it. Rendering /admin
// used to advance it server-side, which meant the tab said "(3) new" while the
// rows inside carried no mark at all, and any in-panel AJAX refresh (search /
// sort / pager, all of which re-fetch this same route) wiped the marks
// mid-session. Now the server only reads the boundary; this is the only writer.
function recordLeft(panel: string): void {
  if (!TRACKED_TABS.has(panel)) return;
  fetch('/api/admin/tab-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab: panel }),
  }).catch(() => {});
}

// The address bar must describe the tab you are LOOKING at, and nothing else.
// initDashTabs()'s activateTab only sets `panel`, so every param of every tab
// visited earlier in the session accumulated in the URL — harmless-looking until
// a reload or a shared link re-applies a filter belonging to a tab that isn't
// even open (owner, סשן ד׳: "ה-url params שלהם נשארים גם במעבר ללשוניות אחרות").
// Hooked on `dashtab:show` rather than on the tab button's click so keyboard
// arrow-key switching (which activates a tab without dispatching a click) is
// covered by the same code path.
function wireTabParamCleanup(): void {
  document.addEventListener('dashtab:show', (e) => {
    const panelId = (e.target as HTMLElement | null)?.id;
    if (!panelId?.startsWith('dash-panel-')) return;
    const url = stripForeignTabParams(new URL(location.href), panelId.slice('dash-panel-'.length));
    history.replaceState(null, '', url.toString());
  });
}

export function initAdminTabNav(): void {
  initGotoPanelLinks();
  wireTabParamCleanup();

  // initDashTabs() switches tabs entirely client-side with no reload, so this
  // tracks the currently-active tab itself (independent of listener order vs.
  // initDashTabs()'s own click handler on the same buttons) rather than reading
  // the DOM's `dash-tab--active` class, which may have already moved by the
  // time this runs.
  let activePanel = document.querySelector<HTMLButtonElement>('[role="tab"].dash-tab--active')?.dataset.panel ?? 'overview';

  document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-panel]').forEach((tab) => {
    const panel = tab.dataset.panel;
    if (!panel) return;
    tab.addEventListener('click', () => {
      if (panel === activePanel) return; // re-clicking the tab you're already on — not a "leave"
      const leftPanel = activePanel;
      activePanel = panel;
      if (TRACKED_TABS.has(leftPanel)) clearTabBadge(leftPanel);
      recordLeft(leftPanel);
    });
  });

  // Closing the browser / navigating away is also "leaving the tab" — without
  // this, an admin who only ever works inside one tab and then closes the page
  // would never acknowledge it, and the same "(N)" would greet them forever.
  // sendBeacon survives page teardown where fetch does not; the endpoint reads
  // the body as JSON regardless of the Blob's content type.
  window.addEventListener('pagehide', () => {
    if (!TRACKED_TABS.has(activePanel)) return;
    navigator.sendBeacon('/api/admin/tab-view', new Blob([JSON.stringify({ tab: activePanel })], { type: 'application/json' }));
  });
}
