import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';

const PANEL_ID = 'dash-panel-stores';

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
  wirePanelLinks(PANEL_ID, () => initAdminStoresPanel());
  wirePopstateReload();
}
