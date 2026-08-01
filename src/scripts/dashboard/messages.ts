import { encodeList, debounce } from '../../lib/admin-nav.js';
import { escapeHtml as escMsg } from '../../lib/html-escape.js';
import { toolbarMenuTitle, filterClearButtonHtml } from '../../lib/toolbar-portal.js';
import { lockTableColumns, unlockTableColumns } from '../../lib/table-column-lock.js';
import { SYSTEM_SENDER_LABEL } from '../../lib/seller-messages-query.js';
import { showErrorToast } from '../../lib/toast.js';
import { registerPanelRefresh } from './tab-sync.js';
import { scrollBelowPinnedChrome } from './scroll-utils.js';

// Messages tab: buyer<->seller threads and admin<->seller "system" threads in
// ONE table (both normalized to the same row shape server-side — see
// seller-messages-query.ts), header/mobile sort+filter through an own
// body-anchored portal, server-fetched pagination, and live unread polling.
// A row's data-msg-kind is the only difference: it picks the API a thread
// load / mark-read / reply talks to. `onAlertsChanged` = the dashboard's
// updateSwitcherAlertDot (shared with the orders tab), re-run on mark-read.
export function initMessagesTab(onAlertsChanged: () => void): void {
  // ── Seller messages: expand / mark read / reply ──────────────
  function fmtDateJs(iso: string) {
    return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  const currentSellerId = (document.getElementById('upload-config') as HTMLElement | null)?.dataset.sellerId ?? '';
  const currentStoreIdForMsgs = (document.getElementById('upload-config') as HTMLElement | null)?.dataset.storeId ?? '';
  const sellerThreadLoaders = new Map<string, (markRead: boolean, viaPoll?: boolean) => void>();

  // ── Messages: sort + filter — desktop uses header controls (.sort-btn on
  // date, a funnel button on status), mobile uses a "sort by"/"filter by"
  // toolbar dropdown (table-toolbar is display:none above 640px, see
  // dashboard.css). Both surfaces share the same state below, and every
  // dropdown (mobile or desktop funnel) renders through one body-anchored,
  // viewport-clamped portal — mirrors initProductsToolbar() in products.ts,
  // duplicated here rather than shared since this script and products.ts are
  // separate modules with their own row/DOM shape. ──
  const msgTbody = document.querySelector<HTMLTableSectionElement>('.msg-table tbody');
  const msgFilters = new Map<string, Set<string>>();
  // Sorting/filtering by read-status only makes sense when the store actually
  // has a mix of both — the header controls for it are server-omitted
  // entirely in that case (see showMsgStatusControls in the frontmatter); the
  // mobile dropdown's own options mirror that via this same flag, read off
  // the toolbar's data attribute rather than recomputed here.
  const msgMixedStatus = document.querySelector<HTMLElement>('#dash-panel-messages .table-toolbar')?.dataset.mixedStatus === 'true';
  const MSG_FILTER_COLUMNS: string[] = [...(msgMixedStatus ? ['status'] : []), 'product', 'from'];
  let msgSortCol: 'date' | 'unread' | 'product' = 'date';
  let msgSortDir: 'asc' | 'desc' = 'desc';
  let messagesCurrentPage = 1;
  let messagesSearchQuery = '';
  // Distinct filter-dropdown values (product/from) — read from an embedded
  // JSON blob computed server-side over the *full* message list, not scanned
  // off DOM rows, since only one page's worth of rows exist in the DOM at a
  // time once messages are paginated (same reasoning as allCategoryPaths()
  // in products.ts once the category filter hit the same problem).
  let msgFilterValuesData: { product: string[]; from: string[] } = { product: [], from: [] };
  try { msgFilterValuesData = JSON.parse(document.getElementById('msg-filter-values-data')?.textContent ?? '{}'); } catch { /* noop */ }
  let msgDashI18nDict: Record<string, string> = {};
  try { msgDashI18nDict = JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; } catch { /* noop */ }
  const msgI18n = {
    filterClearAll: msgDashI18nDict.filterClearAll ?? 'נקה הכל',
    filterClearColumn: msgDashI18nDict.filterClearColumn ?? 'נקה סינון בעמודה זו',
    filterColStatus: msgDashI18nDict.filterColStatus ?? 'סטטוס',
    filterColProduct: msgDashI18nDict.filterColProduct ?? 'מוצר',
    filterColFrom: msgDashI18nDict.filterColFrom ?? 'שולח',
    filterNoProduct: msgDashI18nDict.filterNoProduct ?? 'ללא מוצר',
    filterValUnread: msgDashI18nDict.filterValUnread ?? 'לא נקרא',
    filterValRead: msgDashI18nDict.filterValRead ?? 'נקרא',
    msgSortOptDateDesc: msgDashI18nDict.msgSortOptDateDesc ?? 'תאריך: חדש — ישן',
    msgSortOptDateAsc: msgDashI18nDict.msgSortOptDateAsc ?? 'תאריך: ישן — חדש',
    msgSortOptUnreadFirst: msgDashI18nDict.msgSortOptUnreadFirst ?? 'לא נקראו קודם',
    msgSortOptProductAsc: msgDashI18nDict.msgSortOptProductAsc ?? 'מוצר: א — ת',
    msgSortOptProductDesc: msgDashI18nDict.msgSortOptProductDesc ?? 'מוצר: ת — א',
  };

  const MSG_SORT_OPTIONS: { col: 'date' | 'unread' | 'product'; dir: 'asc' | 'desc'; label: () => string }[] = [
    { col: 'date', dir: 'desc', label: () => msgI18n.msgSortOptDateDesc },
    { col: 'date', dir: 'asc', label: () => msgI18n.msgSortOptDateAsc },
    ...(msgMixedStatus ? [{ col: 'unread' as const, dir: 'desc' as const, label: () => msgI18n.msgSortOptUnreadFirst }] : []),
    { col: 'product', dir: 'asc', label: () => msgI18n.msgSortOptProductAsc },
    { col: 'product', dir: 'desc', label: () => msgI18n.msgSortOptProductDesc },
  ];

  function getMsgFilterValue(row: HTMLElement, col: string): string {
    if (col === 'status') return row.classList.contains('msg-table__row--unread') ? msgI18n.filterValUnread : msgI18n.filterValRead;
    if (col === 'product') return row.dataset.filterProduct || msgI18n.filterNoProduct;
    if (col === 'from') return row.dataset.filterFrom || '';
    return '';
  }

  function rowMatchesMsgFilters(row: HTMLElement): boolean {
    for (const [col, values] of msgFilters) {
      if (values.size === 0) continue;
      if (!values.has(getMsgFilterValue(row, col))) return false;
    }
    return true;
  }

  // Filter changed — re-fetch page 1 of the current query from the server
  // (kept as the same function name/shape the toolbar's own filter handlers
  // already call, just server-driven now instead of a DOM show/hide pass).
  function applyMessagesFilter(): void {
    // Pin the column widths while the pre-change rows are still on screen, so
    // the re-render can't resize them and slide the header out from under an
    // open funnel dropdown. Opening/closing a menu on its own does nothing.
    // See lib/table-column-lock.ts.
    if (msgFilters.size) lockTableColumns(document.querySelector<HTMLTableElement>('.msg-table'));
    messagesCurrentPage = 1;
    applyMessagesPagination();
  }

  function refreshMsgFilterUI(): void {
    document.querySelectorAll<HTMLButtonElement>('.msg-table thead [data-filter-funnel-col]').forEach((btn) => {
      const col = btn.dataset.filterFunnelCol ?? '';
      if ((msgFilters.get(col)?.size ?? 0) > 0) btn.dataset.active = 'true'; else delete btn.dataset.active;
    });
    const badge = document.getElementById('msg-filter-count');
    if (badge) {
      const activeCols = [...msgFilters.values()].filter((s) => s.size > 0).length;
      badge.hidden = activeCols === 0;
      badge.textContent = String(activeCols);
    }
    if (!msgFilters.size) unlockTableColumns(document.querySelector<HTMLTableElement>('.msg-table'));
  }

  function refreshMsgSortUI(): void {
    document.querySelectorAll<HTMLButtonElement>('.msg-table thead .sort-btn').forEach((btn) => {
      if (btn.dataset.sortCol === msgSortCol) { btn.dataset.active = 'true'; btn.dataset.dir = msgSortDir; }
      else { delete btn.dataset.active; delete btn.dataset.dir; }
    });
    const label = document.getElementById('msg-sort-label');
    if (label) {
      const opt = MSG_SORT_OPTIONS.find((o) => o.col === msgSortCol && o.dir === msgSortDir) ?? MSG_SORT_OPTIONS[0]!;
      label.textContent = opt.label();
    }
  }

  function sortMessages(col: 'date' | 'unread' | 'product', dir: 'asc' | 'desc') {
    msgSortCol = col;
    msgSortDir = dir;
    messagesCurrentPage = 1;
    applyMessagesPagination();
    refreshMsgSortUI();
  }

  function msgHeaderSortClick(col: 'date' | 'unread' | 'product'): void {
    const defaultDir: 'asc' | 'desc' = col === 'product' ? 'asc' : 'desc';
    const dir: 'asc' | 'desc' = msgSortCol === col ? (msgSortDir === 'asc' ? 'desc' : 'asc') : defaultDir;
    sortMessages(col, dir);
  }

  // ── Shared floating portal (own copy — see the comment above) ──
  let msgPortalTrigger: HTMLElement | null = null;

  function getMsgPortal(): HTMLElement {
    let portal = document.getElementById('msg-toolbar-portal');
    if (!portal) {
      portal = document.createElement('div');
      portal.id = 'msg-toolbar-portal';
      portal.className = 'toolbar-portal fixed bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-[var(--radius)] shadow-[0_4px_20px_rgba(0,0,0,0.13)] p-[.3rem] z-[300] animate-product-menu-open';
      portal.setAttribute('role', 'menu');
      portal.hidden = true;
      document.body.appendChild(portal);
    }
    return portal;
  }
  function positionMsgPortal(portal: HTMLElement, trigger: HTMLElement): void {
    const isRTL = getComputedStyle(document.documentElement).direction === 'rtl';
    const margin = 8;
    const triggerRect = trigger.getBoundingClientRect();
    const portalRect = portal.getBoundingClientRect();
    let left = isRTL ? triggerRect.right - portalRect.width : triggerRect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - portalRect.width - margin));
    let top = triggerRect.bottom + 4;
    top = Math.min(top, Math.max(margin, window.innerHeight - portalRect.height - margin));
    portal.style.left = `${left}px`;
    portal.style.top = `${top}px`;
  }
  function closeMsgPortal(): void {
    const portal = document.getElementById('msg-toolbar-portal');
    if (portal) portal.hidden = true;
    msgPortalTrigger?.setAttribute('aria-expanded', 'false');
    msgPortalTrigger = null;
  }
  function openMsgPortal(trigger: HTMLElement, minWidth: string, buildHtml: () => string, wire: (portal: HTMLElement) => void): void {
    const portal = getMsgPortal();
    msgPortalTrigger = trigger;
    portal.style.minWidth = minWidth;
    portal.style.maxHeight = '320px';
    portal.style.overflow = 'auto';
    portal.innerHTML = buildHtml();
    portal.hidden = false;
    positionMsgPortal(portal, trigger);
    trigger.setAttribute('aria-expanded', 'true');
    wire(portal);
  }
  document.addEventListener('click', (e) => {
    const portal = document.getElementById('msg-toolbar-portal');
    if (!portal || portal.hidden) return;
    // composedPath(), not target.contains() — a portal click that swaps
    // portal.innerHTML (e.g. drilling into a filter column) detaches the
    // original e.target from the document mid-bubble, so a containment check
    // done here (after that swap already ran) wrongly reads as "outside" and
    // closes the portal the instant it opens its next level.
    const path = e.composedPath();
    if (path.includes(portal)) return;
    if (msgPortalTrigger && path.includes(msgPortalTrigger)) return;
    closeMsgPortal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMsgPortal(); });

  // ── Sort ──
  function openMobileMsgSort(trigger: HTMLElement): void {
    openMsgPortal(trigger, '13rem', () => {
      return toolbarMenuTitle(msgDashI18nDict.sortByLabel ?? 'מיין לפי') + MSG_SORT_OPTIONS.map((o) => {
        const selected = o.col === msgSortCol && o.dir === msgSortDir;
        return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${escMsg(o.label())}</button>`;
      }).join('');
    }, (portal) => {
      portal.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortMessages((btn.dataset.sortCol as 'date' | 'unread' | 'product') ?? 'date', (btn.dataset.sortDir as 'asc' | 'desc') ?? 'desc');
          closeMsgPortal();
        });
      });
    });
  }

  document.querySelectorAll<HTMLButtonElement>('.msg-table thead .sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => msgHeaderSortClick((btn.dataset.sortCol as 'date' | 'unread' | 'product') ?? 'date'));
  });

  const msgSortTrigger = document.getElementById('msg-sort-trigger') as HTMLButtonElement | null;
  msgSortTrigger?.addEventListener('click', () => {
    if (msgPortalTrigger === msgSortTrigger) { closeMsgPortal(); return; }
    openMobileMsgSort(msgSortTrigger);
  });

  // ── Filter ──
  function msgFilterColumnLabel(col: string): string {
    if (col === 'status') return msgI18n.filterColStatus;
    if (col === 'product') return msgI18n.filterColProduct;
    if (col === 'from') return msgI18n.filterColFrom;
    return col;
  }
  function getMsgDistinctValues(col: string): string[] {
    if (col === 'status') return [msgI18n.filterValUnread, msgI18n.filterValRead];
    if (col === 'product') return msgFilterValuesData.product.map((v) => v || msgI18n.filterNoProduct);
    if (col === 'from') return msgFilterValuesData.from;
    return [];
  }
  function msgFilterValuesHtml(col: string, showBack: boolean): string {
    const label = msgFilterColumnLabel(col);
    const values = getMsgDistinctValues(col);
    const selected = msgFilters.get(col) ?? new Set<string>();
    const backRotate = document.documentElement.dir === 'rtl' ? -90 : 90;
    const backHtml = showBack
      ? `<button type="button" class="product-menu__back flex items-center gap-[.35rem] w-full text-start py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] font-semibold [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-back><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0;transform:rotate(${backRotate}deg)"><polyline points="6 9 12 15 18 9"/></svg>${escMsg(label)}</button><div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`
      : '';
    return [
      backHtml,
      ...values.map((v) => `<label class="product-menu__checkbox-item flex items-center gap-[.4rem] py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer text-[.82rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]"><input type="checkbox" class="cursor-pointer shrink-0" data-filter-value="${escMsg(v)}" ${selected.has(v) ? 'checked' : ''}>${escMsg(v)}</label>`),
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      filterClearButtonHtml('data-filter-clear-col', msgI18n.filterClearColumn, selected.size > 0),
    ].join('');
  }
  function wireMsgFilterValues(portal: HTMLElement, col: string, reopen: () => void, onBack?: () => void): void {
    portal.querySelectorAll<HTMLInputElement>('[data-filter-value]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const set = msgFilters.get(col) ?? new Set<string>();
        if (cb.checked) set.add(cb.dataset.filterValue ?? ''); else set.delete(cb.dataset.filterValue ?? '');
        if (set.size) msgFilters.set(col, set); else msgFilters.delete(col);
        applyMessagesFilter();
        refreshMsgFilterUI();
      });
    });
    portal.querySelector('[data-filter-clear-col]')?.addEventListener('click', () => {
      if (!msgFilters.has(col)) return;
      msgFilters.delete(col);
      applyMessagesFilter();
      refreshMsgFilterUI();
      reopen();
    });
    if (onBack) portal.querySelector('[data-filter-back]')?.addEventListener('click', onBack);
  }

  function openDesktopMsgFunnel(btn: HTMLButtonElement, col: string): void {
    openMsgPortal(btn, '10rem', () => msgFilterValuesHtml(col, false), (portal) => {
      wireMsgFilterValues(portal, col, () => openDesktopMsgFunnel(btn, col));
    });
  }

  // The checkbox here is real (not decorative) — unchecking it clears that
  // column's filter directly, without a drill-down into its values first.
  // Clicking it while off has nothing to filter by yet, so it opens the
  // values view instead of actually checking itself. A plain <div> row (not
  // <label>) on purpose: a <label> wrapping a checkbox forwards any click on
  // the row into a second, native toggle of the checkbox, double-handling
  // the same click.
  function msgFilterColumnsHtml(): string {
    const chevronRotate = document.documentElement.dir === 'rtl' ? 90 : -90;
    return [
      toolbarMenuTitle(msgDashI18nDict.filterByLabel ?? 'סנן לפי'),
      ...MSG_FILTER_COLUMNS.map((col) => {
        const active = (msgFilters.get(col)?.size ?? 0) > 0;
        return `<div class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-col="${col}">
          <input type="checkbox" class="cursor-pointer shrink-0" data-filter-col-toggle="${col}" ${active ? 'checked' : ''}>
          <span style="flex:1">${escMsg(msgFilterColumnLabel(col))}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0;transform:rotate(${chevronRotate}deg)"><polyline points="6 9 12 15 18 9"/></svg>
        </div>`;
      }).join(''),
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      filterClearButtonHtml('data-filter-clear-all', msgI18n.filterClearAll, msgFilters.size > 0),
    ].join('');
  }

  function openMobileMsgFilterColumns(trigger: HTMLElement): void {
    openMsgPortal(trigger, '11rem', msgFilterColumnsHtml, (portal) => {
      portal.querySelectorAll<HTMLElement>('[data-filter-col]').forEach((row) => {
        const col = row.dataset.filterCol ?? '';
        row.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-filter-col-toggle]')) return;
          openMobileMsgFilterValues(trigger, col);
        });
        const cb = row.querySelector<HTMLInputElement>('[data-filter-col-toggle]');
        cb?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (cb.checked) {
            cb.checked = false;
            openMobileMsgFilterValues(trigger, col);
            return;
          }
          msgFilters.delete(col);
          applyMessagesFilter();
          refreshMsgFilterUI();
          openMobileMsgFilterColumns(trigger);
        });
      });
      portal.querySelector('[data-filter-clear-all]')?.addEventListener('click', () => {
        if (!msgFilters.size) return;
        msgFilters.clear();
        applyMessagesFilter();
        refreshMsgFilterUI();
        openMobileMsgFilterColumns(trigger);
      });
    });
  }
  function openMobileMsgFilterValues(trigger: HTMLElement, col: string): void {
    openMsgPortal(trigger, '11rem', () => msgFilterValuesHtml(col, true), (portal) => {
      wireMsgFilterValues(portal, col, () => openMobileMsgFilterValues(trigger, col), () => openMobileMsgFilterColumns(trigger));
    });
  }

  document.querySelectorAll<HTMLButtonElement>('.msg-table thead [data-filter-funnel-col]').forEach((btn) => {
    const col = btn.dataset.filterFunnelCol ?? '';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (msgPortalTrigger === btn) { closeMsgPortal(); return; }
      openDesktopMsgFunnel(btn, col);
    });
  });

  const msgFilterTrigger = document.getElementById('msg-filter-trigger') as HTMLButtonElement | null;
  msgFilterTrigger?.addEventListener('click', () => {
    if (msgPortalTrigger === msgFilterTrigger) { closeMsgPortal(); return; }
    openMobileMsgFilterColumns(msgFilterTrigger);
  });

  refreshMsgSortUI();
  refreshMsgFilterUI();

  // Builds the two <tr> a thread occupies (main row + collapsible thread row)
  // from an AJAX-fetched item — mirrors SellerMessageRow.astro exactly, for
  // both kinds of thread. Expanding a row still re-fetches it fresh via
  // loadThread() (see bindMessageRow below); the entries embedded here are
  // what shows in the instant between the click and that response.
  interface ThreadEntryData { who: string; fromSelf: boolean; content: string; createdAt: string; unread: boolean }
  interface MessageRowData {
    kind: 'buyer' | 'system';
    id: string;
    fromName: string;
    subject: string;
    entries: ThreadEntryData[];
    lastContent: string;
    lastCreatedAt: string;
    lastFromSelf: boolean;
    hasUnread: boolean;
    productName: string;
    productHref: string;
  }
  function entryBubbleHtml(entry: ThreadEntryData): string {
    return `<div class="msg-thread-entry ${entry.fromSelf ? 'msg-thread-entry--seller' : 'msg-thread-entry--buyer'}">
      <div class="msg-thread-entry__header">
        <span class="msg-thread-entry__who">${escMsg(entry.who)}</span>
        ${entry.unread ? '<span class="msg-thread-unread-dot" aria-label="לא נקרא"></span>' : ''}
        <span class="msg-thread-entry__date">${escMsg(fmtDateJs(entry.createdAt))}</span>
      </div>
      <div class="msg-thread-entry__body">${escMsg(entry.content)}</div>
    </div>`;
  }
  function buildMessageRow(data: MessageRowData): [HTMLTableRowElement, HTMLTableRowElement] {
    const row = document.createElement('tr');
    row.className = `msg-table__row${data.hasUnread ? ' msg-table__row--unread' : ''}`;
    row.dataset.msgId = data.id;
    row.dataset.msgKind = data.kind;
    row.dataset.sortDate = data.lastCreatedAt;
    row.dataset.sortProduct = data.productName.toLowerCase();
    row.dataset.filterProduct = data.productName;
    row.dataset.filterFrom = data.fromName;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', 'false');
    const productTd = data.productHref
      ? `<a href="${escMsg(data.productHref)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${escMsg(data.productName)}</a>`
      : `<span style="color:var(--color-muted)">—</span>`;
    // A system thread is the platform's own record — the seller reads and
    // replies to it, but can't delete it (a buyer thread they can).
    const deleteBtn = data.kind === 'buyer'
      ? `<button class="seller-msg-delete" data-delete-msg-id="${escMsg(data.id)}" type="button" aria-label="מחק שיחה" title="מחק שיחה">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>`
      : '';
    row.innerHTML = `
      <td class="msg-table__td msg-table__td--status"></td>
      <td class="msg-table__td msg-table__td--from">${data.hasUnread ? '<span class="visually-hidden msg-unread-sr">לא נקרא · </span>' : ''}${escMsg(data.fromName)}</td>
      <td class="msg-table__td msg-table__td--subject">${escMsg(data.subject)}</td>
      <td class="msg-table__td msg-table__td--preview">${escMsg(data.lastContent)}${data.lastFromSelf ? '<span class="msg-table__preview-you"> (אתה)</span>' : ''}</td>
      <td class="msg-table__td msg-table__td--product">${productTd}</td>
      <td class="msg-table__td msg-table__td--date">${escMsg(fmtDateJs(data.lastCreatedAt))}</td>
      <td class="msg-table__td msg-table__td--actions">${deleteBtn}</td>`;

    const threadRow = document.createElement('tr');
    threadRow.className = 'msg-thread-row';
    threadRow.id = `msg-detail-${data.id}`;
    threadRow.hidden = true;
    threadRow.innerHTML = `
      <td colspan="7">
        <div class="msg-thread msg-thread--seller-pov" id="replies-${data.id}">${data.entries.map(entryBubbleHtml).join('')}</div>
        <div class="seller-msg-reply-form" data-reply-for="${escMsg(data.id)}" style="padding:0.75rem 1rem;border-top:1px solid var(--color-border)">
          <textarea class="seller-msg-reply-textarea" placeholder="כתוב תשובה..." rows="3"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button class="seller-msg-reply-close" type="button">סגור שיחה</button>
            <button class="seller-msg-reply-send" type="button">שלח</button>
          </div>
        </div>
      </td>`;

    return [row, threadRow];
  }

  // Extracted to a named function (was an inline forEach body) so a freshly
  // AJAX-fetched message row (applyMessagesPagination below) can be bound
  // the same way an initial SSR row is, instead of duplicating this logic.
  function bindMessageRow(row: HTMLElement): void {
    const id        = row.dataset.msgId ?? '';
    const isSystem  = row.dataset.msgKind === 'system';
    const threadRow = document.getElementById(`msg-detail-${id}`) as HTMLTableRowElement | null;
    const repliesEl = document.getElementById(`replies-${id}`);
    let isOpen = false;

    // Shared tail of both loaders: the row's preview/date/sort key always
    // track the thread's newest message, whichever API it came from.
    function applyLastMessage(content: string, createdAt: string, fromSelf: boolean): void {
      const previewTd = row.querySelector('.msg-table__td--preview');
      if (previewTd) previewTd.innerHTML = `${escMsg(content)}${fromSelf ? ' <span class="msg-table__preview-you">(אתה)</span>' : ''}`;
      const dateTd = row.querySelector('.msg-table__td--date');
      if (dateTd) dateTd.textContent = fmtDateJs(createdAt);
      row.dataset.sortDate = createdAt;
    }

    function markRowRead(markReadUrl: string, body: Record<string, string>): void {
      row.classList.remove('msg-table__row--unread');
      row.querySelector('.msg-unread-sr')?.remove();
      repliesEl?.querySelectorAll('.msg-thread-unread-dot').forEach((el) => el.remove());
      // The tab dot reflects ALL threads — only drop it once no other row is
      // still unread (with the system thread now being many rows instead of
      // one pinned row, an unconditional remove was wrong).
      if (!document.querySelector('.msg-table__row--unread')) document.querySelector('#tab-messages span[aria-label]')?.remove();
      onAlertsChanged();
      if (!rowMatchesMsgFilters(row)) row.hidden = true;
      fetch(markReadUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(() => window.dispatchEvent(new CustomEvent('notif-refreshed'))).catch(() => {});
    }

    function focusReplyBox(): void {
      threadRow?.querySelector<HTMLElement>('[data-reply-for]')?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      threadRow?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    }

    // A system thread reads/writes /api/admin-messages instead of
    // /api/messages, and its messages carry { fromRole } rather than
    // { fromUserId, fromName } — its GET returns the WHOLE thread (root
    // included), so it replaces every bubble rather than all-but-the-first.
    function loadThreadSystem(markRead: boolean) {
      fetch(`/api/admin-messages?threadId=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then(({ messages }: { messages?: { fromRole: 'admin' | 'seller'; content: string; createdAt: string; readBySeller: boolean }[] }) => {
          if (!repliesEl || !messages) return;
          repliesEl.innerHTML = messages.map((m) => {
            const fromSelf = m.fromRole === 'seller';
            return entryBubbleHtml({ who: fromSelf ? 'אתה' : SYSTEM_SENDER_LABEL, fromSelf, content: m.content, createdAt: m.createdAt, unread: !fromSelf && !m.readBySeller });
          }).join('');
          const last = messages[messages.length - 1];
          if (last) applyLastMessage(last.content, last.createdAt, last.fromRole === 'seller');
          if (markRead) markRowRead('/api/admin-messages', { action: 'mark-read', threadId: id });
          focusReplyBox();
        }).catch(() => {});
    }

    // viaPoll = the live poll found new replies while this thread was already
    // open (the user isn't in the middle of opening it themselves) — that's
    // the one case that needs its own toast, keyed by the *reply's own* id so
    // it matches (and dedupes against) the site-wide notification poller.
    function loadThread(markRead: boolean, viaPoll = false) {
      if (isSystem) { loadThreadSystem(markRead); return; }
      fetch(`/api/messages?repliesFor=${id}`)
        .then((r) => r.json())
        .then(({ replies }: { replies: { id: string; fromUserId: string; fromName: string; content: string; createdAt: string; toSellerId?: string; readBySeller?: boolean }[] }) => {
          if (!repliesEl) return;
          [...repliesEl.children].slice(1).forEach((c) => c.remove());
          replies.forEach((r) => {
            const isSelf = r.fromUserId === currentSellerId;
            const div = document.createElement('div');
            div.className = `msg-thread-entry ${isSelf ? 'msg-thread-entry--seller' : 'msg-thread-entry--buyer'}`;
            div.innerHTML = `<div class="msg-thread-entry__header"><span class="msg-thread-entry__who">${escMsg(isSelf ? 'אתה' : r.fromName)}</span><span class="msg-thread-entry__date">${escMsg(fmtDateJs(r.createdAt))}</span></div><div class="msg-thread-entry__body">${escMsg(r.content)}</div>`;
            repliesEl.appendChild(div);
          });
          if (replies.length > 0) {
            const last = replies[replies.length - 1]!;
            const isSelf = last.fromUserId === currentSellerId;
            applyLastMessage(last.content, last.createdAt, isSelf);
            if (viaPoll && markRead && !isSelf) {
              window.dispatchEvent(new CustomEvent('toast:show', { detail: {
                title: 'יש לך הודעה חדשה מקונה', body: last.fromName, key: last.id,
                href: '/seller/dashboard?panel=messages',
              } }));
            }
          }
          if (markRead) markRowRead('/api/messages', { action: 'mark-read', id });
          focusReplyBox();
        }).catch(() => {});
    }

    sellerThreadLoaders.set(id, loadThread);

    function open() {
      if (!threadRow) return;
      threadRow.hidden = false;
      row.setAttribute('aria-expanded', 'true');
      row.classList.add('msg-table__row--open');
      isOpen = true;
      loadThread(row.classList.contains('msg-table__row--unread'));
    }
    function close() {
      if (!threadRow) return;
      threadRow.hidden = true;
      row.setAttribute('aria-expanded', 'false');
      row.classList.remove('msg-table__row--open');
      isOpen = false;
    }

    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, a')) return;
      isOpen ? close() : open();
    });
    row.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen ? close() : open(); }
    });

    const replyForm = threadRow?.querySelector<HTMLElement>('[data-reply-for]');
    if (replyForm) {
      const textarea = replyForm.querySelector<HTMLTextAreaElement>('textarea')!;
      const sendBtn  = replyForm.querySelector<HTMLButtonElement>('.seller-msg-reply-send')!;
      const closeBtn = replyForm.querySelector<HTMLButtonElement>('.seller-msg-reply-close')!;
      closeBtn.addEventListener('click', () => {
        close();
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      sendBtn.addEventListener('click', async () => {
        const content = textarea.value.trim();
        if (!content) return;
        sendBtn.disabled = true;
        try {
          const res = await fetch(isSystem ? '/api/admin-messages' : '/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isSystem ? { threadId: id, content } : { replyToId: id, content }),
          });
          const data = await res.json() as { ok?: boolean; message?: { content: string; createdAt: string } };
          if (res.ok && data.ok && data.message && repliesEl) {
            repliesEl.insertAdjacentHTML('beforeend', entryBubbleHtml({
              who: 'אתה', fromSelf: true, content: data.message.content, createdAt: data.message.createdAt, unread: false,
            }));
            applyLastMessage(data.message.content, data.message.createdAt, true);
            textarea.value = '';
          }
        } catch { /* ignore */ } finally {
          sendBtn.disabled = false;
        }
      });
    }
  }

  document.querySelectorAll<HTMLElement>('[data-msg-id]').forEach(bindMessageRow);

  // ── Messages: server-fetched page/search/sort/filter (AJAX) ──────────
  // Same reasoning as Products/Orders' own applyPagination() — search/sort/
  // filter now run server-side (seller-messages-query.ts), so a change
  // re-fetches the current query's page and rebuilds every row from it
  // (buyer and system threads alike — one list, one owner).
  async function applyMessagesPagination(): Promise<void> {
    const storeId = (document.getElementById('upload-config') as HTMLElement | null)?.dataset.storeId ?? '';
    if (!msgTbody || !storeId) return;

    const params = new URLSearchParams();
    params.set('storeId', storeId);
    params.set('page', String(messagesCurrentPage));
    if (messagesSearchQuery) params.set('mq', messagesSearchQuery);
    params.set('msort', `${msgSortCol}:${msgSortDir}`);
    const statusValues = msgFilters.get('status');
    if (statusValues?.size) {
      params.set('mstatus', encodeList([...statusValues].map((v) => (v === msgI18n.filterValUnread ? 'unread' : 'read'))));
    }
    const productValues = msgFilters.get('product');
    if (productValues?.size) {
      params.set('mproduct', encodeList([...productValues].map((v) => (v === msgI18n.filterNoProduct ? '' : v))));
    }
    const fromValues = msgFilters.get('from');
    if (fromValues?.size) params.set('mfrom', encodeList([...fromValues]));

    let data: { ok: boolean; items?: MessageRowData[]; page?: number; totalPages?: number; total?: number };
    try {
      const res = await fetch(`/api/seller/messages?${params.toString()}`);
      data = await res.json() as typeof data;
    } catch { return; }
    if (!data.ok) return;

    messagesCurrentPage = data.page ?? 1;

    msgTbody.replaceChildren();
    (data.items ?? []).forEach((item) => {
      const [row, threadRow] = buildMessageRow(item);
      msgTbody!.append(row, threadRow);
      bindMessageRow(row);
    });

    const total = data.total ?? 0;
    const emptyEl = document.getElementById('msg-filter-empty');
    if (emptyEl) emptyEl.hidden = total !== 0;
    refreshMsgFilterUI();
    renderMessagesPaginationControls(data.totalPages ?? 1);
  }

  function renderMessagesPaginationControls(totalPages: number): void {
    const nav = document.getElementById('msg-pagination') as HTMLElement | null;
    if (!nav) return;
    if (totalPages <= 1) { nav.hidden = true; nav.innerHTML = ''; return; }
    const pageInfo = (msgDashI18nDict.paginationPageInfo ?? 'עמוד {page} מתוך {total}')
      .replace('{page}', String(messagesCurrentPage)).replace('{total}', String(totalPages));
    nav.hidden = false;
    nav.innerHTML = `
      <button type="button" class="btn btn--ghost btn--sm disabled:opacity-40 disabled:cursor-default" data-page-prev${messagesCurrentPage <= 1 ? ' disabled' : ''}>${escMsg(msgDashI18nDict.paginationPrev ?? 'הקודם')}</button>
      <span class="text-[0.82rem] whitespace-nowrap [color:var(--color-muted)]">${escMsg(pageInfo)}</span>
      <button type="button" class="btn btn--ghost btn--sm disabled:opacity-40 disabled:cursor-default" data-page-next${messagesCurrentPage >= totalPages ? ' disabled' : ''}>${escMsg(msgDashI18nDict.paginationNext ?? 'הבא')}</button>
    `;
  }

  function initMessagesPagination(): void {
    const nav = document.getElementById('msg-pagination') as HTMLElement | null;
    if (!nav) return;
    messagesCurrentPage = parseInt(nav.dataset.page ?? '1', 10) || 1;
    renderMessagesPaginationControls(parseInt(nav.dataset.totalPages ?? '1', 10) || 1);
    nav.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('[data-page-prev], [data-page-next]');
      if (!btn || btn.disabled) return;
      messagesCurrentPage += btn.hasAttribute('data-page-prev') ? -1 : 1;
      applyMessagesPagination();
      const wrap = document.querySelector<HTMLElement>('.msg-table-wrap');
      if (wrap) scrollBelowPinnedChrome(wrap);
    });
  }
  initMessagesPagination();
  // Cross-tab live refresh (tab-sync.ts) — same re-fetch the toolbar uses, so a refresh
  // triggered by another tab keeps this one's page, search, sort and filters.
  registerPanelRefresh('dash-panel-messages', applyMessagesPagination);

  const msgSearchInput = document.getElementById('msg-search-input') as HTMLInputElement | null;
  msgSearchInput?.addEventListener('input', debounce(() => {
    messagesSearchQuery = msgSearchInput.value.trim();
    messagesCurrentPage = 1;
    applyMessagesPagination();
  }, 300));

  /* ── Delete message thread — event-delegated on document (not a per-button
     bind loop) so a message row inserted later via AJAX doesn't need its
     delete button separately re-bound. ── */
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-msg-id]');
    if (!btn) return;
    e.stopPropagation();
    const id = btn.dataset.deleteMsgId ?? '';
    // Subject is read off the row rather than a data-attribute so both
    // renderers (SellerMessageRow.astro + buildMessageRow) stay untouched.
    const subject = btn.closest('tr')?.querySelector('.msg-table__td--subject')?.textContent?.trim() ?? '';
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: 'למחוק את השיחה?',
        message: subject
          ? `"${subject}" תימחק לצמיתות, ללא אפשרות שחזור.`
          : 'השיחה תימחק לצמיתות, ללא אפשרות שחזור.',
        okLabel: 'מחק שיחה',
        workingLabel: 'מוחק…',
        onConfirm: async () => {
          try {
            const res = await fetch('/api/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', id }),
            });
            if (!res.ok) throw new Error('request failed');
            const row = btn.closest('tr');
            const nextRow = row?.nextElementSibling;
            row?.remove();
            if (nextRow?.classList.contains('msg-thread-row')) nextRow.remove();
          } catch {
            showErrorToast('המחיקה נכשלה', 'נסו שוב');
          }
        },
      },
    }));
  });

  function refreshRowPreview(id: string, row: HTMLElement) {
    fetch(`/api/messages?repliesFor=${id}`)
      .then((r) => r.json())
      .then(({ replies }: { replies: { fromUserId: string; content: string; createdAt: string }[] }) => {
        if (replies.length === 0) return;
        const last = replies[replies.length - 1]!;
        const isSelf = last.fromUserId === currentSellerId;
        const previewTd = row.querySelector('.msg-table__td--preview');
        if (previewTd) previewTd.innerHTML = `${escMsg(last.content)}${isSelf ? ' <span class="msg-table__preview-you">(אתה)</span>' : ''}`;
        const dateTd = row.querySelector('.msg-table__td--date');
        if (dateTd) dateTd.textContent = fmtDateJs(last.createdAt);
        row.dataset.sortDate = last.createdAt;
      }).catch(() => {});
  }

  function refreshSystemRowPreview(row: HTMLElement, threadId: string) {
    fetch(`/api/admin-messages?threadId=${encodeURIComponent(threadId)}`)
      .then((r) => r.json())
      .then(({ messages }: { messages?: { fromRole: 'admin' | 'seller'; content: string; createdAt: string }[] }) => {
        const last = messages?.[messages.length - 1];
        if (!last) return;
        const isSelf = last.fromRole === 'seller';
        const previewTd = row.querySelector('.msg-table__td--preview');
        if (previewTd) previewTd.innerHTML = `${escMsg(last.content)}${isSelf ? ' <span class="msg-table__preview-you">(אתה)</span>' : ''}`;
        const dateTd = row.querySelector('.msg-table__td--date');
        if (dateTd) dateTd.textContent = fmtDateJs(last.createdAt);
        row.dataset.sortDate = last.createdAt;
      }).catch(() => {});
  }

  // Live unread polling — one pass over every row in the table, buyer and
  // system alike, so a seller with zero buyer-unread but a fresh system
  // message still keeps the tab dot (a buyer-only unreadIds.length check used
  // to wipe it either way).
  function pollSellerUnread() {
    Promise.all([
      fetch(`/api/messages?role=seller&unread=1&storeId=${encodeURIComponent(currentStoreIdForMsgs)}`).then((r) => r.json()) as Promise<{ unreadIds: string[] }>,
      fetch('/api/admin-messages?unread=1').then((r) => r.json()) as Promise<{ unreadThreadIds: string[] }>,
    ]).then(([{ unreadIds }, { unreadThreadIds }]) => {
      const tabBtn = document.getElementById('tab-messages');
      const tabDot = tabBtn?.querySelector<HTMLElement>('span[aria-label]');
      const hasAnyUnread = unreadIds.length > 0 || unreadThreadIds.length > 0;
      if (hasAnyUnread && !tabDot && tabBtn) {
        const dot = document.createElement('span');
        dot.setAttribute('aria-label', 'הודעות שלא נקראו');
        dot.style.cssText = 'position:absolute;top:0.45rem;inset-inline-end:0.6rem;width:7px;height:7px;background:#ef4444;border-radius:50%';
        tabBtn.appendChild(dot);
      } else if (!hasAnyUnread) {
        tabDot?.remove();
      }
      document.querySelectorAll<HTMLElement>('[data-msg-id]').forEach((row) => {
        const id = row.dataset.msgId!;
        const isSystemRow = row.dataset.msgKind === 'system';
        const isUnread = isSystemRow ? unreadThreadIds.includes(id) : unreadIds.includes(id);
        if (!isUnread) return;
        if (row.classList.contains('msg-table__row--open')) {
          sellerThreadLoaders.get(id)?.(true, true);
        } else {
          row.classList.add('msg-table__row--unread');
          const fromTd = row.querySelector('.msg-table__td--from');
          if (fromTd && !fromTd.querySelector('.msg-unread-sr')) {
            const sr = document.createElement('span');
            sr.className = 'visually-hidden msg-unread-sr';
            sr.textContent = 'לא נקרא · ';
            fromTd.insertBefore(sr, fromTd.firstChild);
          }
          if (isSystemRow) refreshSystemRowPreview(row, id); else refreshRowPreview(id, row);
          // Becoming unread may no longer match an active "read only" filter
          // — a single-row check against state already known client-side,
          // not a full re-fetch of the current page.
          if (!rowMatchesMsgFilters(row)) row.hidden = true;
        }
      });
    }).catch(() => {});
  }
  pollSellerUnread();
  setInterval(pollSellerUnread, 15000);
}
