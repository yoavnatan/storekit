import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { showErrorToast } from '../../lib/toast.js';

const PANEL_ID = 'dash-panel-sellers';

// Module-level singleton, not created inside initAdminSellersPanel() — that
// function re-runs on every AJAX panel swap (see orders-filter.ts's own
// comment on the same pattern), and createFloatingPortal() wires its own
// document-level listeners on every call.
const sellersPortal = createFloatingPortal('admin-sellers-toolbar-portal');
// Separate singleton for the per-card actions kebab (see stores.ts for the same split).
const sellersActionsPortal = createFloatingPortal('admin-sellers-actions-portal');
const MENU_ITEM =
  'product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]';

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
  let newOnly = state.newOnly === '1';
  // Read off the chip row rather than the toolbar: the chips are their own element (they carry a
  // label and a count, so they do not fit beside the two toggles), and a panel with no sellers at
  // all renders neither.
  let payoutState = document.getElementById('admin-sellers-payout-chips')?.dataset.payoutState ?? 'all';

  function buildSellersNavUrl(): string {
    const searchInput = document.getElementById('admin-seller-search') as HTMLInputElement | null;
    return buildAdminUrl('sellers', {
      sq: searchInput?.value.trim() || undefined,
      ssort: (sortCol !== 'joined' || sortDir !== 'desc') ? `${sortCol}:${sortDir}` : undefined,
      sblocked: blockedOnly ? '1' : undefined,
      spayout: payoutState !== 'all' ? payoutState : undefined,
      snew: newOnly ? '1' : undefined,
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
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
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

  // The payout-state chips. Radio, not toggles: the four states are mutually exclusive and "הכל"
  // is the way back out, so clicking the active one is a no-op rather than a clear — a click that
  // changes no state must move nothing (memory `feedback_noop_interactions_invisible`).
  document.querySelectorAll<HTMLButtonElement>('[data-payout-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const next = chip.dataset.payoutChip ?? 'all';
      if (next === payoutState) return;
      payoutState = next;
      navigate();
    });
  });

  // "חדשים בלבד" — same mechanics as the blocked toggle; narrows the list to
  // exactly the sellers the tab's "(N)" badge counted (see AdminNewBadge.astro).
  const newToggle = document.getElementById('admin-sellers-new-toggle') as HTMLButtonElement | null;
  newToggle?.addEventListener('click', () => {
    newOnly = !newOnly;
    navigate();
  });
}

// "Send message" opens a modal right where the seller card already lives
// (no tab navigation) — posts straight to the admin messages API; the
// seller sees it as a normal message in their own merged messages tab
// (see CURRENT_TASK.md → סשן א׳), no separate reply UI needed here.
// Shared modal opener — reused by the per-card kebab menu item. Re-queries the
// dialog each call (stable IDs, one modal per panel) so it works regardless of
// which card triggered it.
function openSellerMsgModal(sellerId: string, sellerName: string): void {
  const dialog = document.getElementById('admin-seller-msg-modal') as HTMLDialogElement | null;
  const title = document.getElementById('admin-seller-msg-modal-title');
  const sellerIdInput = document.getElementById('admin-seller-msg-modal-seller-id') as HTMLInputElement | null;
  const textarea = document.getElementById('admin-seller-msg-modal-textarea') as HTMLTextAreaElement | null;
  if (!dialog || !sellerIdInput || !textarea) return;
  sellerIdInput.value = sellerId;
  if (title) title.textContent = `הודעה חדשה ל${sellerName}`;
  textarea.value = '';
  dialog.showModal();
  textarea.focus();
}

// Per-card kebab menu (Sellers tab) — currently one action (send message), in a
// dropdown for consistency with the Stores tab and room to grow.
function initSellerCardActions(): void {
  document.querySelectorAll<HTMLButtonElement>('.admin-seller-card__kebab').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sellersActionsPortal.currentTrigger() === trigger) { sellersActionsPortal.close(); return; }
      const id = trigger.dataset.sellerId ?? '';
      const name = trigger.dataset.sellerName ?? '';
      sellersActionsPortal.open(trigger, '12rem',
        () => `<button type="button" class="${MENU_ITEM}" data-action="message">שלח הודעה</button>`,
        (p) => {
          p.querySelector('[data-action="message"]')?.addEventListener('click', () => {
            sellersActionsPortal.close();
            openSellerMsgModal(id, name);
          });
        });
    });
  });
}

function wireSellerMessageModal(): void {
  const dialog = document.getElementById('admin-seller-msg-modal') as HTMLDialogElement | null;
  const sellerIdInput = document.getElementById('admin-seller-msg-modal-seller-id') as HTMLInputElement | null;
  const textarea = document.getElementById('admin-seller-msg-modal-textarea') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('admin-seller-msg-modal-send') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('admin-seller-msg-modal-close');
  if (!dialog || !sellerIdInput || !textarea || !sendBtn) return;

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
      showErrorToast('שליחת ההודעה נכשלה, נסו שוב');
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

// The Sellers tab no longer blocks stores/products inline — each store is now
// a link into the Stores tab (AdminStoresPanel), which owns the paginated
// product list + all block toggles (with confirm dialogs). This keeps a single
// place for moderation instead of duplicating it three levels deep here.
export function initAdminSellersPanel(): void {
  wireSellerMessageModal();
  initSellerCardActions();
  wireSellerSearch();
  wireSellersToolbar();
  wirePanelLinks(PANEL_ID, () => initAdminSellersPanel());
  wirePopstateReload();
}
