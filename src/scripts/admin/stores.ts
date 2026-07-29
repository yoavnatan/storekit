import { buildAdminUrl, debounce, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { cdnThumb } from '../../lib/cdn.js';
import { showErrorToast } from '../../lib/toast.js';

const PANEL_ID = 'dash-panel-stores';

const storesPortal = createFloatingPortal('admin-stores-toolbar-portal');
// Separate module-level singleton for the per-row actions kebab (the sort
// portal above is a different trigger; sharing one would fight over currentTrigger).
const storesActionsPortal = createFloatingPortal('admin-stores-actions-portal');

// Shared item chrome for the kebab menu — the site's dropdown design system
// (same product-menu__item styling the sort dropdowns above use). Colour is left
// off the base so each action can carry its own (accent links, red block) the way
// the old inline row links did — set it per item, never alongside another colour.
const MENU_ITEM_BASE =
  'product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]';
const MENU_ITEM = `${MENU_ITEM_BASE} [color:var(--color-text)]`;
const MENU_DIVIDER = 'product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]';
const CHEVRON_DRILL = '<svg class="ms-auto shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
const CHEVRON_BACK = '<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

// Promotion-weight levels, chosen directly from a sub-menu (not cycled a step at
// a time). Index = the weight stored server-side. Kept in sync with the name
// badge label in AdminStoresPanel.astro / promoLabel below.
const PROMO_LEVEL_LABELS = ['ללא קידום', 'קידום', 'קידום חזק'];

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
  let newOnly = state.newOnly === '1';

  function buildStoresNavUrl(): string {
    const searchInput = document.getElementById('admin-store-search') as HTMLInputElement | null;
    return buildAdminUrl('stores', {
      stq: searchInput?.value.trim() || undefined,
      stsort: (sortCol !== 'name' || sortDir !== 'asc') ? `${sortCol}:${sortDir}` : undefined,
      stblocked: blockedOnly ? '1' : undefined,
      stnew: newOnly ? '1' : undefined,
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
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
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

  // "חדשים בלבד" — matters most on this tab: it sorts by name by default, so a
  // brand-new store lands anywhere in the list (or on another page entirely).
  const newToggle = document.getElementById('admin-stores-new-toggle') as HTMLButtonElement | null;
  newToggle?.addEventListener('click', () => {
    newOnly = !newOnly;
    navigate();
  });
}

// Stores tab: flat, top-level list of every store across all sellers (see
// AdminStoresPanel.astro's header comment). Block/unblock lives in this file's
// own per-row kebab menu (initStoreRowActions) with its own DOM-update logic —
// deliberately NOT sharing the Sellers tab's moderation wiring, since both
// panels' markup is always in the DOM (just hidden) and a shared selector would
// double-bind and fire the moderation request twice.
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

// Blocking/unblocking a store is destructive (hides it from the whole site +
// notifies the seller), so it always routes through the global confirm dialog
// (ConfirmModal.astro, `confirm:open`) rather than firing on a single click.
// The fetch runs inside onConfirm — the dialog keeps its busy dot-pulse until
// it resolves. Optimistic DOM update on success, same as before.
// `trigger` is the row's kebab button — it now carries the block state
// (data-blocked) the removed inline button used to hold, and its .admin-store-row
// ancestor still hosts the name badge to keep in sync.
async function runBlockToggle(trigger: HTMLElement): Promise<void> {
  const wasBlocked = trigger.dataset.blocked === '1';
  const action = wasBlocked ? 'unblock-store' : 'block-store';
  try {
    const res = await fetch('/api/admin/moderation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, storeSlug: trigger.dataset.storeSlug }),
    });
    if (!res.ok) throw new Error('request failed');
    const { blocked } = await res.json() as { blocked: boolean };
    trigger.dataset.blocked = blocked ? '1' : '';

    const nameEl = trigger.closest('.admin-store-row')?.querySelector('.admin-store-row__name');
    const existingBadge = nameEl?.querySelector('.admin-badge--failed');
    if (blocked && !existingBadge) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge admin-badge--failed';
      badge.textContent = 'חסום';
      nameEl?.appendChild(badge);
    } else if (!blocked && existingBadge) {
      existingBadge.remove();
    }
  } catch {
    showErrorToast('הפעולה נכשלה, נסו שוב');
  }
}

function openStoreBlockConfirm(trigger: HTMLElement): void {
  const wasBlocked = trigger.dataset.blocked === '1';
  const name = trigger.dataset.storeName ?? '';
  window.dispatchEvent(new CustomEvent('confirm:open', {
    detail: wasBlocked
      ? {
          title: 'לבטל את חסימת החנות?',
          message: `"${name}" תחזור להיות גלויה באתר.`,
          okLabel: 'בטל חסימה',
          workingLabel: 'מבטל…',
          onConfirm: () => runBlockToggle(trigger),
        }
      : {
          title: 'לחסום את החנות?',
          message: `"${name}" תוסתר מכל האתר והמוכר/ת יקבל/תקבל על כך התראה.`,
          okLabel: 'חסום חנות',
          workingLabel: 'חוסם…',
          onConfirm: () => runBlockToggle(trigger),
        },
  }));
}

// ── Silent "shop-window" promotion (CURRENT_TASK.md → סשן ב׳) ─────────────
// A store's admin-only curation weight (stores.ts#promoWeight): higher = it
// floats higher in the platform's own discovery surfaces (homepage + /stores).
// Cycled 0→1→2→0 by clicking the row's promote link. NOT confirm-gated (it's
// non-destructive, reversible, and costs nothing) and — unlike a block — never
// notifies the seller: it's the platform spending its own discovery budget, so
// there's nothing to disclose. Label kept in sync with AdminStoresPanel.astro.
const PROMO_LABELS = ['קדם חנות', 'קידום', 'קידום חזק'];
const MAX_PROMO = 2;
const promoLabel = (w: number): string => PROMO_LABELS[Math.max(0, Math.min(MAX_PROMO, w))] ?? PROMO_LABELS[0]!;

// `trigger` is the row's kebab button — it carries data-weight. Sets the promo
// weight to the level the admin picked directly (no cycling) and mirrors it in
// the name badge; the menu label refreshes from data-weight on its next open.
async function runPromoSet(trigger: HTMLElement, weight: number): Promise<void> {
  const clamped = Math.max(0, Math.min(MAX_PROMO, weight));
  if (clamped === (Number(trigger.dataset.weight) || 0)) return; // no-op on re-pick
  try {
    const res = await fetch('/api/admin/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeSlug: trigger.dataset.storeSlug, weight: clamped }),
    });
    if (!res.ok) throw new Error('request failed');
    const { weight: saved } = await res.json() as { weight: number };
    trigger.dataset.weight = String(saved);

    // Mirror the state in the name badge next to the store title.
    const nameEl = trigger.closest('.admin-store-row')?.querySelector('.admin-store-row__name');
    let badge = nameEl?.querySelector<HTMLElement>('[data-promo-badge]');
    if (saved > 0) {
      if (!badge && nameEl) {
        badge = document.createElement('span');
        badge.className = 'admin-badge admin-badge--promo';
        badge.dataset.promoBadge = '';
        nameEl.appendChild(badge);
      }
      if (badge) badge.textContent = promoLabel(saved);
    } else if (badge) {
      badge.remove();
    }
  } catch {
    showErrorToast('הפעולה נכשלה, נסו שוב');
  }
}

