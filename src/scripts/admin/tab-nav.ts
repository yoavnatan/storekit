// Two small pieces of tab-navigation glue for /admin (CURRENT_TASK.md → סשן ב׳):
import { initGotoPanelLinks } from '../dashboard/ui.js';

const TRACKED_TABS = new Set(['sellers', 'stores', 'orders', 'alerts']);

function clearTabBadge(panel: string): void {
  const span = document.getElementById(`tab-count-${panel}`);
  if (!span) return;
  span.hidden = true;
  span.textContent = '';
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

export function initAdminTabNav(): void {
  initGotoPanelLinks();

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
