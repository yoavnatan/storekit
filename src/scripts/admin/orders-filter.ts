// Admin orders tab: text search + sort + filter-by-status, mirroring the
// seller dashboard's own orders toolbar (see AI_INSTRUCTIONS.md → "Dashboard
// sort/filter toolbar") but read-only (no shipping-status/tracking edit — the
// admin dashboard is a reporting surface, editing an order stays the
// seller's job) and cross-store, so it also filters by payment status, which
// isn't meaningful on the single-store seller view. Search + sort + filter
// all narrow the same .order-card list; a card only shows once every active
// condition agrees.
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const SHIPPING_LABELS: Record<string, string> = {
  pending: 'חדשה', processing: 'בטיפול', ready: 'ממתין לאיסוף', shipped: 'נשלח', delivered: 'נמסר',
};
const SHIPPING_COLORS: Record<string, string> = {
  pending: '#ef4444', processing: '#3b82f6', ready: '#f59e0b', shipped: '#8b5cf6', delivered: '#16a34a',
};
const PAYMENT_LABELS: Record<string, string> = { pending: 'ממתין', paid: 'שולם', failed: 'נכשל' };
const PAYMENT_COLORS: Record<string, string> = { pending: '#f59e0b', paid: '#16a34a', failed: '#ef4444' };
const SHIPPING_RANK: Record<string, number> = { pending: 0, processing: 1, ready: 2, shipped: 3, delivered: 4 };

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

// shippingStatus/paymentStatus have a fixed enum; store is cross-store admin
// data with no fixed set — its `values`/`labels` get filled in at init time
// from whatever stores actually appear across the rendered orders (see
// buildFilterColumns below), same "no meaning to filter on" principle that
// already excluded phone number.
const STATIC_FILTER_COLUMNS: FilterColumnDef[] = [
  { col: 'shippingStatus', label: 'סטטוס משלוח', values: ['pending', 'processing', 'ready', 'shipped', 'delivered'], labels: SHIPPING_LABELS, colors: SHIPPING_COLORS },
  { col: 'paymentStatus', label: 'סטטוס תשלום', values: ['pending', 'paid', 'failed'], labels: PAYMENT_LABELS, colors: PAYMENT_COLORS },
];