// Per-row kebab: opens the shared floating-portal menu holding every action that
// used to crowd the row inline. Each action keeps its old colour (accent links,
// red block). "רמת קידום" drills into a sub-menu to pick a level directly rather
// than cycling one step per click. Content is rebuilt from the trigger's own
// dataset each open, so a just-changed promo weight / block state shows right.
function storeActionsMenuHtml(t: HTMLElement): string {
  const slug = encodeURIComponent(t.dataset.storeSlug ?? '');
  const weight = Number(t.dataset.weight) || 0;
  const blocked = t.dataset.blocked === '1';
  const link = `${MENU_ITEM_BASE} [color:var(--color-accent)]`;
  return [
    `<a class="${link}" href="/admin/store/${slug}/performance">ביצועים</a>`,
    `<a class="${link}" href="/admin/store/${slug}/advertising">פרסום</a>`,
    `<a class="${link}" href="/${slug}" target="_blank" rel="noopener">צפה בחנות</a>`,
    `<div class="${MENU_DIVIDER}"></div>`,
    `<button type="button" class="${MENU_ITEM_BASE} [color:var(--color-accent)]" data-action="promote-menu"><span>רמת קידום${weight > 0 ? `: ${PROMO_LEVEL_LABELS[weight]}` : ''}</span>${CHEVRON_DRILL}</button>`,
    `<button type="button" class="${MENU_ITEM_BASE} [color:var(--color-danger)]" data-action="block">${blocked ? 'בטל חסימה' : 'חסום חנות'}</button>`,
  ].join('');
}

