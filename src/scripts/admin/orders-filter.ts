// Admin orders tab: text search + sort + filter-by-status. Pagination moved
// the actual filtering/sorting server-side (src/lib/admin-orders-filter.ts —
// only one page of orders is ever in the DOM now), so this file's job
// shrank to: read the server-rendered initial state, let the user change it
// via the same UI as before, and navigate to the updated query-param URL —
// the server does the rest on the next SSR render.
import { buildAdminUrl, debounce, encodeList, decodeList, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const PANEL_ID = 'dash-panel-orders';

// Module-level singleton, not created inside initAdminOrdersFilter() — that
// function now re-runs on every AJAX panel swap (see swapPanel in
// admin-nav.ts) to re-wire the fresh DOM, and createFloatingPortal() adds
// its own document-level click/keydown listeners on every call. Creating it
// once here (constant across re-inits) avoids piling up duplicate listeners
// each time the user types another search character.
const ordersPortal = createFloatingPortal('admin-orders-toolbar-portal');

const SHIPPING_LABELS: Record<string, string> = {
  pending: 'חדשה', processing: 'בטיפול', ready: 'ממתין לאיסוף', shipped: 'נשלח', delivered: 'נמסר',
};
const SHIPPING_COLORS: Record<string, string> = {
  pending: '#ef4444', processing: '#3b82f6', ready: '#f59e0b', shipped: '#8b5cf6', delivered: '#16a34a',
};
// The BUYER's charge, not the seller's payout — the two were both called "תשלום" and the owner
// could not tell which one a filter meant (2026-08-11). Every value is spelled from the buyer's
// side so the column cannot be read as the money going out to a seller.
const PAYMENT_LABELS: Record<string, string> = { pending: 'החיוב טרם הושלם', paid: 'הכסף התקבל', failed: 'החיוב נכשל' };
const PAYMENT_COLORS: Record<string, string> = { pending: '#f59e0b', paid: '#16a34a', failed: '#ef4444' };

type SortCol = 'date' | 'amount' | 'shippingStatus';
type FilterCol = 'shippingStatus' | 'paymentStatus' | 'store';
type FilterColumnDef = { col: FilterCol; label: string; values: string[]; labels: Record<string, string>; colors: Record<string, string> };

const SORT_OPTIONS: { col: SortCol; dir: 'asc' | 'desc'; label: string }[] = [
  { col: 'date', dir: 'desc', label: 'תאריך: חדש — ישן' },
  { col: 'date', dir: 'asc', label: 'תאריך: ישן — חדש' },
  { col: 'amount', dir: 'desc', label: 'סכום: גבוה — נמוך' },
  { col: 'amount', dir: 'asc', label: 'סכום: נמוך — גבוה' },
  { col: 'shippingStatus', dir: 'asc', label: 'סטטוס משלוח: הזמנות חדשות קודם' },
];

export function initAdminOrdersFilter(): void {
  const root = document.getElementById('admin-orders-toolbar');
  if (!root) return; // no orders at all — nothing to wire

  const state = root.dataset;
  let sortCol = (state.sortCol as SortCol) || 'date';
  let sortDir = (state.sortDir as 'asc' | 'desc') || 'desc';
  // Deliberately NOT part of activeFilters/the "סינון לפי" count — it isn't a
  // property of an order, it's "what arrived since I last left this tab".
  let newOnly = state.newOnly === '1';
  const storeNames: string[] = JSON.parse(state.storeNames ?? '[]');

  const FILTER_COLUMNS: FilterColumnDef[] = [
    // 'ready' (ממתין לאיסוף) is intentionally omitted — no seller can set it today;
    // it returns as a carrier-driven state once shipping is wired (GO_LIVE §5). Keeping
    // it out keeps the admin filter in sync with the states orders actually reach.
    { col: 'shippingStatus', label: 'סטטוס הזמנה', values: ['pending', 'processing', 'shipped', 'delivered'], labels: SHIPPING_LABELS, colors: SHIPPING_COLORS },
    { col: 'paymentStatus', label: 'חיוב הקונה', values: ['pending', 'paid', 'failed'], labels: PAYMENT_LABELS, colors: PAYMENT_COLORS },
    { col: 'store', label: 'חנות', values: storeNames, labels: Object.fromEntries(storeNames.map((s) => [s, s])), colors: {} },
  ];

  const activeFilters = new Map<FilterCol, Set<string>>();
  const ship0 = new Set((state.ship ?? '').split(',').filter(Boolean));
  const pay0 = new Set((state.pay ?? '').split(',').filter(Boolean));
  const store0 = new Set(decodeList(state.store ?? '')); // store names may contain commas — see admin-nav.ts
  if (ship0.size) activeFilters.set('shippingStatus', ship0);
  if (pay0.size) activeFilters.set('paymentStatus', pay0);
  if (store0.size) activeFilters.set('store', store0);

  const badge = document.getElementById('admin-orders-filter-count');
  if (badge) {
    const activeCols = [...activeFilters.values()].filter((s) => s.size > 0).length;
    badge.hidden = activeCols === 0;
    badge.textContent = String(activeCols);
  }

  function buildOrdersNavUrl(): string {
    const searchInput = document.getElementById('admin-order-search') as HTMLInputElement | null;
    const ship = activeFilters.get('shippingStatus');
    const pay = activeFilters.get('paymentStatus');
    const store = activeFilters.get('store');
    return buildAdminUrl('orders', {
      oq: searchInput?.value.trim() || undefined,
      osort: (sortCol !== 'date' || sortDir !== 'desc') ? `${sortCol}:${sortDir}` : undefined,
      oship: ship?.size ? [...ship].join(',') : undefined,
      opay: pay?.size ? [...pay].join(',') : undefined,
      ostore: store?.size ? encodeList([...store]) : undefined,
      onew: newOnly ? '1' : undefined,
    });
  }

  // The URL of what the panel is showing right now, captured before any
  // checkbox can stage a change into activeFilters. Apply/clear compare
  // against it and skip navigating when the result would be identical —
  // otherwise clearing a column that was never filtered re-fetches and
  // re-renders the panel into the exact same list, which reads as the list
  // flickering in response to a click that had nothing to do.
  const appliedUrl = buildOrdersNavUrl();

// AJAX-swaps the panel (see admin-nav.ts's swapPanel) instead of a full page
// nav — shared by sort selection and filter apply/clear (the search box's
// own debounce handler below calls swapPanel directly instead, so it can
// also refocus itself after the swap).
  function navigate(): void {
    swapPanel(buildOrdersNavUrl(), PANEL_ID, () => initAdminOrdersFilter());
  }

  const newToggle = document.getElementById('admin-orders-new-toggle') as HTMLButtonElement | null;
  newToggle?.addEventListener('click', () => {
    newOnly = !newOnly;
    navigate();
  });

  const searchInput = document.getElementById('admin-order-search') as HTMLInputElement | null;
  searchInput?.addEventListener('input', debounce(() => {
    swapPanel(buildOrdersNavUrl(), PANEL_ID, () => {
      initAdminOrdersFilter();
      const fresh = document.getElementById('admin-order-search') as HTMLInputElement | null;
      if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
    });
  }, 450));

  // ── Expand/collapse (mirrors the seller dashboard's own order-card) ──
  document.querySelectorAll<HTMLElement>('.order-card').forEach((card) => {
    const header = card.querySelector<HTMLElement>('.order-card__header');
    const body = card.querySelector<HTMLElement>('.order-card__body');
    if (!header || !body) return;
    const toggle = () => {
      const open = !card.hasAttribute('data-open');
      card.toggleAttribute('data-open', open);
      header.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // ── Sort + filter dropdowns (shared floating portal, same pattern as the
  // seller dashboard's own orders toolbar) ──
  const portal = ordersPortal;

  const sortTrigger = document.getElementById('admin-orders-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (portal.currentTrigger() === sortTrigger) { portal.close(); return; }
    portal.open(sortTrigger, '15rem', () => SORT_OPTIONS.map((o) => {
      const selected = o.col === sortCol && o.dir === sortDir;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortCol = (btn.dataset.sortCol as SortCol) ?? 'date';
          sortDir = (btn.dataset.sortDir as 'asc' | 'desc') ?? 'desc';
          navigate();
        });
      });
    });
  });

  function openFilterColumns(trigger: HTMLElement): void {
    portal.open(trigger, '12rem', () => FILTER_COLUMNS.map((fc) => {
      const active = (activeFilters.get(fc.col)?.size ?? 0) > 0;
      return `<button type="button" class="product-menu__item flex items-center justify-between gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-col="${fc.col}" style="${active ? 'font-weight:700;color:var(--color-primary)' : ''}">${fc.label}${active ? ' ●' : ''}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-filter-col]').forEach((btn) => {
        btn.addEventListener('click', () => openFilterValues(trigger, btn.dataset.filterCol as FilterCol));
      });
    });
  }

  // Checkbox changes only update in-memory state — the page only navigates
  // once the user hits "החל" (apply), so picking several values doesn't
  // reload the page after every single click.
  function openFilterValues(trigger: HTMLElement, col: FilterCol): void {
    const fc = FILTER_COLUMNS.find((f) => f.col === col);
    if (!fc) return;
    const selected = activeFilters.get(col) ?? new Set<string>();
    portal.open(trigger, '13rem', () => [
      `<button type="button" class="product-menu__back flex items-center gap-[.35rem] w-full text-start py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] font-semibold [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-back>‹ ${fc.label}</button>`,
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      ...fc.values.map((v) => `
        <label class="product-menu__checkbox-item flex items-center gap-[.4rem] py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer text-[.82rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]">
          <input type="checkbox" class="cursor-pointer shrink-0" data-filter-value="${v}" ${selected.has(v) ? 'checked' : ''} />
          ${fc.colors[v] ? `<span class="order-status-dot" style="background:${fc.colors[v]}"></span>` : ''}
          ${fc.labels[v]}
        </label>`).join(''),
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      `<div style="display:flex;gap:0.4rem;padding:0.3rem 0.6rem">
        <button type="button" class="btn btn--ghost btn--sm" data-filter-clear style="flex:1">נקה</button>
        <button type="button" class="btn btn--accent btn--sm" data-filter-apply style="flex:1">החל</button>
      </div>`,
    ].join(''), (p) => {
      p.querySelector('[data-filter-back]')?.addEventListener('click', () => openFilterColumns(trigger));
      p.querySelectorAll<HTMLInputElement>('[data-filter-value]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const set = activeFilters.get(col) ?? new Set<string>();
          if (cb.checked) set.add(cb.dataset.filterValue!); else set.delete(cb.dataset.filterValue!);
          if (set.size) activeFilters.set(col, set); else activeFilters.delete(col);
        });
      });
      p.querySelector('[data-filter-clear]')?.addEventListener('click', () => {
        activeFilters.delete(col);
        if (buildOrdersNavUrl() === appliedUrl) { portal.close(); return; }
        navigate();
      });
      p.querySelector('[data-filter-apply]')?.addEventListener('click', () => {
        if (buildOrdersNavUrl() === appliedUrl) { portal.close(); return; }
        navigate();
      });
    });
  }

  const filterTrigger = document.getElementById('admin-orders-filter-trigger') as HTMLButtonElement | null;
  filterTrigger?.addEventListener('click', () => {
    if (portal.currentTrigger() === filterTrigger) { portal.close(); return; }
    openFilterColumns(filterTrigger);
  });

  wirePanelLinks(PANEL_ID, () => initAdminOrdersFilter());
  wirePopstateReload();
}
