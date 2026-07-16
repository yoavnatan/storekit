// Two small pieces of tab-navigation glue for /admin (CURRENT_TASK.md → סשן ב׳):
const TRACKED_TABS = new Set(['sellers', 'stores', 'orders', 'alerts']);

function clearTabBadge(panel: string): void {
  const span = document.getElementById(`tab-count-${panel}`);
  if (!span) return;
  span.hidden = true;
  span.textContent = '';
}

export function initAdminTabNav(): void {
  // Overview stat cards (AdminOverviewPanel.astro's [data-goto-panel]) jump
  // straight to their tab by clicking the matching tab button — reuses
  // initDashTabs()'s own click handler (src/scripts/dashboard/ui.ts, shared
  // unchanged with the seller dashboard) instead of a real navigation, which
  // would flash a full page reload.
  document.querySelectorAll<HTMLElement>('[data-goto-panel]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>(`[role="tab"][data-panel="${el.dataset.gotoPanel}"]`)?.click();
    });
  });

  // The "(N) new" badge should clear the moment the admin *leaves* the tab
  // they just looked at — not the instant they enter it (they still want to
  // see "these are new" while actually on the tab), and not on some poll
  // timer. initDashTabs() switches tabs entirely client-side with no
  // reload, so this tracks the currently-active tab itself (independent of
  // listener order vs. initDashTabs()'s own click handler on the same
  // buttons) rather than reading the DOM's `dash-tab--active` class, which
  // may have already moved by the time this runs.
  let activePanel = document.querySelector<HTMLButtonElement>('[role="tab"].dash-tab--active')?.dataset.panel ?? 'overview';

  document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-panel]').forEach((tab) => {
    const panel = tab.dataset.panel;
    if (!panel) return;
    tab.addEventListener('click', () => {
      if (panel === activePanel) return; // re-clicking the tab you're already on — not a "leave"
      const leftPanel = activePanel;
      activePanel = panel;
      if (TRACKED_TABS.has(leftPanel)) clearTabBadge(leftPanel);

      // Also tell the server this tab was opened — fire-and-forget; only
      // needed so the *next* full page load computes a fresh "(N)" for
      // whatever tab(s) get visited again later (see admin-tab-views.ts).
      if (TRACKED_TABS.has(panel)) {
        fetch('/api/admin/tab-view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tab: panel }),
        }).catch(() => {});
      }
    });
  });
}