// Sub-menu: the three promo levels, current one marked, + a back row.
function storePromoLevelsHtml(t: HTMLElement): string {
  const weight = Number(t.dataset.weight) || 0;
  const back = `<button type="button" class="${MENU_ITEM}" data-promo-back>${CHEVRON_BACK}<span>רמת קידום</span></button><div class="${MENU_DIVIDER}"></div>`;
  const levels = PROMO_LEVEL_LABELS.map((lbl, w) =>
    `<button type="button" class="${MENU_ITEM_BASE} ${w === weight ? '[color:var(--color-accent)] font-bold' : '[color:var(--color-text)]'}" data-promo-level="${w}">${lbl}</button>`
  ).join('');
  return back + levels;
}

function openStoreActionsMenu(trigger: HTMLElement): void {
  storesActionsPortal.open(trigger, '13rem', () => storeActionsMenuHtml(trigger), (p) => {
    p.querySelector('[data-action="promote-menu"]')?.addEventListener('click', () => openStorePromoLevels(trigger));
    p.querySelector('[data-action="block"]')?.addEventListener('click', () => {
      storesActionsPortal.close();
      openStoreBlockConfirm(trigger);
    });
    // Links navigate on their own (full page loads, not same-tab /admin? links).
  });
}

function openStorePromoLevels(trigger: HTMLElement): void {
  storesActionsPortal.open(trigger, '13rem', () => storePromoLevelsHtml(trigger), (p) => {
    p.querySelector('[data-promo-back]')?.addEventListener('click', () => openStoreActionsMenu(trigger));
    p.querySelectorAll<HTMLButtonElement>('[data-promo-level]').forEach((btn) => {
      btn.addEventListener('click', () => {
        storesActionsPortal.close();
        void runPromoSet(trigger, Number(btn.dataset.promoLevel) || 0);
      });
    });
  });
}

function initStoreRowActions(): void {
  document.querySelectorAll<HTMLButtonElement>('.admin-store-row__kebab').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      if (storesActionsPortal.currentTrigger() === trigger) { storesActionsPortal.close(); return; }
      openStoreActionsMenu(trigger);
    });
  });
}

// ── Per-store product-block list (owner request 2026-07-19) ──────────────
// The Sellers tab already nests a product-block table three levels deep; this
// brings the same capability to the flat Stores tab, expanded by clicking the
// store's own product-count. It's server-searched + server-paginated (8/page)
// so a store with 1000 products never floods the panel or the wire — only one
// page's rows load at a time and search runs over the full catalog server-side
// (see /api/admin/store-products), never a DOM filter. Each product's block
// toggle routes through the same confirm dialog + /api/admin/moderation the
// store toggle uses.

interface AdminStoreProduct { id: string; name: string; price: number; blocked: boolean; image: string | null }
interface ProductPage { products: AdminStoreProduct[]; page: number; totalPages: number; total: number }

const PLACEHOLDER_THUMB =
  '<span class="admin-product-row__thumb admin-product-row__thumb--empty" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>';

function productRowHtml(p: AdminStoreProduct): string {
  const thumb = p.image
    ? `<img class="admin-product-row__thumb" src="${escapeHtml(cdnThumb(p.image, 72, 72))}" alt="" loading="lazy" decoding="async" width="36" height="36" />`
    : PLACEHOLDER_THUMB;
  return `
    <div class="admin-product-row">
      ${thumb}
      <span class="admin-product-row__name">${escapeHtml(p.name)}${p.blocked ? '<span class="admin-badge admin-badge--failed">חסום</span>' : ''}</span>
      <span class="admin-product-row__price">${p.price.toFixed(2)} ₪</span>
      <button type="button" class="btn btn--sm ${p.blocked ? '' : 'btn--ghost'} admin-store-product-toggle"
        data-product-id="${escapeHtml(p.id)}" data-product-name="${escapeHtml(p.name)}" data-blocked="${p.blocked ? '1' : ''}">
        ${p.blocked ? 'בטל חסימה' : 'חסום מוצר'}
      </button>
    </div>`;
}