export function initAdminOrdersFilter(): void {
  const listEl = document.getElementById('admin-orders-list');
  if (!listEl) return; // no orders at all — nothing to wire
  const list = listEl; // re-bound so TS keeps the non-null narrowing inside nested closures below

  const searchInput = document.getElementById('admin-order-search') as HTMLInputElement | null;
  const noMatchEl = document.getElementById('admin-orders-filter-empty');
  const cards = () => [...list.querySelectorAll<HTMLElement>('.order-card')];

  // Store filter's values aren't known until we see what's actually on the
  // page — collected once here from every card's data-stores (pipe-separated,
  // an order can span multiple stores).
  const storeNames = [...new Set(cards().flatMap((c) => (c.dataset.stores ?? '').split('|').filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'he'));
  const FILTER_COLUMNS: FilterColumnDef[] = [
    ...STATIC_FILTER_COLUMNS,
    { col: 'store', label: 'חנות', values: storeNames, labels: Object.fromEntries(storeNames.map((s) => [s, s])), colors: {} },
  ];

  let query = '';
  const activeFilters = new Map<FilterCol, Set<string>>();
  let sortCol: SortCol = 'date';
  let sortDir: 'asc' | 'desc' = 'desc';

  function cardMatchesFilters(card: HTMLElement): boolean {
    for (const [col, values] of activeFilters) {
      if (values.size === 0) continue;
      if (col === 'store') {
        const cardStores = (card.dataset.stores ?? '').split('|');
        if (!cardStores.some((s) => values.has(s))) return false;
        continue;
      }
      const v = col === 'shippingStatus' ? card.dataset.shippingStatus : card.dataset.paymentStatus;
      if (!values.has(v ?? '')) return false;
    }
    return true;
  }

  function applyVisibility(): void {
    let visible = 0;
    cards().forEach((card) => {
      const searchOk = !query || (card.dataset.search ?? '').includes(query);
      const show = searchOk && cardMatchesFilters(card);
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    if (noMatchEl) noMatchEl.hidden = visible > 0;
    const badge = document.getElementById('admin-orders-filter-count');
    if (badge) {
      const activeCols = [...activeFilters.values()].filter((s) => s.size > 0).length;
      badge.hidden = activeCols === 0;
      badge.textContent = String(activeCols);
    }
  }

  function sortCards(col: SortCol, dir: 'asc' | 'desc'): void {
    sortCol = col;
    sortDir = dir;
    const sorted = cards().sort((a, b) => {
      const va = col === 'amount' ? parseFloat(a.dataset.sortAmount ?? '0')
        : col === 'shippingStatus' ? (SHIPPING_RANK[a.dataset.shippingStatus ?? ''] ?? 99)
        : (a.dataset.sortDate ?? '');
      const vb = col === 'amount' ? parseFloat(b.dataset.sortAmount ?? '0')
        : col === 'shippingStatus' ? (SHIPPING_RANK[b.dataset.shippingStatus ?? ''] ?? 99)
        : (b.dataset.sortDate ?? '');
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    });
    sorted.forEach((card) => list.append(card));
    const label = document.getElementById('admin-orders-sort-label');
    const opt = SORT_OPTIONS.find((o) => o.col === col && o.dir === dir);
    if (label && opt) label.textContent = opt.label;
  }

  searchInput?.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    applyVisibility();
  });

  // ── Expand/collapse (mirrors the seller dashboard's own order-card) ──
  cards().forEach((card) => {
    const header = card.querySelector<HTMLElement>('.order-card__header');
    const body = card.querySelector<HTMLElement>('.order-card__body');
    if (!header || !body) return;
    const toggle = () => {
      const open = card.classList.toggle('order-card--open');
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
  const portal = createFloatingPortal('admin-orders-toolbar-portal');

  const sortTrigger = document.getElementById('admin-orders-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (portal.currentTrigger() === sortTrigger) { portal.close(); return; }
    portal.open(sortTrigger, '15rem', () => SORT_OPTIONS.map((o) => {
      const selected = o.col === sortCol && o.dir === sortDir;
      return `<button type="button" class="product-menu__item" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="cursor:pointer${selected ? ';font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortCards((btn.dataset.sortCol as SortCol) ?? 'date', (btn.dataset.sortDir as 'asc' | 'desc') ?? 'desc');
          portal.close();
        });
      });
    });
  });

  function openFilterColumns(trigger: HTMLElement): void {
    portal.open(trigger, '12rem', () => FILTER_COLUMNS.map((fc) => {
      const active = (activeFilters.get(fc.col)?.size ?? 0) > 0;
      return `<button type="button" class="product-menu__item" data-filter-col="${fc.col}" style="display:flex;justify-content:space-between;cursor:pointer${active ? ';font-weight:700;color:var(--color-primary)' : ''}">${fc.label}${active ? ' ●' : ''}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-filter-col]').forEach((btn) => {
        btn.addEventListener('click', () => openFilterValues(trigger, btn.dataset.filterCol as FilterCol));
      });
    });
  }

  function openFilterValues(trigger: HTMLElement, col: FilterCol): void {
    const fc = FILTER_COLUMNS.find((f) => f.col === col);
    if (!fc) return;
    const selected = activeFilters.get(col) ?? new Set<string>();
    portal.open(trigger, '13rem', () => [
      `<button type="button" class="product-menu__back" data-filter-back>‹ ${fc.label}</button>`,
      `<div class="product-menu__divider"></div>`,
      ...fc.values.map((v) => `
        <label class="product-menu__checkbox-item">
          <input type="checkbox" data-filter-value="${v}" ${selected.has(v) ? 'checked' : ''} />
          ${fc.colors[v] ? `<span class="order-status-dot" style="background:${fc.colors[v]}"></span>` : ''}
          ${fc.labels[v]}
        </label>`).join(''),
      `<div class="product-menu__divider"></div>`,
      `<button type="button" class="product-menu__clear" data-filter-clear>נקה סינון</button>`,
    ].join(''), (p) => {
      p.querySelector('[data-filter-back]')?.addEventListener('click', () => openFilterColumns(trigger));
      p.querySelectorAll<HTMLInputElement>('[data-filter-value]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const set = activeFilters.get(col) ?? new Set<string>();
          if (cb.checked) set.add(cb.dataset.filterValue!); else set.delete(cb.dataset.filterValue!);
          if (set.size) activeFilters.set(col, set); else activeFilters.delete(col);
          applyVisibility();
        });
      });
      p.querySelector('[data-filter-clear]')?.addEventListener('click', () => {
        activeFilters.delete(col);
        applyVisibility();
        openFilterValues(trigger, col);
      });
    });
  }

  const filterTrigger = document.getElementById('admin-orders-filter-trigger') as HTMLButtonElement | null;
  filterTrigger?.addEventListener('click', () => {
    if (portal.currentTrigger() === filterTrigger) { portal.close(); return; }
    openFilterColumns(filterTrigger);
  });
}
