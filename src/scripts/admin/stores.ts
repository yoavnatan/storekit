import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const PANEL_ID = 'dash-panel-stores';

const storesPortal = createFloatingPortal('admin-stores-toolbar-portal');

type StoreSortCol = 'name' | 'revenue' | 'products';
const STORE_SORT_OPTIONS: { col: StoreSortCol; dir: 'asc' | 'desc'; label: string }[] = [
  { col: 'name', dir: 'asc', label: 'שם: א — ת' },
  { col: 'name', dir: 'desc', label: 'שם: ת — א' },
  { col: 'revenue', dir: 'desc', label: 'הכנסות: גבוה — נמוך' },
  { col: 'revenue', dir: 'asc', label: 'הכנסות: נמוך — גבוה' },
  { col: 'products', dir: 'desc', label: 'מוצרים: רב — מעט' },
];

// Same pattern as sellers.ts's wireSellersToolbar (sort portal + a single
// blocked-only toggle button, no column→values filter menu needed).
function wireStoresToolbar(): void {
  const root = document.getElementById('admin-stores-toolbar');
  if (!root) return;

  const state = root.dataset;
  let sortCol = (state.sortCol as StoreSortCol) || 'name';
  let sortDir = (state.sortDir as 'asc' | 'desc') || 'asc';
  let blockedOnly = state.blockedOnly === '1';

  function buildStoresNavUrl(): string {
    const searchInput = document.getElementById('admin-store-search') as HTMLInputElement | null;
    return buildAdminUrl('stores', {
      stq: searchInput?.value.trim() || undefined,
      stsort: (sortCol !== 'name' || sortDir !== 'asc') ? `${sortCol}:${sortDir}` : undefined,
      stblocked: blockedOnly ? '1' : undefined,
    });
  }

  function navigate(): void {
    swapPanel(buildStoresNavUrl(), PANEL_ID, () => initAdminStoresPanel());
  }

  const sortTrigger = document.getElementById('admin-stores-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (storesPortal.currentTrigger() === sortTrigger) { storesPortal.close(); return; }
    storesPortal.open(sortTrigger, '15rem', () => STORE_SORT_OPTIONS.map((o) => {
      const selected = o.col === sortCol && o.dir === sortDir;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortCol = (btn.dataset.sortCol as StoreSortCol) ?? 'name';
          sortDir = (btn.dataset.sortDir as 'asc' | 'desc') ?? 'asc';
          navigate();
        });
      });
    });
  });

  const blockedToggle = document.getElementById('admin-stores-blocked-toggle') as HTMLButtonElement | null;
  blockedToggle?.addEventListener('click', () => {
    blockedOnly = !blockedOnly;
    navigate();
  });
}

// Stores tab: flat, top-level list of every store across all sellers (see
// AdminStoresPanel.astro's header comment). Deliberately does NOT reuse the
// Sellers tab's `.admin-block-toggle` class/selector — AdminSellersPanel's
// own initAdminSellersPanel() wires that class document-wide regardless of
// which tab is visible (both panels' markup is always in the DOM, just
// hidden), so sharing the class would double-bind a click handler to the
// same button and fire the moderation request twice. This file owns its own
// class (`.admin-store-row-toggle`) and DOM-update logic instead.
// Search round-trips to the server (see admin-stats.ts#filterStoreRows) so it
// stays correct once pagination means most stores aren't in the DOM at all.
function initStoreSearch(): void {
  const searchInput = document.getElementById('admin-store-search') as HTMLInputElement | null;
  if (!searchInput) return;
  searchInput.addEventListener('input', debounce(() => {
    const url = buildAdminUrl('stores', { stq: searchInput.value.trim() || undefined });
    swapPanel(url, PANEL_ID, () => {
      initAdminStoresPanel();
      const fresh = document.getElementById('admin-store-search') as HTMLInputElement | null;
      if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
    });
  }, 450));
}

// Same optimistic-update pattern as the Sellers tab's block toggle (button
// label + badge flip immediately, revert on failure) — see sellers.ts.
function initStoreBlockToggles(): void {
  document.querySelectorAll<HTMLButtonElement>('.admin-store-row-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wasBlocked = btn.dataset.blocked === '1';
      const action = wasBlocked ? 'unblock-store' : 'block-store';

      btn.disabled = true;
      try {
        const res = await fetch('/api/admin/moderation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, storeSlug: btn.dataset.storeSlug }),
        });
        if (!res.ok) throw new Error('request failed');
        const { blocked } = await res.json() as { blocked: boolean };
        btn.dataset.blocked = blocked ? '1' : '';
        btn.textContent = blocked ? 'בטל חסימה' : 'חסום חנות';
        btn.classList.toggle('btn--ghost', !blocked);

        const nameEl = btn.closest('.admin-store-row')?.querySelector('.admin-store-row__name');
        const existingBadge = nameEl?.querySelector('.admin-badge');
        if (blocked && !existingBadge) {
          const badge = document.createElement('span');
          badge.className = 'admin-badge admin-badge--failed';
          badge.textContent = 'חסום';
          nameEl?.appendChild(badge);
        } else if (!blocked && existingBadge) {
          existingBadge.remove();
        }
      } catch {
        alert('הפעולה נכשלה, נסו שוב.');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

export function initAdminStoresPanel(): void {
  initStoreSearch();
  initStoreBlockToggles();
  wireStoresToolbar();
  wirePanelLinks(PANEL_ID, () => initAdminStoresPanel());
  wirePopstateReload();
}