function listHtml(products: AdminStoreProduct[]): string {
  if (products.length === 0) return '<p class="admin-empty">לא נמצאו מוצרים.</p>';
  return products.map(productRowHtml).join('');
}

function pagerHtml(page: number, totalPages: number): string {
  if (totalPages <= 1) return '';
  return `
    <button type="button" class="btn btn--ghost btn--sm" data-page-nav="prev" ${page <= 1 ? 'disabled' : ''} aria-label="עמוד קודם">‹ הקודם</button>
    <span class="admin-store-products__pageinfo">עמוד ${page} מתוך ${totalPages}</span>
    <button type="button" class="btn btn--ghost btn--sm" data-page-nav="next" ${page >= totalPages ? 'disabled' : ''} aria-label="עמוד הבא">הבא ›</button>`;
}

function shellHtml(): string {
  return `
    <div class="admin-store-products__bar">
      <input type="search" class="admin-store-products__search input" placeholder="חיפוש מוצר…" aria-label="חיפוש מוצר בחנות" />
    </div>
    <div class="admin-store-products__list"></div>
    <div class="admin-store-products__pager"></div>`;
}

// Optimistic DOM update on the product's own block button + name badge, same
// shape as runBlockToggle above but scoped to a product row.
async function runProductBlockToggle(btn: HTMLButtonElement): Promise<void> {
  const wasBlocked = btn.dataset.blocked === '1';
  const action = wasBlocked ? 'unblock-product' : 'block-product';
  try {
    const res = await fetch('/api/admin/moderation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, productId: btn.dataset.productId }),
    });
    if (!res.ok) throw new Error('request failed');
    const { blocked } = await res.json() as { blocked: boolean };
    btn.dataset.blocked = blocked ? '1' : '';
    btn.textContent = blocked ? 'בטל חסימה' : 'חסום מוצר';
    btn.classList.toggle('btn--ghost', !blocked);
    const nameEl = btn.closest('.admin-product-row')?.querySelector('.admin-product-row__name');
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
    showErrorToast('הפעולה נכשלה, נסו שוב');
  }
}

function openProductBlockConfirm(btn: HTMLButtonElement): void {
  const wasBlocked = btn.dataset.blocked === '1';
  const name = btn.dataset.productName ?? '';
  window.dispatchEvent(new CustomEvent('confirm:open', {
    detail: wasBlocked
      ? {
          title: 'לבטל את חסימת המוצר?',
          message: `"${name}" יחזור להיות גלוי באתר.`,
          okLabel: 'בטל חסימה',
          workingLabel: 'מבטל…',
          onConfirm: () => runProductBlockToggle(btn),
        }
      : {
          title: 'לחסום את המוצר?',
          message: `המוצר "${name}" יוסתר מכל האתר והמוכר/ת יקבל/תקבל על כך התראה.`,
          okLabel: 'חסום מוצר',
          workingLabel: 'חוסם…',
          onConfirm: () => runProductBlockToggle(btn),
        },
  }));
}

