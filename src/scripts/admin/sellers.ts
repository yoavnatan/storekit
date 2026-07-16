import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const PANEL_ID = 'dash-panel-sellers';

// Module-level singleton, not created inside initAdminSellersPanel() — that
// function re-runs on every AJAX panel swap (see orders-filter.ts's own
// comment on the same pattern), and createFloatingPortal() wires its own
// document-level listeners on every call.
const sellersPortal = createFloatingPortal('admin-sellers-toolbar-portal');

type SellerSortCol = 'joined' | 'revenue' | 'stores';
const SELLER_SORT_OPTIONS: { col: SellerSortCol; dir: 'asc' | 'desc'; label: string }[] = [
  { col: 'joined', dir: 'desc', label: 'הצטרפות: חדש — ישן' },
  { col: 'joined', dir: 'asc', label: 'הצטרפות: ישן — חדש' },
  { col: 'revenue', dir: 'desc', label: 'הכנסות: גבוה — נמוך' },
  { col: 'revenue', dir: 'asc', label: 'הכנסות: נמוך — גבוה' },
  { col: 'stores', dir: 'desc', label: 'מספר חנויות: רב — מעט' },
];

// Sort dropdown (shared floating portal) + "יש חנות חסומה" toggle — mirrors
// the Orders tab's own toolbar (admin-orders-filter.ts's header comment)
// but simpler: Sellers only has one binary filter dimension, so it's a
// plain toggle button instead of a column→values portal menu.
function wireSellersToolbar(): void {
  const root = document.getElementById('admin-sellers-toolbar');
  if (!root) return; // no sellers at all — nothing to wire

  const state = root.dataset;
  let sortCol = (state.sortCol as SellerSortCol) || 'joined';
  let sortDir = (state.sortDir as 'asc' | 'desc') || 'desc';
  let blockedOnly = state.blockedOnly === '1';

  function buildSellersNavUrl(): string {
    const searchInput = document.getElementById('admin-seller-search') as HTMLInputElement | null;
    return buildAdminUrl('sellers', {
      sq: searchInput?.value.trim() || undefined,
      ssort: (sortCol !== 'joined' || sortDir !== 'desc') ? `${sortCol}:${sortDir}` : undefined,
      sblocked: blockedOnly ? '1' : undefined,
    });
  }

  function navigate(): void {
    swapPanel(buildSellersNavUrl(), PANEL_ID, () => initAdminSellersPanel());
  }

  const sortTrigger = document.getElementById('admin-sellers-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (sellersPortal.currentTrigger() === sortTrigger) { sellersPortal.close(); return; }
    sellersPortal.open(sortTrigger, '15rem', () => SELLER_SORT_OPTIONS.map((o) => {
      const selected = o.col === sortCol && o.dir === sortDir;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortCol = (btn.dataset.sortCol as SellerSortCol) ?? 'joined';
          sortDir = (btn.dataset.sortDir as 'asc' | 'desc') ?? 'desc';
          navigate();
        });
      });
    });
  });

  const blockedToggle = document.getElementById('admin-sellers-blocked-toggle') as HTMLButtonElement | null;
  blockedToggle?.addEventListener('click', () => {
    blockedOnly = !blockedOnly;
    navigate();
  });
}

// "Send message" opens a modal right where the seller card already lives
// (no tab navigation) — posts straight to the admin messages API; the
// seller sees it as a normal message in their own merged messages tab
// (see CURRENT_TASK.md → סשן א׳), no separate reply UI needed here.
function wireSellerMessageModal(): void {
  const dialog = document.getElementById('admin-seller-msg-modal') as HTMLDialogElement | null;
  const title = document.getElementById('admin-seller-msg-modal-title');
  const sellerIdInput = document.getElementById('admin-seller-msg-modal-seller-id') as HTMLInputElement | null;
  const textarea = document.getElementById('admin-seller-msg-modal-textarea') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('admin-seller-msg-modal-send') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('admin-seller-msg-modal-close');
  if (!dialog || !sellerIdInput || !textarea || !sendBtn) return;

  document.querySelectorAll<HTMLButtonElement>('.admin-msg-open-modal').forEach((btn) => {
    btn.addEventListener('click', () => {
      sellerIdInput.value = btn.dataset.sellerId ?? '';
      if (title) title.textContent = `הודעה חדשה ל${btn.dataset.sellerName ?? ''}`;
      textarea.value = '';
      dialog.showModal();
      textarea.focus();
    });
  });

  closeBtn?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  sendBtn.addEventListener('click', async () => {
    const sellerId = sellerIdInput.value;
    const content = textarea.value.trim();
    if (!sellerId || !content) return;
    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/admin/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerId, content }),
      });
      if (!res.ok) throw new Error('request failed');
      dialog.close();
    } catch {
      alert('שליחת ההודעה נכשלה, נסו שוב.');
    } finally {
      sendBtn.disabled = false;
    }
  });
}

// Search now round-trips to the server (see admin-stats.ts#filterSellerCards)
// so it stays correct once pagination means most sellers aren't in the DOM at
// all. Debounced, then AJAX-swapped (not a full-page nav — see admin-nav.ts's
// swapPanel) so mid-typing the panel refreshes in place instead of flashing
// the whole page; the search input is a fresh DOM node afterward, so it's
// refocused (cursor at the end) right after the swap.
function wireSellerSearch(): void {
  const searchInput = document.getElementById('admin-seller-search') as HTMLInputElement | null;
  if (!searchInput) return;
  searchInput.addEventListener('input', debounce(() => {
    const url = buildAdminUrl('sellers', { sq: searchInput.value.trim() || undefined });
    swapPanel(url, PANEL_ID, () => {
      initAdminSellersPanel();
      const fresh = document.getElementById('admin-seller-search') as HTMLInputElement | null;
      if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
    });
  }, 450));
}

// Store/product block toggle — admin-only kill switch (see moderation.ts).
// Optimistic DOM update (button label + badge) so the accordion doesn't
// collapse/reload; a failed request reverts the button back.
export function initAdminSellersPanel(): void {
  wireSellerMessageModal();
  wireSellerSearch();
  wireSellersToolbar();
  wirePanelLinks(PANEL_ID, () => initAdminSellersPanel());
  wirePopstateReload();

  document.querySelectorAll<HTMLButtonElement>('.admin-block-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.kind;
      const wasBlocked = btn.dataset.blocked === '1';
      const action = kind === 'store'
        ? (wasBlocked ? 'unblock-store' : 'block-store')
        : (wasBlocked ? 'unblock-product' : 'block-product');
      const body = kind === 'store'
        ? { action, storeSlug: btn.dataset.storeSlug }
        : { action, productId: btn.dataset.productId };

      btn.disabled = true;
      try {
        const res = await fetch('/api/admin/moderation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('request failed');
        const { blocked } = await res.json() as { blocked: boolean };
        btn.dataset.blocked = blocked ? '1' : '';
        btn.textContent = blocked ? 'בטל חסימה' : (kind === 'store' ? 'חסום חנות' : 'חסום מוצר');
        btn.classList.toggle('btn--ghost', !blocked);
        const nameCell = kind === 'store'
          ? btn.closest('summary')?.querySelector('.admin-store-block__name')
          : btn.closest('tr')?.querySelector('td');
        const existingBadge = nameCell?.querySelector('.admin-badge');
        if (blocked && !existingBadge) {
          const badge = document.createElement('span');
          badge.className = 'admin-badge admin-badge--failed';
          badge.textContent = 'חסום';
          nameCell?.appendChild(badge);
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
