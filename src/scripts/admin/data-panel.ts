import { wirePanelLinks, wirePopstateReload, swapPanel, buildAdminUrl } from '../../lib/admin-nav.js';
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

// The four presets, then the custom from/to row — the shape every other range picker in the admin
// already has, and the one this tab was missing (owner, 2026-08-23: *"לא רואה טווח תאריכים כמו כל
// שאר הלשוניות בדשבורד אדמין, בלשונית נתונים"*). The preset URLs are precomputed server-side; the
// custom one cannot be, because it depends on two values that do not exist until he types them, so
// it is the one URL built here — with `buildAdminUrl`, the same helper the SSR uses, rather than by
// string-appending onto a preset's.
function buildMenu(options: RangeOption[], active: string, from: string, to: string): string {
  const presets = options.map((o) => `<button type="button" role="menuitem" data-key="${escapeHtml(o.key)}" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" style="${o.key === active ? 'font-weight:700;color:var(--color-primary)' : ''}">${escapeHtml(o.label)}</button>`).join('');
  return `${presets}
    <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>
    <div class="px-3 pt-1.5 pb-2">
      <div class="text-[.72rem] [color:var(--color-muted)] mb-1.5">טווח מותאם</div>
      <div class="flex items-center gap-1.5" dir="ltr">
        <input type="date" data-data-from value="${escapeHtml(from)}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
        <span class="muted text-[0.8rem] shrink-0">–</span>
        <input type="date" data-data-to value="${escapeHtml(to)}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
        <button type="button" class="btn btn--sm btn--accent shrink-0" data-data-apply>הצג</button>
      </div>
    </div>`;
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
    const picker = panel.querySelector<HTMLElement>('#data-range-picker');
    const active = picker?.dataset.activePreset ?? '';
    const from = picker?.dataset.from ?? '';
    const to = picker?.dataset.to ?? '';
    // 19rem, not 11: the custom row is two date inputs and a button on one line, and at 11rem they
    // wrapped into a column. Same width the advertising picker settled on for the same row.
    portal.open(trigger, '19rem', () => buildMenu(options, active, from, to), (portalEl) => {
      const go = (url: string): void => {
        portal.close();
        void swapPanel(url, PANEL_ID, () => initAdminDataPanel());
      };
      portalEl.querySelectorAll<HTMLButtonElement>('[data-key]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = options.find((o) => o.key === btn.dataset.key)?.url;
          portal.close();
          if (url) void swapPanel(url, PANEL_ID, () => initAdminDataPanel());
        });
      });
      portalEl.querySelector('[data-data-apply]')?.addEventListener('click', () => {
        const f = portalEl.querySelector<HTMLInputElement>('[data-data-from]')?.value;
        const t = portalEl.querySelector<HTMLInputElement>('[data-data-to]')?.value;
        // Both or neither: one date is not a range, and sending it would land on `coerceRange`'s
        // 7-day fallback — a silent answer to a question he did not ask.
        if (!f || !t) return;
        go(buildAdminUrl('data', { datapreset: 'custom', datafrom: f, datato: t }));
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