function initStoreProductLists(): void {
  document.querySelectorAll<HTMLButtonElement>('.admin-store-products-toggle').forEach((toggle) => {
    const panel = toggle.closest('.admin-store-row')?.querySelector<HTMLElement>('.admin-store-row__products');
    if (!panel) return;
    const slug = panel.dataset.storeSlug ?? '';

    // Per-store view state (search term + current page), kept in the closure so
    // each expanded store paginates/searches independently.
    let q = '';
    let page = 1;
    let totalPages = 1;
    let initialized = false;
    let listEl: HTMLElement | null = null;
    let pagerEl: HTMLElement | null = null;

    async function load(): Promise<void> {
      if (!listEl || !pagerEl) return;
      // Only show the "loading" placeholder on the very first fetch (empty
      // list). On page/search changes keep the current rows in place and just
      // dim them until the next page arrives — swapping to an empty placeholder
      // first collapsed the panel height and read as a flash/jump.
      const firstLoad = listEl.childElementCount === 0;
      if (firstLoad) listEl.innerHTML = '<p class="admin-empty">טוען מוצרים…</p>';
      listEl.style.opacity = '0.45';
      listEl.style.pointerEvents = 'none';
      try {
        const url = `/api/admin/store-products?storeSlug=${encodeURIComponent(slug)}&q=${encodeURIComponent(q)}&page=${page}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('request failed');
        const data = await res.json() as ProductPage;
        page = data.page;
        totalPages = data.totalPages;
        listEl.innerHTML = listHtml(data.products ?? []);
        pagerEl.innerHTML = pagerHtml(page, totalPages);
      } catch {
        listEl.innerHTML = '<p class="admin-empty">טעינת המוצרים נכשלה, נסו שוב.</p>';
        pagerEl.innerHTML = '';
      } finally {
        listEl.style.opacity = '';
        listEl.style.pointerEvents = '';
      }
    }

    // One delegated listener on the persistent panel handles block toggles and
    // pager arrows (the inner list/pager innerHTML is replaced on every load).
    panel.addEventListener('click', (e) => {
      const blockBtn = (e.target as Element).closest<HTMLButtonElement>('.admin-store-product-toggle');
      if (blockBtn) { openProductBlockConfirm(blockBtn); return; }
      const nav = (e.target as Element).closest<HTMLButtonElement>('[data-page-nav]');
      if (nav && !nav.disabled) {
        const next = nav.dataset.pageNav === 'next' ? page + 1 : page - 1;
        if (next >= 1 && next <= totalPages) { page = next; void load(); }
      }
    });

    toggle.addEventListener('click', () => {
      if (!panel.hidden) { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); return; }
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      if (initialized) return;
      initialized = true;
      panel.innerHTML = shellHtml();
      listEl = panel.querySelector('.admin-store-products__list');
      pagerEl = panel.querySelector('.admin-store-products__pager');
      const search = panel.querySelector<HTMLInputElement>('.admin-store-products__search');
      search?.addEventListener('input', debounce(() => { q = search.value.trim(); page = 1; void load(); }, 400));
      void load();
    });
  });
}

// The Sellers tab deep-links into this tab with a store name pre-filled in the
// search (?stq=<name>) so it lands on that one store. That prefilled search is
// meant to be ephemeral: the moment the admin switches to any other tab it
// should clear back to the full, unfiltered store list — otherwise the stale
// search term lingers on return. Wired once at document level (the tab
// controller in ui.ts fires a bubbling `dashtab:show` when a panel becomes
// active); only a switch *away* from the stores tab, while its search actually
// has a value, triggers a reset.
const STORE_URL_PARAMS = ['stq', 'stsort', 'stblocked', 'stpage'];

async function resetStoresPanel(): Promise<void> {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  // Drop this tab's own query params from the URL (the active tab param was
  // already set by the tab controller — leave it alone).
  const u = new URL(location.href);
  STORE_URL_PARAMS.forEach((k) => u.searchParams.delete(k));
  history.replaceState(null, '', u.toString());
  // Re-render the unfiltered list. A plain innerHTML swap (no history push,
  // unlike swapPanel) — the admin is already looking at another tab, so this
  // just readies the stores tab for their return.
  try {
    const res = await fetch('/admin?panel=stores');
    if (!res.ok) return;
    const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById(PANEL_ID);
    if (next) { panel.innerHTML = next.innerHTML; initAdminStoresPanel(); }
  } catch { /* leave the current (filtered) view as-is on failure */ }
}

function initStoresFilterAutoReset(): void {
  if (document.body.dataset.storesResetWired) return; // wire the document listener once
  document.body.dataset.storesResetWired = '1';
  document.addEventListener('dashtab:show', (e) => {
    if ((e.target as HTMLElement | null)?.id === PANEL_ID) return; // switching TO stores, not away
    const search = document.getElementById('admin-store-search') as HTMLInputElement | null;
    if (search && search.value.trim() !== '') void resetStoresPanel();
  });
}

export function initAdminStoresPanel(): void {
  initStoreSearch();
  initStoreRowActions();
  initStoreProductLists();
  wireStoresToolbar();
  initStoresFilterAutoReset();
  wirePanelLinks(PANEL_ID, () => initAdminStoresPanel());
  wirePopstateReload();
}
