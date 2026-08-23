import { wirePanelLinks, wirePopstateReload, swapPanel } from '../../lib/admin-nav.js';
import { createFloatingPortal, type FloatingPortal } from '../../lib/toolbar-portal.js';
import { initInfoTooltips } from '../tooltip.js';
import { escapeHtml } from '../../lib/html-escape.js';

const PANEL_ID = 'dash-panel-data';

interface RangeOption { key: string; label: string; url: string }

// One shared portal for the range dropdown. createFloatingPortal wires
// document-level listeners on each call, so it must be a module-level singleton —
// never re-created on a panel re-init (same rule the other admin pickers follow).
let rangePortal: FloatingPortal | null = null;
function getRangePortal(): FloatingPortal {
  if (!rangePortal) rangePortal = createFloatingPortal('data-range-portal');
  return rangePortal;
}

function buildMenu(options: RangeOption[], active: string): string {
  return options.map((o) => `<button type="button" role="menuitem" data-key="${escapeHtml(o.key)}" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" style="${o.key === active ? 'font-weight:700;color:var(--color-primary)' : ''}">${escapeHtml(o.label)}</button>`).join('');
}

// The range picker is the same trigger + floating-portal dropdown the
// performance/advertising tabs use. Choosing a preset navigates via swapPanel so
// the SSR recomputes the funnel over the new window (the URLs are precomputed
// server-side per preset). Wired ONCE via delegation on the panel CONTAINER,
// which survives every swapPanel innerHTML replace, so the freshly-rebuilt
// trigger keeps working without rebinding on each range change.
function wireRangePicker(): void {
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.dataset.rangeWired) return;
  panel.dataset.rangeWired = '1';
  panel.addEventListener('click', (e) => {
    const trigger = (e.target as HTMLElement).closest<HTMLElement>('#data-range-trigger');
    if (!trigger) return;
    const portal = getRangePortal();
    if (portal.currentTrigger() === trigger) { portal.close(); return; }
    let options: RangeOption[] = [];
    try { options = JSON.parse(panel.querySelector('#data-range-presets')?.textContent ?? '[]') as RangeOption[]; }
    catch { /* leave empty — nothing to open */ }
    const active = panel.querySelector<HTMLElement>('#data-range-picker')?.dataset.activePreset ?? '';
    portal.open(trigger, '11rem', () => buildMenu(options, active), (portalEl) => {
      portalEl.querySelectorAll<HTMLButtonElement>('[data-key]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = options.find((o) => o.key === btn.dataset.key)?.url;
          portal.close();
          if (url) void swapPanel(url, PANEL_ID, () => initAdminDataPanel());
        });
      });
    });
  });
}

export function initAdminDataPanel(): void {
  wirePanelLinks(PANEL_ID, () => initAdminDataPanel());
  wirePopstateReload();
  wireRangePicker();
  // (Re)bind the "(i)" info tooltips inside this panel — on first load and again
  // after a range change swaps the panel's innerHTML with fresh buttons.
  const panel = document.getElementById(PANEL_ID);
  if (panel) initInfoTooltips(panel);
}
