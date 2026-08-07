// Two small pieces of tab-navigation glue for /admin (CURRENT_TASK.md → סשן ב׳):
import { initGotoPanelLinks } from '../dashboard/ui.js';
import { stripForeignTabParams } from '../../lib/admin-nav.js';
// The same list the server validates against (lib/admin-tabs.ts) — a copy here is how a tab the
// client reports becomes a tab the route answers 400 to. That module imports nothing, which is
// what lets browser code have it; `admin-tab-views.ts` cannot come here, it imports the database.
import { isTrackedAdminTab } from '../../lib/admin-tabs.js';
import { acknowledgeTabLeft, initAdminTabBadges } from './tab-badges.js';

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
  if (!isTrackedAdminTab(panel)) return;
  const recorded = fetch('/api/admin/tab-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab: panel }),
  });
  // The live poller has to know this write is in flight, or a response that left before it lands
  // puts the badge back — same number, apparently unclearable (tab-badges.ts).
  acknowledgeTabLeft(panel, recorded);
  recorded.catch(() => {});
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
  // The badges keep updating while the admin sits on one tab — that is the whole point of them.
  initAdminTabBadges();

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
      if (isTrackedAdminTab(leftPanel)) clearTabBadge(leftPanel);
      recordLeft(leftPanel);
    });
  });

  // Closing the browser / navigating away is also "leaving the tab" — without
  // this, an admin who only ever works inside one tab and then closes the page
  // would never acknowledge it, and the same "(N)" would greet them forever.
  //
  // `keepalive`, not `sendBeacon`, and the difference matters here: both survive
  // page teardown, but a beacon cannot carry a request header, and every mutating
  // request on this site now carries the CSRF token in one (src/lib/csrf.ts). The
  // beacon would have needed an exemption from that check — a hole opened for a
  // convenience, on the one endpoint that is easiest to forget about again. Same
  // shape the error reporter and the tracking module already use; the 64KB
  // keepalive ceiling is irrelevant to a body that holds one tab name.
  window.addEventListener('pagehide', () => {
    if (!isTrackedAdminTab(activePanel)) return;
    void fetch('/api/admin/tab-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: activePanel }),
      keepalive: true,
    }).catch(() => {});
  });
}
