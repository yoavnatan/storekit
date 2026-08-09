import { createFloatingPortal, toolbarMenuTitle, filterClearButtonHtml } from '../../lib/toolbar-portal.js';
import { orderAgeChipHtml } from '../../lib/order-age.js';
import { CANCELLABLE_FROM } from '../../lib/order-status-rules.js';
import { encodeList, debounce } from '../../lib/admin-nav.js';
import { applyStockAttentionFilter } from './products.js';
import { registerPanelRefresh } from './tab-sync.js';
import { ORDER_ACTIVE_STATUSES, ORDER_FILTER_STATUSES } from '../../lib/seller-orders-query.js';
import { storeSliceTotalAgorot } from '../../lib/order-totals.js';
import { scrollBelowPinnedChrome } from './scroll-utils.js';
import { cdnThumb } from '../../lib/cdn.js';
import { initImageSkeletons } from '../../lib/img-skeleton.js';
// Both historic local names, one implementation (lib/html-escape.ts).
import { escapeHtml as esc, escapeHtml as escEom } from '../../lib/html-escape.js';

// Orders tab: order cards (accordion, status/tracking/notes/cancel), toolbar
// sort+filter, server-fetched pagination, new-order polling, and the edit-order
// details modal. Extracted verbatim from seller/dashboard.astro's inline
// <script>. `onAlertsChanged` = the dashboard's updateSwitcherAlertDot (shared
// with the messages tab), re-run whenever an order's handled state changes.
/**
 * One order-card item thumbnail — ONE definition, because this row has three renderers (the
 * SSR one in seller/dashboard.astro, buildOrderCard below, and the post-save patch that
 * rewrites the list after the edit modal saves) and they must stay identical.
 *
 * They had already drifted, which is why this is a function now: the post-save patch carried
 * neither the border nor the surface, so saving an order flattened every background-removed
 * photo in the card onto the row it sits on — until a reload rendered the same list correctly.
 *
 * `data-skeleton` + `.dash-img-skel` hand it to lib/img-skeleton.ts: a shimmer UNDER the photo,
 * and only while the fetch is genuinely in flight (dashboard.css carries the rest).
 */
function orderItemThumbHtml(image: string): string {
  return `<span class="dash-img-skel block w-9 h-9 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border [border-color:var(--color-border)] bg-[color:var(--color-surface)]" data-skeleton><img src="${esc(cdnThumb(image, 72, 72))}" alt="" width="36" height="36" loading="lazy" decoding="async" class="block w-full h-full object-cover"></span>`;
}

export function initOrdersTab(onAlertsChanged: () => void): void {
  // i18n for the whole tab — FIRST, above every function that reads it. The
  // file already learned this once: a declaration further down put bindOrderCard
  // in its temporal dead zone when the init pass ran over the SSR cards, and card
  // expand/collapse broke entirely.
  let ordersDashI18n: Record<string, string> = {};
  try { ordersDashI18n = JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; } catch { /* noop */ }

  /** One key, with its `{n}` filled in. No Hebrew fallback: a missing key is an
   *  i18n bug to see, not to paper over with the wrong language. */
  const tt = (key: string, n?: number): string => {
    const raw = ordersDashI18n[key] ?? '';
    return n === undefined ? raw : raw.replace('{n}', String(n));
  };

  // The age chip renders its own wording, so it needs the page's language the
  // same way the server hands it to the SSR card. Read off <html lang> — the one
  // place the request's language reaches the client without a second copy of the
  // cookie logic (i18n/index.ts#getLang → BaseLayout).
  const ordersLang = document.documentElement.lang === 'en' ? 'en' : 'he';

  // ── Order cards: accordion + save status/tracking ────────────
  const colorMap = { pending:'#ef4444', processing:'#3b82f6', ready:'#f59e0b', shipped:'#8b5cf6', delivered:'#16a34a', cancelled:'#6b7280' } as Record<string, string>;
  // Status wording is the translations' own (`shipping*`), not a second copy of
  // it here — this map was Hebrew literals, so an English dashboard labelled
  // every rebuilt card in Hebrew.
  const labelMap: Record<string, string> = {
    pending: tt('shippingPending'), processing: tt('shippingProcessing'), ready: tt('shippingReady'),
    shipped: tt('shippingShipped'), delivered: tt('shippingDelivered'), cancelled: tt('shippingCancelled'),
  };

  // Body-anchored (position:fixed, clamped to viewport) instead of the old
  // in-card position:absolute — an order near the bottom of a long list
  // could open its status menu off the bottom of the screen with nothing to
  // scroll it into view (CURRENT_TASK.md). Own portal instance, separate
  // from ordersPortal (toolbar sort/filter) below, since this one is opened
  // from bindOrderCard() which runs before that const is declared.
  const orderStatusPortal = createFloatingPortal('order-status-portal');
  const storeSlugForOrders = (document.getElementById('upload-config') as HTMLElement | null)?.dataset.storeSlug ?? '';

  function updateOrderTabBadge(): void {
    const remaining = document.querySelectorAll('.order-new-dot').length;
    const tabBadge  = document.querySelector<HTMLElement>('#tab-orders .dash-tab-badge');
    const tabBtn    = document.getElementById('tab-orders');
    if (remaining === 0) {
      tabBadge?.remove();
    } else if (tabBadge) {
      tabBadge.textContent = String(remaining);
    } else if (tabBtn) {
      const span = document.createElement('span');
      span.className = 'dash-tab-badge';
      // Same severity the SSR badge declares — a badge this rebuilds must stay
      // visible to the strip's off-screen beacon (tab-alert-edges.ts).
      span.setAttribute('data-tab-alert', 'danger');
      span.setAttribute('aria-label', tt('orderNewCount', remaining));
      span.textContent = String(remaining);
      tabBtn.appendChild(span);
    }
    onAlertsChanged();
  }

  // Keep the Overview tab's "attention" squares (new-orders / not-yet-shipped)
  // live as statuses change on the Orders tab — they're server-rendered totals
  // across ALL orders (not just the visible page), so they can't be recomputed
  // from the DOM; instead we apply the exact delta of this one status move.
  // Without this the seller had to reload to see the counts update (CURRENT_TASK
  // seller item 2: "the alert doesn't update live").
  function bumpOverviewCount(btnId: string, positiveColorClass: string, delta: number): void {
    if (!delta) return;
    const dd = document.querySelector<HTMLElement>(`#${btnId} dd`);
    if (!dd) return;
    const next = Math.max(0, (parseInt(dd.textContent ?? '0', 10) || 0) + delta);
    dd.textContent = String(next);
    dd.classList.remove('[color:var(--color-accent)]', '[color:var(--color-warning)]', '[color:var(--color-muted)]');
    dd.classList.add(next > 0 ? positiveColorClass : '[color:var(--color-muted)]');
  }
  function syncOverviewOnStatusChange(prev: string, next: string): void {
    bumpOverviewCount('ov-new-orders', '[color:var(--color-accent)]', (next === 'pending' ? 1 : 0) - (prev === 'pending' ? 1 : 0));
    bumpOverviewCount('ov-unshipped', '[color:var(--color-warning)]', (next === 'processing' ? 1 : 0) - (prev === 'processing' ? 1 : 0));
  }
  // The age/urgency chip depends on the shipping status (e.g. a shipped order
  // stops escalating red), so it must be re-rendered when the status changes —
  // otherwise it stays stale until reload. createdAt comes from data-sort-date.
  function refreshOrderAgeChip(card: HTMLElement, status: string): void {
    const slot = card.querySelector<HTMLElement>('.order-age-chip-slot');
    const createdAt = card.dataset.sortDate ?? '';
    if (slot && createdAt) slot.innerHTML = orderAgeChipHtml(createdAt, status, ordersLang);
  }


  function bindOrderCard(card: HTMLElement): void {
    if (card.dataset.bound === '1') return;
    card.dataset.bound = '1';

    const header     = card.querySelector<HTMLElement>('.order-card__header');
    const body       = card.querySelector<HTMLElement>('.order-card__body');
    const saveBtn       = card.querySelector<HTMLButtonElement>('.order-save-btn');
    const saveStatus    = card.querySelector<HTMLElement>('.order-save-status');
    const statusInput   = card.querySelector<HTMLInputElement>('.order-status-select');
    const statusTrigger = card.querySelector<HTMLButtonElement>('.order-status-trigger');
    const statusBadge   = card.querySelector<HTMLButtonElement>('.order-card__status-badge');
    const trackInput    = card.querySelector<HTMLInputElement>('.order-tracking-input');
    const noteInput     = card.querySelector<HTMLTextAreaElement>('.order-note-input');
    const copyBtn       = card.querySelector<HTMLButtonElement>('.order-copy-track');
    const orderId       = card.dataset.orderId ?? '';
    const storeSlug     = card.dataset.storeSlug ?? '';

    // Notes: a per-store LIST of private notes, managed independently of the
    // status/tracking save — each add / edit / delete is its own note-only PATCH
    // (sellerNotes = the full replacement array for this store). The editor appends
    // a new note or edits an existing one (editingIdx); each list row has ✎ + 🗑.
    const noteListEl    = card.querySelector<HTMLElement>('.order-note-list');
    const noteAddBtn    = card.querySelector<HTMLButtonElement>('.order-note-add');
    const noteEditor    = card.querySelector<HTMLElement>('.order-note-editor');
    const noteSaveBtn   = card.querySelector<HTMLButtonElement>('.order-note-save');
    const noteCancelBtn = card.querySelector<HTMLButtonElement>('.order-note-cancel');
    let notes: string[] = noteListEl
      ? Array.from(noteListEl.querySelectorAll<HTMLElement>('.order-note-text')).map((el) => el.textContent ?? '').filter((s) => s.trim() !== '')
      : [];
    let editingIdx: number | null = null;
    const NOTE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 mt-[0.15rem] [color:var(--color-muted)]"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    const EDIT_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
    const TRASH_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    const X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const editLabel = tt('orderEditNote');
    const delLabel  = tt('orderNoteDelete');
    const cancelLabel = tt('orderNoteCancel');
    function syncNoteChip(): void {
      const noteChip = card.querySelector<HTMLElement>('.order-note-chip');
      if (!noteChip) return;
      if (notes.length) { noteChip.hidden = false; noteChip.title = notes.join('\n'); }
      else { noteChip.hidden = true; noteChip.removeAttribute('title'); }
    }
    // Rebuild the list from `notes` and (re)wire each row's ✎ / 🗑 — note text is set
    // via textContent, never innerHTML, so a note can't inject markup.
    function renderNotes(): void {
      if (!noteListEl) return;
      noteListEl.textContent = '';
      notes.forEach((n, i) => {
        const li = document.createElement('li');
        li.className = 'order-note-item flex items-start gap-1.5 text-[0.82rem]';
        li.innerHTML = `${NOTE_ICON}<span class="order-note-text flex-1 min-w-0 [color:var(--color-text)] whitespace-pre-wrap break-words"></span>`
          + `<span class="order-note-actions inline-flex items-center gap-1 shrink-0"><button type="button" class="order-note-edit inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] [color:var(--color-muted)] bg-transparent border-0 cursor-pointer transition-colors duration-100 hover:[color:var(--color-primary)]" aria-label="${esc(editLabel)}" title="${esc(editLabel)}">${EDIT_ICON}</button><button type="button" class="order-note-del-trigger inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] [color:var(--color-muted)] bg-transparent border-0 cursor-pointer transition-colors duration-100 hover:[color:var(--color-danger)]" aria-label="${esc(delLabel)}" title="${esc(delLabel)}">${TRASH_ICON}</button></span>`
          + `<span class="order-note-confirm inline-flex items-center gap-1 shrink-0" hidden><button type="button" class="order-note-del-no inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] [color:var(--color-muted)] bg-transparent border-0 cursor-pointer transition-colors duration-100 hover:[color:var(--color-text)]" aria-label="${esc(cancelLabel)}" title="${esc(cancelLabel)}">${X_ICON}</button><button type="button" class="order-note-del-yes inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] [color:var(--color-danger)] bg-transparent border-0 cursor-pointer transition-[filter] duration-100 hover:brightness-90" aria-label="${esc(delLabel)}" title="${esc(delLabel)}">${CHECK_ICON}</button></span>`;
        (li.querySelector('.order-note-text') as HTMLElement).textContent = n;
        const actions = li.querySelector<HTMLElement>('.order-note-actions');
        const confirm = li.querySelector<HTMLElement>('.order-note-confirm');
        li.querySelector('.order-note-edit')?.addEventListener('click', () => openNoteEditor(i));
        // Trash → inline ✓/✗ confirm right on the row (no modal); ✗ reverts, ✓ deletes.
        li.querySelector('.order-note-del-trigger')?.addEventListener('click', () => { if (actions) actions.hidden = true; if (confirm) confirm.hidden = false; });
        li.querySelector('.order-note-del-no')?.addEventListener('click', () => { if (confirm) confirm.hidden = true; if (actions) actions.hidden = false; });
        li.querySelector('.order-note-del-yes')?.addEventListener('click', () => deleteNote(i));
        noteListEl.appendChild(li);
      });
      noteListEl.hidden = notes.length === 0;
      syncNoteChip();
    }
    function openNoteEditor(idx: number | null): void {
      editingIdx = idx;
      if (noteInput) noteInput.value = idx === null ? '' : (notes[idx] ?? '');
      if (noteAddBtn) noteAddBtn.hidden = true;
      if (noteEditor) noteEditor.hidden = false;
      noteInput?.focus();
    }
    function closeNoteEditor(): void {
      editingIdx = null;
      if (noteEditor) noteEditor.hidden = true;
      if (noteAddBtn) noteAddBtn.hidden = false;
    }
    async function persistNotes(): Promise<boolean> {
      if (!orderId) return false;
      try {
        const res = await fetch('/api/seller/orders', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId, storeSlug, sellerNotes: notes }),
        });
        return res.ok;
      } catch { return false; }
    }
    // ✓ — append the new note (or replace the one being edited), then persist.
    async function commitNote(): Promise<void> {
      const val = noteInput?.value.trim() ?? '';
      const prev = notes.slice();
      if (editingIdx === null) { if (!val) { closeNoteEditor(); return; } notes.push(val); }
      else if (val) { notes[editingIdx] = val; }
      else { notes.splice(editingIdx, 1); }
      if (noteSaveBtn) noteSaveBtn.disabled = true;
      if (noteCancelBtn) noteCancelBtn.disabled = true;
      const ok = await persistNotes();
      if (noteSaveBtn) noteSaveBtn.disabled = false;
      if (noteCancelBtn) noteCancelBtn.disabled = false;
      if (ok) { renderNotes(); closeNoteEditor(); }
      else { notes = prev; } // revert; leave the editor open to retry
    }
    async function deleteNote(idx: number): Promise<void> {
      const prev = notes.slice();
      notes.splice(idx, 1);
      renderNotes(); // optimistic
      if (!(await persistNotes())) { notes = prev; renderNotes(); }
    }
    noteAddBtn?.addEventListener('click', () => openNoteEditor(null));
    noteSaveBtn?.addEventListener('click', commitNote);
    noteCancelBtn?.addEventListener('click', closeNoteEditor);
    renderNotes(); // wire the SSR/prebuilt rows' ✎ / 🗑 handlers

    // copy tracking number to clipboard — brief icon→check swap as confirmation
    copyBtn?.addEventListener('click', async () => {
      const value = trackInput?.value.trim() ?? '';
      if (!value) { trackInput?.focus(); return; }
      try { await navigator.clipboard.writeText(value); }
      catch { trackInput?.select(); document.execCommand('copy'); }
      const icon = copyBtn.querySelector<HTMLElement>('.order-copy-icon');
      const check = copyBtn.querySelector<HTMLElement>('.order-copy-check');
      icon?.classList.add('hidden');
      check?.classList.remove('hidden');
      setTimeout(() => { check?.classList.add('hidden'); icon?.classList.remove('hidden'); }, 1400);
    });

    // status dropdown — opened in the shared floating portal (fixed position,
    // clamped to viewport) rather than an in-card absolute menu, so it can
    // never render off the bottom of the screen.
    statusTrigger?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (orderStatusPortal.currentTrigger() === statusTrigger) { orderStatusPortal.close(); return; }
      const currentVal = statusInput?.value ?? '';
      // Seller's manual states only: בטיפול → נשלח → נמסר. 'pending' is the
      // auto initial state, 'cancelled' is the confirm-gated button, and 'ready'
      // (ממתין לאיסוף שליח) returns as a CARRIER-driven state once shipping is
      // wired — not a manual toggle with nothing behind it (see GO_LIVE §5).
      orderStatusPortal.open(statusTrigger, '11rem', () => Object.entries(labelMap).filter(([v]) => ['processing', 'shipped', 'delivered'].includes(v)).map(([v, l]) =>
        `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.84rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-value="${v}" style="${currentVal === v ? 'font-weight:700' : ''}"><span class="order-status-dot" style="background:${colorMap[v] ?? '#888'}"></span>${l}</button>`
      ).join(''), (portal) => {
        portal.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((opt) => {
          opt.addEventListener('click', () => {
            const val = opt.dataset.value ?? '';
            if (statusInput) statusInput.value = val;
            const col = colorMap[val] ?? '#888';
            const lbl = labelMap[val] ?? val;
            const dot = statusTrigger?.querySelector<HTMLElement>('.order-status-dot');
            const lbl_el = statusTrigger?.querySelector<HTMLElement>('.order-status-label');
            if (dot) dot.style.background = col;
            if (lbl_el) lbl_el.textContent = lbl;
            orderStatusPortal.close();
          });
        });
      });
    });

    function closeCard(): void {
      card.removeAttribute('data-open');
      if (body) body.hidden = true;
      header?.setAttribute('aria-expanded', 'false');
    }

    header?.addEventListener('click', () => {
      const isOpen = card.hasAttribute('data-open');
      if (isOpen) {
        closeCard();
      } else {
        card.setAttribute('data-open', '');
        if (body) body.hidden = false;
        header.setAttribute('aria-expanded', 'true');
      }
    });
    header?.addEventListener('keydown', (e: KeyboardEvent) => {
      // Only the header itself toggles on Enter/Space — not a keystroke bubbling
      // up from the focusable status badge button nested inside it.
      if (e.target !== header) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
    });

    // Persist a shipping-status change and reflect it everywhere the status is
    // shown — header badge (label + colour), the in-body dropdown trigger, the
    // hidden select, the "new order" dot + its notification, the row's filter
    // visibility, and the tab badge — so the result is identical whether the
    // seller used the in-card Save button or the quick menu on the collapsed
    // header. Returns false on a failed request so callers can restore their UI.
    async function applyStatusSave(newStatus: string): Promise<boolean> {
      if (!orderId || !newStatus) return false;
      const hadDot = !!card.querySelector('.order-new-dot');
      const prevStatus = card.dataset.shippingStatus ?? '';
      try {
        const res = await fetch('/api/seller/orders', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId, storeSlug, shippingStatus: newStatus, trackingNumber: trackInput?.value ?? '' }),
        });
        if (!res.ok) return false;
        const col = colorMap[newStatus] ?? '#888';
        const lbl = labelMap[newStatus] ?? newStatus;
        // keep the in-body editor in sync (it may never have been opened)
        if (statusInput) statusInput.value = newStatus;
        const trigDot = statusTrigger?.querySelector<HTMLElement>('.order-status-dot');
        const trigLbl = statusTrigger?.querySelector<HTMLElement>('.order-status-label');
        if (trigDot) trigDot.style.background = col;
        if (trigLbl) trigLbl.textContent = lbl;
        // header badge — update only the label span, never textContent (the
        // badge now also holds a chevron icon that must survive).
        if (statusBadge) {
          statusBadge.style.background = `${col}1a`;
          statusBadge.style.color = col;
          const badgeLbl = statusBadge.querySelector<HTMLElement>('.order-status-badge-label');
          if (badgeLbl) badgeLbl.textContent = lbl;
        }
        // moving AWAY from pending → remove dot + delete notification
        if (hadDot && newStatus !== 'pending') {
          card.querySelector('.order-new-dot')?.remove();
          fetch('/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete-by-related', relatedId: orderId }),
          }).catch(() => {});
          window.dispatchEvent(new CustomEvent('notif-refreshed'));
        }
        card.dataset.shippingStatus = newStatus;
        // moving BACK to pending → re-add dot
        if (!hadDot && newStatus === 'pending') {
          const idSpan = card.querySelector('.order-card__id');
          if (idSpan && !idSpan.querySelector('.order-new-dot')) {
            const dot = document.createElement('span');
            dot.className = 'order-new-dot inline-block w-2 h-2 bg-[#ef4444] rounded-full ms-[5px] align-middle shrink-0';
            dot.setAttribute('aria-label', tt('orderNewLabel'));
            idSpan.appendChild(dot);
          }
        }
        updateOrderTabBadge();
        syncOverviewOnStatusChange(prevStatus, newStatus);
        refreshOrderAgeChip(card, newStatus);
        // hide locally if it no longer matches the active filter (e.g. moving to
        // "delivered" while "active" is on) — a single-card check against state
        // already known client-side, no need to re-fetch the whole page.
        if (!rowMatchesOrderFilters(card)) card.style.display = 'none';
        return true;
      } catch { return false; }
    }

    saveBtn?.addEventListener('click', async () => {
      if (!orderId) return;
      saveBtn.disabled = true;
      const ok = await applyStatusSave(statusInput?.value ?? '');
      if (ok) {
        if (saveStatus) { saveStatus.hidden = false; setTimeout(() => { saveStatus.hidden = true; }, 2500); }
        setTimeout(closeCard, 700);
      }
      saveBtn.disabled = false;
    });

    // Quick status change straight from the collapsed header — click the status
    // badge to open the same status menu with an inline Save, so a seller can
    // advance an order without expanding the card. stopPropagation keeps the
    // click from toggling the card open; the portal manages aria-expanded and
    // outside-click/Escape close on its own.
    statusBadge?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (orderStatusPortal.currentTrigger() === statusBadge) { orderStatusPortal.close(); return; }
      let pending = card.dataset.shippingStatus ?? statusInput?.value ?? '';
      const MANUAL = ['processing', 'shipped', 'delivered'];
      orderStatusPortal.open(statusBadge, '12rem', () => [
        ...MANUAL.map((v) =>
          `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.84rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-value="${v}" style="${pending === v ? 'font-weight:700' : ''}"><span class="order-status-dot" style="background:${colorMap[v] ?? '#888'}"></span>${labelMap[v] ?? v}</button>`
        ),
        `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
        `<div class="px-2 pb-1"><button type="button" class="btn btn--accent btn--sm w-full order-quick-save">${tt('orderSave')}</button></div>`,
      ].join(''), (portal) => {
        portal.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((opt) => {
          opt.addEventListener('click', () => {
            pending = opt.dataset.value ?? pending;
            portal.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((o2) => {
              o2.style.fontWeight = o2.dataset.value === pending ? '700' : '';
            });
          });
        });
        const saveQuick = portal.querySelector<HTMLButtonElement>('.order-quick-save');
        saveQuick?.addEventListener('click', async () => {
          saveQuick.disabled = true;
          const ok = await applyStatusSave(pending);
          if (ok) orderStatusPortal.close();
          else saveQuick.disabled = false;
        });
      });
    });

    // Cancel order — a confirm-gated escape hatch (out-of-stock, buyer changed
    // their mind, …). Restock + buyer notification happen server-side; here we
    // just reflect the terminal state. Only rendered for a still-cancellable
    // order (pending/processing/ready), so no need to re-check status here.
    const cancelBtn = card.querySelector<HTMLButtonElement>('.order-cancel-btn');
    async function runOrderCancel(): Promise<void> {
      if (!orderId) return;
      const prevStatus = card.dataset.shippingStatus ?? '';
      const res = await fetch('/api/seller/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, storeSlug, shippingStatus: 'cancelled' }),
      });
      if (!res.ok) return;
      const badge = card.querySelector<HTMLElement>('.order-card__status-badge');
      if (badge) {
        badge.style.background = `${colorMap.cancelled ?? '#6b7280'}1a`;
        badge.style.color = colorMap.cancelled ?? '#6b7280';
        const badgeLbl = badge.querySelector<HTMLElement>('.order-status-badge-label');
        if (badgeLbl) badgeLbl.textContent = labelMap.cancelled;
      }
      card.dataset.shippingStatus = 'cancelled';
      // No longer an actionable "new order" — drop the dot + its notification.
      card.querySelector('.order-new-dot')?.remove();
      fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-by-related', relatedId: orderId }),
      }).catch(() => {});
      window.dispatchEvent(new CustomEvent('notif-refreshed'));
      cancelBtn?.remove();
      updateOrderTabBadge();
      syncOverviewOnStatusChange(prevStatus, 'cancelled');
      refreshOrderAgeChip(card, 'cancelled');
      if (!rowMatchesOrderFilters(card)) card.style.display = 'none';
    }
    cancelBtn?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: tt('orderCancelTitle'),
          message: tt('orderCancelMsg'),
          okLabel: tt('orderCancelOk'),
          workingLabel: tt('orderCancelWorking'),
          onConfirm: () => runOrderCancel(),
        },
      }));
    });
  }

  document.querySelectorAll<HTMLElement>('.order-card').forEach(bindOrderCard);

  // ── Orders: sort + filter ────────────────────────────────────
  // Cards-only at every screen size (no table/header split like
  // products/messages), so one always-visible toolbar instead of a
  // desktop-header + mobile-dropdown pair. Filter uses the same
  // column-list → values drill-down as products'/messages' own "filter by"
  // (ORDER_FILTER_COLUMNS today only has 'status', but the mechanism is
  // ready for more columns later without restructuring). Default selection
  // replicates the old "active" preset.
  // Both lists come from seller-orders-query.ts, which is also what the SSR page and
  // /api/seller/orders parse against — a second copy here drifted once already: the
  // server's default view included 'ready' while this file's did not, so the first
  // filter change would have silently dropped rows the page had shown. ('ready' is
  // omitted from the menu itself — no seller can set it until shipping is wired,
  // GO_LIVE §5. OWES_ACTION still lists it so a future 'ready' order stays
  // cancellable — that's business logic, not the UI.)
  const ACTIVE_STATUSES = new Set(ORDER_ACTIVE_STATUSES);
  const ORDER_STATUSES = ORDER_FILTER_STATUSES;
  const ORDER_FILTER_COLUMNS = ['status']; // add more column keys here (+ a case in getOrderFilterValue) if warranted later
  const ordersFilters = new Map<string, Set<string>>([['status', new Set(ACTIVE_STATUSES)]]);
  let ordersSortCol: 'date' | 'amount' | 'urgency' = 'date';
  let ordersSortDir: 'asc' | 'desc' = 'desc';
  let ordersCurrentPage = 1;
  let ordersSearchQuery = '';

  // Lifted out of the old poll-only block below (buildOrderCard originally
  // only existed to render a poll-inserted new order) — applyOrdersPagination
  // needs it too now, to render every card fetched via AJAX, not just polled
  // ones. Both only ever close over storeSlugForOrders (a top-level const),
  // so nothing here actually depended on living inside that block.
  function fmtOrderDate(iso: string): string {
    return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  // Match formatPrice() (store.config): thousands separators, and decimals only
  // when the amount actually has a fraction — no trailing ".00" (owner feedback).
  function fmtPrice(n: number): string { return n.toLocaleString('en-US') + ' ₪'; }
  /** Integer agorot → what a person reads. The server-side twin is `money.ts#formatAgorot`; this
   *  bundle cannot import it (it pulls in the store config), so the ONE thing kept in step by hand
   *  is the division. Every amount arriving from /api/seller/orders is agorot now, so a bare
   *  `fmtPrice` on one of them would print a figure a hundred times too large. */
  function fmtAgorot(agorot: number): string { return fmtPrice(agorot / 100); }

  function buildOrderCard(o: {
    id: string; checkoutRef?: string; createdAt: string; buyerName: string; buyerEmail: string; buyerPhone: string;
    buyerAddress: { city: string; street: string; zip?: string };
    shippingStatus: string; items: { storeSlug: string; productName: string; qty: number; priceAgorot: number; image?: string }[];
    storeSubtotals: Record<string, { subtotalAgorot: number; shippingAgorot: number; discount?: { type: string; value: number; appliedAgorot: number } }>;
    notes?: string[];
  }): string {
    const shortId  = o.checkoutRef ?? o.id.slice(0, 8).toUpperCase();
    const color    = colorMap[o.shippingStatus] ?? '#888';
    const label    = labelMap[o.shippingStatus] ?? o.shippingStatus;
    const storeSub = o.storeSubtotals[storeSlugForOrders] ?? { subtotalAgorot: 0, shippingAgorot: 0 };
    const total    = storeSliceTotalAgorot(storeSub);
    const storeItems = o.items.filter(i => i.storeSlug === storeSlugForOrders);
    const isNew    = o.shippingStatus === 'pending';
    const notes    = (o.notes ?? []).filter(Boolean);
    const noteItemsHtml = notes.map((n) => `<li class="order-note-item flex items-start gap-1.5 text-[0.82rem]"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 mt-[0.15rem] [color:var(--color-muted)]"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span class="order-note-text flex-1 min-w-0 [color:var(--color-text)] whitespace-pre-wrap break-words">${esc(n)}</span><button type="button" class="order-note-edit shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] [color:var(--color-muted)] bg-transparent border-0 cursor-pointer transition-colors duration-100 hover:[color:var(--color-primary)]" aria-label="${esc(tt('orderEditNote'))}" title="${esc(tt('orderEditNote'))}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button><button type="button" class="order-note-del shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] [color:var(--color-muted)] bg-transparent border-0 cursor-pointer transition-colors duration-100 hover:[color:var(--color-danger)]" aria-label="${esc(tt('orderNoteDelete'))}" title="${esc(tt('orderNoteDelete'))}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button></li>`).join('');

    const itemsHtml = storeItems.map(item => `
      <li class="flex items-center gap-2.5 text-sm">
        ${item.image ? orderItemThumbHtml(item.image) : ''}
        <span class="flex-1 text-[color:var(--color-text)]">${esc(item.productName)}</span>
        <span class="text-[color:var(--color-muted)] text-[0.8rem]">×${item.qty}</span>
        <span class="font-bold text-[color:var(--color-text)] ms-auto">${fmtAgorot(item.priceAgorot * item.qty)}</span>
      </li>`).join('');

    const statusDotHtml = (v: string) => `<span class="order-status-dot" style="background:${colorMap[v] ?? '#888'}"></span>`;
    const statusDropdown = `<div class="order-status-dropdown">
      <button class="order-status-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
        ${statusDotHtml(o.shippingStatus)}<span class="order-status-label">${esc(label)}</span>
        <svg class="order-status-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <input type="hidden" class="order-status-select" data-field="shippingStatus" value="${esc(o.shippingStatus)}" />
    </div>`;

    // Header layout mirrors the SSR card in seller/dashboard.astro exactly — a
    // 3-column grid below 640px OF THE CARD (container query) and the desktop
    // row above it. Keep the two in sync; the comment there explains why.
    return `<div class="order-card @container/ordcard group border-[1.5px] border-[color:var(--color-border)] rounded-[var(--radius)] overflow-visible bg-[color:var(--color-surface)] transition-[border-color] duration-150 hover:border-[color:color-mix(in_srgb,var(--color-text)_20%,var(--color-border))]" data-order-id="${esc(o.id)}" data-store-slug="${esc(storeSlugForOrders)}" data-shipping-status="${esc(o.shippingStatus)}" data-sort-date="${esc(o.createdAt)}" data-sort-amount="${total}">
      <div class="order-card__header grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 @[640px]/ordcard:flex @[640px]/ordcard:gap-3 px-4 py-[0.875rem] cursor-pointer select-none rounded-[calc(var(--radius)-1.5px)] group-data-[open]:rounded-b-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:[outline-offset:-2px]" role="button" tabindex="0" aria-expanded="false">
        <div class="flex flex-col items-start gap-[0.2rem] @[640px]/ordcard:w-28 shrink-0 [grid-area:1/1]">
          <span class="order-card__id text-[0.8rem] font-bold text-[color:var(--color-text)] font-mono">#${esc(shortId)}${isNew ? `<span class="order-new-dot inline-block w-2 h-2 bg-[#ef4444] rounded-full ms-[5px] align-middle shrink-0" aria-label="${esc(tt('orderNewLabel'))}"></span>` : ''}</span>
          <span class="text-[0.72rem] text-[color:var(--color-muted)] whitespace-nowrap">${esc(fmtOrderDate(o.createdAt))}</span>
        </div>
        <div class="contents @[640px]/ordcard:flex @[640px]/ordcard:flex-1 @[640px]/ordcard:items-center @[640px]/ordcard:gap-3 @[640px]/ordcard:min-w-0">
          <div class="flex flex-col min-w-0 flex-1 gap-[0.15rem] [grid-area:1/2]">
            <span class="text-sm font-semibold text-[color:var(--color-text)] truncate">${esc(o.buyerName)}</span>
            <span class="text-[0.72rem] text-[color:var(--color-muted)] truncate">${esc(storeItems.length === 1 ? tt('orderProductsOne') : tt('orderProductsMany', storeItems.length))}</span>
          </div>
          <div class="contents @[640px]/ordcard:flex @[640px]/ordcard:items-center @[640px]/ordcard:gap-4 @[640px]/ordcard:shrink-0">
            <span class="order-card__amount text-sm font-bold text-[color:var(--color-text)] text-start [grid-area:2/1] self-baseline @[640px]/ordcard:w-[6rem] @[640px]/ordcard:text-end @[640px]/ordcard:self-center">${fmtAgorot(total)}</span>
            <div class="flex flex-wrap items-center justify-end gap-1.5 min-w-0 [grid-area:2/2/3/4] @[640px]/ordcard:w-[13.5rem] @[640px]/ordcard:flex-nowrap">
              <span class="order-age-chip-slot flex items-center min-w-0 overflow-hidden empty:hidden">${orderAgeChipHtml(o.createdAt, o.shippingStatus, ordersLang)}</span>
              <span class="order-note-chip inline-flex items-center shrink-0 [color:var(--color-muted)]"${notes.length ? ` title="${esc(notes.join('\n'))}"` : ' hidden'} aria-label="${esc(tt('orderNoteLabel'))}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg></span>
              <button type="button" class="order-card__status-badge inline-flex items-center gap-1 shrink-0 text-[0.72rem] font-semibold px-[0.55rem] py-[0.2rem] rounded-[20px] border-0 cursor-pointer transition-[filter] duration-100 hover:brightness-95 whitespace-nowrap" style="background:${esc(color)}1a;color:${esc(color)}" aria-haspopup="listbox" aria-expanded="false"><span class="order-status-badge-label">${esc(label)}</span><svg class="order-status-badge-chevron shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
            </div>
          </div>
        </div>
        <svg class="shrink-0 [grid-area:1/3] text-[color:var(--color-muted)] transition-transform duration-[220ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-data-[open]:rotate-180" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="order-card__body border-t border-[color:var(--color-border)] p-4 flex flex-col gap-4 animate-product-menu-open" hidden>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
            <h3 class="text-[0.78rem] font-bold text-[color:var(--color-muted)] uppercase tracking-[0.05em]">${esc(tt('orderBuyer'))}</h3>
            <button class="btn btn--ghost btn--sm order-edit-buyer-btn" type="button"
              data-order-id="${esc(o.id)}" data-store-slug="${esc(storeSlugForOrders)}"
              data-buyer-name="${esc(o.buyerName)}" data-buyer-email="${esc(o.buyerEmail)}"
              data-buyer-phone="${esc(o.buyerPhone)}" data-buyer-city="${esc(o.buyerAddress.city)}"
              data-buyer-street="${esc(o.buyerAddress.street)}" data-buyer-zip="${esc(o.buyerAddress.zip ?? '')}"
              data-items="${esc(JSON.stringify(storeItems))}"
              data-shipping-agorot="${esc(String(storeSub.shippingAgorot))}"
              data-discount-type="${esc(storeSub.discount?.type ?? 'percent')}"
              data-discount-value="${esc(String(storeSub.discount?.value ?? 0))}"
              style="font-size:0.75rem">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              ${esc(tt('orderEditDetails'))}
            </button>
          </div>
          <p class="order-card__info-line order-buyer-name text-sm text-[color:var(--color-text)] my-[0.1rem]"><strong>${esc(o.buyerName)}</strong></p>
          <p class="order-card__info-line order-buyer-email text-sm text-[color:var(--color-text)] my-[0.1rem]">${esc(o.buyerEmail)}</p>
          <p class="order-card__info-line order-buyer-phone text-sm text-[color:var(--color-text)] my-[0.1rem]">${esc(tt('orderPhone'))}: ${esc(o.buyerPhone)}</p>
          <p class="order-card__info-line order-buyer-address text-sm text-[color:var(--color-text)] my-[0.1rem]">${esc(tt('orderAddress'))}: ${esc(o.buyerAddress.street)}, ${esc(o.buyerAddress.city)}${o.buyerAddress.zip ? ' ' + esc(o.buyerAddress.zip) : ''}</p>
        </div>
        <div>
          <h3 class="text-[0.78rem] font-bold text-[color:var(--color-muted)] uppercase tracking-[0.05em] mb-2">${esc(tt('orderItems'))}</h3>
          <ul class="order-card__items list-none p-0 flex flex-col gap-2">${itemsHtml}</ul>
          <div class="order-card__subtotals flex justify-between items-center mt-2.5 pt-2.5 border-t border-[color:var(--color-border)] text-sm text-[color:var(--color-muted)]">
            <span>${esc(tt('orderShipping'))}: ${storeSub.shippingAgorot === 0 ? esc(tt('orderShippingFree')) : fmtAgorot(storeSub.shippingAgorot)}</span>
            ${storeSub.discount?.appliedAgorot ? `<span class="text-[color:var(--color-success)]">${esc(tt('orderEditDiscount'))}: −${fmtAgorot(storeSub.discount.appliedAgorot)}</span>` : ''}
            <strong class="text-[color:var(--color-text)] text-[0.9375rem]">${esc(tt('orderTotal'))}: ${fmtAgorot(total)}</strong>
          </div>
        </div>
        <div class="bg-[color:var(--color-bg)] rounded-b-[calc(var(--radius)-1.5px)] p-[0.875rem] overflow-visible">
          <div class="order-note mb-3">
            <ul class="order-note-list flex flex-col gap-1 mb-1"${notes.length ? '' : ' hidden'}>${noteItemsHtml}</ul>
            <button type="button" class="order-note-add inline-flex items-center gap-1.5 text-[0.82rem] font-semibold [color:var(--color-primary)] bg-transparent border-0 cursor-pointer py-1 hover:underline"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>${tt('orderAddNote')}</button>
            <div class="order-note-editor mt-1.5" hidden><textarea class="order-note-input input w-full !resize-none" rows="2" maxlength="2000"></textarea><div class="flex items-center justify-between gap-2 mt-1.5"><span class="text-[0.72rem] [color:var(--color-muted)]">${tt('orderNotePrivateHint')}</span><div class="flex items-center gap-1.5"><button type="button" class="order-note-cancel inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] bg-transparent [color:var(--color-muted)] border border-[color:var(--color-border)] cursor-pointer transition-colors duration-100 hover:bg-[color:var(--color-surface)] hover:[color:var(--color-text)]" aria-label="${esc(tt('orderNoteCancel'))}" title="${esc(tt('orderNoteCancel'))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button><button type="button" class="order-note-save inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] bg-[color:var(--color-primary)] text-white border-0 cursor-pointer transition-[filter] duration-100 hover:brightness-95" aria-label="${esc(tt('orderAddNote'))}" title="${esc(tt('orderAddNote'))}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></button></div></div></div>
          </div>
          <h3 class="text-[0.78rem] font-bold text-[color:var(--color-muted)] uppercase tracking-[0.05em] mb-2">${tt('orderShippingStatus')}</h3>
          <div class="flex gap-2 items-center flex-wrap">
            ${statusDropdown}
          </div>
          <h3 class="text-[0.78rem] font-bold text-[color:var(--color-muted)] uppercase tracking-[0.05em] mt-3 mb-2">${esc(tt('orderTracking'))}</h3>
          <div class="flex gap-2 items-center flex-wrap">
            <input type="text" class="order-tracking-input input" data-field="trackingNumber" value="" placeholder="${esc(tt('orderTrackingPlaceholder'))}" style="flex:1" />
            <button class="order-save-btn btn btn--sm btn--accent" type="button">${esc(tt('orderSave'))}</button>
          </div>
          <p class="order-save-status text-[0.8rem] font-semibold text-[color:var(--color-success)] mt-[0.4rem]" hidden aria-live="polite">${esc(tt('orderSaved'))}</p>
          ${(CANCELLABLE_FROM as readonly string[]).includes(o.shippingStatus) ? `<button class="order-cancel-btn mt-3 inline-flex items-center gap-[0.3rem] bg-transparent border-0 p-0 cursor-pointer text-[0.78rem] font-semibold text-[color:var(--color-danger)] hover:underline" type="button" data-order-id="${esc(o.id)}" data-store-slug="${esc(storeSlugForOrders)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${esc(tt('orderCancel'))}</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  const ORDER_SORT_OPTIONS: { col: 'date' | 'amount' | 'urgency'; dir: 'asc' | 'desc'; label: () => string }[] = [
    { col: 'urgency', dir: 'asc', label: () => tt('orderSortOptUrgency') },
    { col: 'date', dir: 'desc', label: () => tt('orderSortOptDateDesc') },
    { col: 'date', dir: 'asc', label: () => tt('orderSortOptDateAsc') },
    { col: 'amount', dir: 'desc', label: () => tt('orderSortOptAmountDesc') },
    { col: 'amount', dir: 'asc', label: () => tt('orderSortOptAmountAsc') },
  ];

  function getOrderFilterValue(card: HTMLElement, col: string): string {
    if (col === 'status') return card.dataset.shippingStatus ?? '';
    return '';
  }

  function orderFilterColumnLabel(col: string): string {
    if (col === 'status') return tt('filterColStatus');
    return col;
  }

  // 'status' is a fixed small enum, kept in workflow order (not alphabetical)
  // — a future free-text column would instead scan .order-card for its
  // distinct values, same as products'/messages' own getDistinctFilterValues.
  function getOrderDistinctValues(col: string): string[] {
    if (col === 'status') return ORDER_STATUSES;
    const values = new Set<string>();
    document.querySelectorAll<HTMLElement>('.order-card').forEach((card) => values.add(getOrderFilterValue(card, col)));
    return [...values].sort();
  }

  function orderFilterValueHtml(col: string, value: string): string {
    if (col === 'status') return `<span class="order-status-dot" style="background:${colorMap[value] ?? '#888'}"></span>${labelMap[value] ?? value}`;
    return value;
  }

  function rowMatchesOrderFilters(card: HTMLElement): boolean {
    for (const [col, values] of ordersFilters) {
      if (values.size === 0) continue;
      if (!values.has(getOrderFilterValue(card, col))) return false;
    }
    return true;
  }

  function refreshOrdersFilterBadge(): void {
    const badge = document.getElementById('orders-filter-count');
    if (!badge) return;
    const activeCols = [...ordersFilters.values()].filter((s) => s.size > 0).length;
    badge.hidden = activeCols === 0;
    badge.textContent = String(activeCols);
  }

  // Filter changed — re-fetch page 1 of the current query from the server
  // (kept as the same function name/shape the toolbar's own filter handlers
  // already call, just server-driven now instead of a DOM show/hide pass).
  function applyOrdersFilter(): void {
    ordersCurrentPage = 1;
    applyOrdersPagination();
  }

  function sortOrders(col: 'date' | 'amount' | 'urgency', dir: 'asc' | 'desc'): void {
    ordersSortCol = col;
    ordersSortDir = dir;
    ordersCurrentPage = 1;
    applyOrdersPagination();
    const label = document.getElementById('orders-sort-label');
    if (label) {
      const opt = ORDER_SORT_OPTIONS.find((o) => o.col === col && o.dir === dir) ?? ORDER_SORT_OPTIONS[0]!;
      label.textContent = opt.label();
    }
  }

  const ordersPortal = createFloatingPortal('orders-toolbar-portal');

  function openOrdersSort(trigger: HTMLElement): void {
    ordersPortal.open(trigger, '13rem', () => toolbarMenuTitle(tt('sortByLabel')) + ORDER_SORT_OPTIONS.map((o) => {
      const selected = o.col === ordersSortCol && o.dir === ordersSortDir;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label()}</button>`;
    }).join(''), (portal) => {
      portal.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortOrders((btn.dataset.sortCol as 'date' | 'amount' | 'urgency') ?? 'date', (btn.dataset.sortDir as 'asc' | 'desc') ?? 'desc');
          ordersPortal.close();
        });
      });
    });
  }

  function ordersFilterValuesHtml(col: string): string {
    const values = getOrderDistinctValues(col);
    const selected = ordersFilters.get(col) ?? new Set<string>();
    const backRotate = document.documentElement.dir === 'rtl' ? -90 : 90;
    return [
      `<button type="button" class="product-menu__back flex items-center gap-[.35rem] w-full text-start py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] font-semibold [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-back><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0;transform:rotate(${backRotate}deg)"><polyline points="6 9 12 15 18 9"/></svg>${orderFilterColumnLabel(col)}</button>`,
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      ...values.map((v) => `<label class="product-menu__checkbox-item flex items-center gap-[.4rem] py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer text-[.82rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]"><input type="checkbox" class="cursor-pointer shrink-0" data-order-filter-value="${v}" ${selected.has(v) ? 'checked' : ''}>${orderFilterValueHtml(col, v)}</label>`),
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      filterClearButtonHtml('data-orders-filter-clear-col', tt('filterClearColumn'), selected.size > 0),
    ].join('');
  }

  function ordersFilterColumnsHtml(): string {
    const chevronRotate = document.documentElement.dir === 'rtl' ? 90 : -90;
    return [
      toolbarMenuTitle(tt('filterByLabel')),
      ...ORDER_FILTER_COLUMNS.map((col) => {
        const active = (ordersFilters.get(col)?.size ?? 0) > 0;
        return `<div class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-col="${col}">
          <input type="checkbox" class="cursor-pointer shrink-0" data-filter-col-toggle="${col}" ${active ? 'checked' : ''}>
          <span style="flex:1">${orderFilterColumnLabel(col)}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0;transform:rotate(${chevronRotate}deg)"><polyline points="6 9 12 15 18 9"/></svg>
        </div>`;
      }).join(''),
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      filterClearButtonHtml('data-orders-filter-clear-all', tt('filterClearAll'), ordersFilters.size > 0),
    ].join('');
  }

  function openOrdersFilterValues(trigger: HTMLElement, col: string): void {
    ordersPortal.open(trigger, '12rem', () => ordersFilterValuesHtml(col), (portal) => {
      portal.querySelectorAll<HTMLInputElement>('[data-order-filter-value]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const set = ordersFilters.get(col) ?? new Set<string>();
          const v = cb.dataset.orderFilterValue ?? '';
          if (cb.checked) set.add(v); else set.delete(v);
          if (set.size) ordersFilters.set(col, set); else ordersFilters.delete(col);
          applyOrdersFilter();
        });
      });
      portal.querySelector('[data-filter-back]')?.addEventListener('click', () => openOrdersFilterColumns(trigger));
      portal.querySelector('[data-orders-filter-clear-col]')?.addEventListener('click', () => {
        if (!ordersFilters.has(col)) return;
        ordersFilters.delete(col);
        applyOrdersFilter();
        openOrdersFilterValues(trigger, col);
      });
    });
  }

  function openOrdersFilterColumns(trigger: HTMLElement): void {
    ordersPortal.open(trigger, '12rem', ordersFilterColumnsHtml, (portal) => {
      portal.querySelectorAll<HTMLElement>('[data-filter-col]').forEach((row) => {
        const col = row.dataset.filterCol ?? '';
        row.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-filter-col-toggle]')) return;
          openOrdersFilterValues(trigger, col);
        });
        const cb = row.querySelector<HTMLInputElement>('[data-filter-col-toggle]');
        cb?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (cb.checked) {
            cb.checked = false;
            openOrdersFilterValues(trigger, col);
            return;
          }
          ordersFilters.delete(col);
          applyOrdersFilter();
          openOrdersFilterColumns(trigger);
        });
      });
      portal.querySelector('[data-orders-filter-clear-all]')?.addEventListener('click', () => {
        if (!ordersFilters.size) return;
        ordersFilters.clear();
        applyOrdersFilter();
        openOrdersFilterColumns(trigger);
      });
    });
  }

  // Overview "attention" cards (CURRENT_TASK items 3+4): jump to the relevant
  // tab and pre-apply the matching filter so the click lands on exactly the
  // counted rows. Orders cards drive the same ordersFilters state +
  // applyOrdersFilter() the toolbar uses (so the funnel badge stays in sync);
  // the stock card calls products.js's applyStockAttentionFilter(). Search is
  // cleared first so a stale query can't hide the counted rows.
  function jumpToOrdersWithStatus(statuses: string[]): void {
    ordersSearchQuery = '';
    const searchEl = document.getElementById('orders-search-input') as HTMLInputElement | null;
    if (searchEl) searchEl.value = '';
    ordersFilters.clear();
    ordersFilters.set('status', new Set(statuses));
    document.querySelector<HTMLButtonElement>('[role="tab"][data-panel="orders"]')?.click();
    applyOrdersFilter();
  }
  document.getElementById('ov-new-orders')?.addEventListener('click', () => jumpToOrdersWithStatus(['pending']));
  document.getElementById('ov-unshipped')?.addEventListener('click', () => jumpToOrdersWithStatus(['processing']));
  document.getElementById('ov-stock-attention')?.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('[role="tab"][data-panel="products"]')?.click();
    applyStockAttentionFilter();
  });

  const ordersSortTrigger = document.getElementById('orders-sort-trigger') as HTMLButtonElement | null;
  ordersSortTrigger?.addEventListener('click', () => {
    if (ordersPortal.currentTrigger() === ordersSortTrigger) { ordersPortal.close(); return; }
    openOrdersSort(ordersSortTrigger);
  });

  const ordersFilterTrigger = document.getElementById('orders-filter-trigger') as HTMLButtonElement | null;
  ordersFilterTrigger?.addEventListener('click', () => {
    if (ordersPortal.currentTrigger() === ordersFilterTrigger) { ordersPortal.close(); return; }
    openOrdersFilterColumns(ordersFilterTrigger);
  });

  // ── Orders: server-fetched page/search/sort/filter (AJAX) ───────────
  // Same reasoning as Products' applyPagination() — search/sort/filter now
  // run server-side (seller-orders-query.ts), so a change re-fetches the
  // current query's page and rebuilds #orders-list via buildOrderCard()
  // rather than show/hide-ing DOM cards already on the page.
  async function applyOrdersPagination(): Promise<void> {
    const list = document.getElementById('orders-list');
    if (!list || !storeSlugForOrders) return;

    const params = new URLSearchParams();
    params.set('storeSlug', storeSlugForOrders);
    params.set('page', String(ordersCurrentPage));
    if (ordersSearchQuery) params.set('oq', ordersSearchQuery);
    params.set('osort', `${ordersSortCol}:${ordersSortDir}`);
    const statusValues = ordersFilters.get('status');
    params.set('ostatus', encodeList(statusValues ? [...statusValues] : []));

    let data: { ok: boolean; items?: Parameters<typeof buildOrderCard>[0][]; page?: number; totalPages?: number; total?: number };
    try {
      const res = await fetch(`/api/seller/orders?${params.toString()}`);
      data = await res.json() as typeof data;
    } catch { return; }
    if (!data.ok) return;

    ordersCurrentPage = data.page ?? 1;
    list.innerHTML = (data.items ?? []).map(buildOrderCard).join('');
    list.querySelectorAll<HTMLElement>('.order-card').forEach(bindOrderCard);
    initImageSkeletons('.dash-img-skel', list);

    const total = data.total ?? 0;
    const emptyEl = document.getElementById('orders-filter-empty');
    if (emptyEl) emptyEl.hidden = total !== 0;
    refreshOrdersFilterBadge();
    renderOrdersPaginationControls(data.totalPages ?? 1);
  }

  function renderOrdersPaginationControls(totalPages: number): void {
    const nav = document.getElementById('orders-pagination') as HTMLElement | null;
    if (!nav) return;
    if (totalPages <= 1) { nav.hidden = true; nav.innerHTML = ''; return; }
    const pageInfo = (tt('paginationPageInfo'))
      .replace('{page}', String(ordersCurrentPage)).replace('{total}', String(totalPages));
    nav.hidden = false;
    nav.innerHTML = `
      <button type="button" class="btn btn--ghost btn--sm disabled:opacity-40 disabled:cursor-default" data-page-prev${ordersCurrentPage <= 1 ? ' disabled' : ''}>${esc(tt('paginationPrev'))}</button>
      <span class="text-[0.82rem] whitespace-nowrap [color:var(--color-muted)]">${esc(pageInfo)}</span>
      <button type="button" class="btn btn--ghost btn--sm disabled:opacity-40 disabled:cursor-default" data-page-next${ordersCurrentPage >= totalPages ? ' disabled' : ''}>${esc(tt('paginationNext'))}</button>
    `;
  }

  function initOrdersPagination(): void {
    const nav = document.getElementById('orders-pagination') as HTMLElement | null;
    if (!nav) return;
    ordersCurrentPage = parseInt(nav.dataset.page ?? '1', 10) || 1;
    renderOrdersPaginationControls(parseInt(nav.dataset.totalPages ?? '1', 10) || 1);
    nav.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('[data-page-prev], [data-page-next]');
      if (!btn || btn.disabled) return;
      ordersCurrentPage += btn.hasAttribute('data-page-prev') ? -1 : 1;
      applyOrdersPagination();
      const list = document.getElementById('orders-list');
      if (list) scrollBelowPinnedChrome(list);
    });
  }
  initOrdersPagination();
  // What this tab re-runs when another tab of the same store changes something
  // (tab-sync.ts) — the same re-fetch its own toolbar uses, so the seller's page,
  // search, sort and filters survive a cross-tab refresh exactly as they do here.
  registerPanelRefresh('dash-panel-orders', applyOrdersPagination);

  // The cards the SERVER rendered. The panel is `hidden` until its tab is opened, so nothing in
  // it has fetched an image yet — which is exactly when a shimmer is worth arming.
  initImageSkeletons('.dash-img-skel', document.getElementById('orders-list') ?? document);

  const ordersSearchInput = document.getElementById('orders-search-input') as HTMLInputElement | null;
  ordersSearchInput?.addEventListener('input', debounce(() => {
    ordersSearchQuery = ordersSearchInput.value.trim();
    ordersCurrentPage = 1;
    applyOrdersPagination();
  }, 300));

  // ── Poll for new orders every 15s ────────────────────────────
  const ordersList = document.getElementById('orders-list');
  if (ordersList && storeSlugForOrders) {
    const knownIds = new Set<string>();

    async function fetchStoreOrders(): Promise<Parameters<typeof buildOrderCard>[0][] | null> {
      try {
        const res = await fetch(`/api/seller/orders?storeSlug=${encodeURIComponent(storeSlugForOrders)}`);
        if (!res.ok) return null;
        const { orders } = await res.json() as { orders: Parameters<typeof buildOrderCard>[0][] };
        return orders;
      } catch { return null; }
    }

    async function pollOrders(): Promise<void> {
      if (!ordersList) return;
      try {
        const orders = await fetchStoreOrders();
        if (!orders) return;
        const newOrders = orders.filter(o => !knownIds.has(o.id));
        if (!newOrders.length) return;
        newOrders.forEach(o => {
          knownIds.add(o.id);
          // Only insert into the visible list on page 1 — the sorted-by-
          // recency assumption an insertBefore(firstChild) relies on only
          // holds there once orders are paginated (same reasoning as the
          // admin dashboard's own Messages tab live-poll). Toast/badge still
          // fire regardless of which page the seller is looking at.
          if (ordersCurrentPage === 1) {
            const tmp = document.createElement('div');
            tmp.innerHTML = buildOrderCard(o);
            const card = tmp.firstElementChild as HTMLElement | null;
            if (card) {
              ordersList.insertBefore(card, ordersList.firstChild);
              bindOrderCard(card);
              initImageSkeletons('.dash-img-skel', card);
              if (!rowMatchesOrderFilters(card)) card.style.display = 'none';
            }
          }
          const storeSub = o.storeSubtotals[storeSlugForOrders] ?? { subtotalAgorot: 0, shippingAgorot: 0 };
          window.dispatchEvent(new CustomEvent('toast:show', { detail: {
            title: tt('orderNewToastTitle'),
            body: tt('orderNewToastBody')
              .replace('{name}', o.buyerName)
              .replace('{amount}', fmtAgorot(storeSliceTotalAgorot(storeSub))),
            key: o.id,
            href: '/seller/dashboard?panel=orders',
          } }));
        });
        // Trim page 1 back to the server page size (15) — poll inserts land
        // at the top regardless of how many accumulate mid-session.
        if (ordersCurrentPage === 1) {
          Array.from(ordersList.querySelectorAll<HTMLElement>('.order-card')).slice(15).forEach((c) => c.remove());
        }
        updateOrderTabBadge();
      } catch { /* ignore */ }
    }

    // Seed knownIds from the *full* store order list (not just the DOM's
    // rendered page-1 cards, which pagination caps at 15) before the poll
    // loop starts — otherwise every order beyond page 1 looks "new" on the
    // first tick after every page load, firing a toast for each one (real
    // bug: was seeding from `.order-card` elements in the DOM).
    fetchStoreOrders().then((orders) => {
      (orders ?? []).forEach((o) => knownIds.add(o.id));
      setInterval(pollOrders, 15000);
    });
  }

  // ── Edit Order Details Modal ─────────────────────────────────
  const editOrderModal    = document.getElementById('edit-order-modal') as HTMLDialogElement | null;
  const editOrderForm     = document.getElementById('edit-order-form') as HTMLFormElement | null;
  const editOrderError    = document.getElementById('edit-order-error') as HTMLElement | null;
  const editOrderSuccess  = document.getElementById('edit-order-success') as HTMLElement | null;
  const editOrderSaveBtn  = document.getElementById('edit-order-save') as HTMLButtonElement | null;

  type EomItem = { productId: string; productName: string; priceAgorot: number; qty: number; image?: string; storeSlug?: string };


  function renderEomItems(items: EomItem[]) {
    const list = document.getElementById('eom-items-list');
    if (!list) return;
    if (!items.length) { list.innerHTML = `<p style="color:var(--color-muted);font-size:0.82rem;margin:0">${escEom(tt('orderEditNoItems'))}</p>`; return; }
    list.innerHTML = items.map((item) => `
      <div class="eom-item" data-pid="${escEom(item.productId)}" data-price-agorot="${escEom(String(item.priceAgorot))}" data-qty="${escEom(String(item.qty))}">
        ${item.image
          ? `<span class="eom-item__img-wrap dash-img-skel" data-skeleton><img class="eom-item__img" src="${escEom(cdnThumb(item.image, 68, 68))}" alt="" width="34" height="34" loading="lazy" decoding="async"></span>`
          : `<div class="eom-item__img-ph" aria-hidden="true"></div>`}
        <span class="eom-item__name" title="${escEom(item.productName)}">${escEom(item.productName)}</span>
        <span class="eom-item__meta">${fmtAgorot(item.priceAgorot)} × ${item.qty}</span>
        <button type="button" class="eom-item__del" aria-label="${escEom(tt('orderEditDeleteItem'))}" title="${escEom(tt('orderEditDeleteItem'))}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join('');

    initImageSkeletons('.dash-img-skel', list);

    list.querySelectorAll<HTMLButtonElement>('.eom-item__del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest<HTMLElement>('.eom-item');
        if (!row) return;
        const wasDeleted = row.classList.contains('eom-item--deleted');
        row.classList.toggle('eom-item--deleted', !wasDeleted);
        btn.setAttribute('title', wasDeleted ? tt('orderEditDeleteItem') : tt('orderEditUndoDelete'));
        btn.setAttribute('aria-label', wasDeleted ? tt('orderEditDeleteItem') : tt('orderEditUndoDelete'));
        updateDiscountPreview();
      });
    });
  }

  // ── Discount type toggle ──────────────────────────────────
  let eomDiscountType: 'percent' | 'amount' = 'percent';

  const eomPctBtn = document.getElementById('eom-dtype-pct') as HTMLButtonElement | null;
  const eomAmtBtn = document.getElementById('eom-dtype-amt') as HTMLButtonElement | null;
  const eomDiscountInput   = document.getElementById('eom-discount-val') as HTMLInputElement | null;
  const eomDiscountPreview = document.getElementById('eom-discount-preview') as HTMLElement | null;
  const eomShippingAmountEl = document.getElementById('eom-shipping-amount') as HTMLElement | null;
  let eomCurrentShippingAgorot = 0;

  function setDiscountType(type: 'percent' | 'amount') {
    eomDiscountType = type;
    eomPctBtn?.classList.toggle('eom-dtype-btn--active', type === 'percent');
    eomAmtBtn?.classList.toggle('eom-dtype-btn--active', type === 'amount');
    updateDiscountPreview();
  }
  eomPctBtn?.addEventListener('click', () => setDiscountType('percent'));
  eomAmtBtn?.addEventListener('click', () => setDiscountType('amount'));
  eomDiscountInput?.addEventListener('input', updateDiscountPreview);

  /**
   * The base this discount applies to, in agorot: the surviving lines only.
   *
   * **Read off data attributes, not off the rendered text.** It used to re-parse the price out of
   * each row's label with `/([\d,]+)\s*₪\s*×\s*(\d+)/` — and `[\d,]+` stops at a decimal point,
   * so a 19.99 ₪ line was read as 19 and every preview on a catalogue with agorot in its prices
   * was quietly low. The number is right there in the data now, as an integer, and there is
   * nothing to parse.
   *
   * **Shipping is NOT in the base.** The server discounts against the subtotal alone and says why
   * at length (/api/seller/orders): shipping is the platform's rate, not the seller's margin.
   * Adding it here made the preview promise a bigger discount than the save applied — the seller
   * read one number before pressing the button and a different one after.
   */
  function calcEomBaseAgorot(): number {
    let subtotal = 0;
    document.querySelectorAll<HTMLElement>('#eom-items-list .eom-item:not(.eom-item--deleted)').forEach((row) => {
      const price = parseInt(row.dataset.priceAgorot ?? '0', 10) || 0;
      const qty   = parseInt(row.dataset.qty ?? '0', 10) || 0;
      subtotal += price * qty;
    });
    return subtotal;
  }

  function updateDiscountPreview() {
    if (!eomDiscountPreview) return;
    const val = parseFloat(eomDiscountInput?.value ?? '0') || 0;
    if (!val) { eomDiscountPreview.textContent = ''; return; }
    const base = calcEomBaseAgorot();
    // The same two expressions the endpoint uses, including `Math.round` on the percentage —
    // a preview that rounds differently from the save is a preview that lies by an agora.
    const applied = eomDiscountType === 'percent'
      ? Math.min(Math.round(base * Math.round(val) / 100), base)
      : Math.min(Math.round(val * 100), base);
    eomDiscountPreview.textContent = applied > 0 ? `= −${fmtAgorot(applied)}` : '';
  }

  /**
   * The buyer block as this modal was opened with it, so the save can send ONLY what the
   * seller actually changed.
   *
   * The dashboard is routinely open in several tabs (tab-sync.ts). This form submits the
   * whole buyer block, so a tab whose modal was opened before another tab fixed the phone
   * would carry the old phone along with the one field it did change — and quietly undo
   * it. Sending just the edited fields removes the problem at the source: the endpoint
   * already applies each field only when it is present, so an untouched field is not
   * merely un-overwritten, it is never mentioned.
   */
  let eomOpenedWith: Record<string, string> = {};

  function openEditOrderModal(btn: HTMLElement) {
    if (!editOrderModal) return;
    eomOpenedWith = {
      name:   btn.dataset.buyerName   ?? '',
      email:  btn.dataset.buyerEmail  ?? '',
      phone:  btn.dataset.buyerPhone  ?? '',
      street: btn.dataset.buyerStreet ?? '',
      city:   btn.dataset.buyerCity   ?? '',
      zip:    btn.dataset.buyerZip    ?? '',
      discountType:  btn.dataset.discountType ?? 'percent',
      discountValue: btn.dataset.discountValue ?? '0',
    };
    (document.getElementById('edit-order-id') as HTMLInputElement).value = btn.dataset.orderId ?? '';
    (document.getElementById('edit-order-store-slug') as HTMLInputElement).value = btn.dataset.storeSlug ?? '';
    (document.getElementById('eob-name') as HTMLInputElement).value    = btn.dataset.buyerName   ?? '';
    (document.getElementById('eob-email') as HTMLInputElement).value   = btn.dataset.buyerEmail  ?? '';
    (document.getElementById('eob-phone') as HTMLInputElement).value   = btn.dataset.buyerPhone  ?? '';
    (document.getElementById('eob-street') as HTMLInputElement).value  = btn.dataset.buyerStreet ?? '';
    (document.getElementById('eob-city') as HTMLInputElement).value    = btn.dataset.buyerCity   ?? '';
    (document.getElementById('eob-zip') as HTMLInputElement).value     = btn.dataset.buyerZip    ?? '';
    eomCurrentShippingAgorot = parseInt(btn.dataset.shippingAgorot ?? '0', 10) || 0;
    if (eomShippingAmountEl) eomShippingAmountEl.textContent = eomCurrentShippingAgorot > 0 ? `· ${fmtAgorot(eomCurrentShippingAgorot)}` : `· ${tt('orderShippingFree')}`;
    // Restore existing discount
    const existingDtype = (btn.dataset.discountType ?? 'percent') as 'percent' | 'amount';
    const existingDval  = btn.dataset.discountValue ?? '0';
    setDiscountType(existingDtype);
    if (eomDiscountInput) eomDiscountInput.value = existingDval === '0' ? '' : existingDval;
    if (editOrderError)   { editOrderError.style.display   = 'none'; editOrderError.textContent   = ''; }
    if (editOrderSuccess) { editOrderSuccess.style.display = 'none'; }
    try { renderEomItems(JSON.parse(btn.dataset.items ?? '[]') as EomItem[]); } catch { renderEomItems([]); }
    updateDiscountPreview();
    editOrderModal.showModal();
    (document.getElementById('eob-name') as HTMLInputElement | null)?.focus();
  }

  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.order-edit-buyer-btn');
    if (btn) { e.stopPropagation(); openEditOrderModal(btn); }
  });

  document.getElementById('edit-order-modal-close')?.addEventListener('click', () => editOrderModal?.close());
  document.getElementById('edit-order-cancel')?.addEventListener('click', () => editOrderModal?.close());
  editOrderModal?.addEventListener('click', (e) => { if (e.target === editOrderModal) editOrderModal.close(); });

  editOrderForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editOrderSaveBtn) return;
    const orderId   = (document.getElementById('edit-order-id') as HTMLInputElement).value;
    const storeSlug = (document.getElementById('edit-order-store-slug') as HTMLInputElement).value;
    const name   = (document.getElementById('eob-name') as HTMLInputElement).value.trim();
    const email  = (document.getElementById('eob-email') as HTMLInputElement).value.trim();
    const phone  = (document.getElementById('eob-phone') as HTMLInputElement).value.trim();
    const street = (document.getElementById('eob-street') as HTMLInputElement).value.trim();
    const city   = (document.getElementById('eob-city') as HTMLInputElement).value.trim();
    const zip    = (document.getElementById('eob-zip') as HTMLInputElement).value.trim();

    if (!name || !city || !street) {
      if (editOrderError) { editOrderError.textContent = tt('orderEditRequired'); editOrderError.style.display = 'block'; }
      return;
    }

    // Collect deleted item IDs
    const itemDeletes: string[] = [];
    document.querySelectorAll<HTMLElement>('#eom-items-list .eom-item--deleted').forEach((row) => {
      if (row.dataset.pid) itemDeletes.push(row.dataset.pid);
    });

    // Discount
    const discountVal = parseFloat(eomDiscountInput?.value ?? '') || 0;
    const discount = discountVal > 0
      ? { type: eomDiscountType, value: discountVal }
      : null;

    editOrderSaveBtn.disabled = true;
    if (editOrderError) editOrderError.style.display = 'none';

    // Only what actually changed since the modal opened (see eomOpenedWith). The address
    // travels as one object because that is how it is stored and edited — all three parts
    // go if any of them moved. An omitted field is left exactly as it stands on the server.
    const addressChanged = city !== eomOpenedWith.city || street !== eomOpenedWith.street || zip !== eomOpenedWith.zip;
    const openedDiscountValue = parseFloat(eomOpenedWith.discountValue ?? '0') || 0;
    const discountChanged = discountVal !== openedDiscountValue
      || (discountVal > 0 && eomDiscountType !== eomOpenedWith.discountType);
    const payload: Record<string, unknown> = { orderId, storeSlug };
    if (name !== eomOpenedWith.name) payload['buyerName'] = name;
    if (email !== eomOpenedWith.email) payload['buyerEmail'] = email;
    if (phone !== eomOpenedWith.phone) payload['buyerPhone'] = phone;
    if (addressChanged) payload['buyerAddress'] = { city, street, zip };
    if (itemDeletes.length) payload['itemDeletes'] = itemDeletes;
    if (discountChanged) payload['discount'] = discount;

    // Opened, looked, saved: nothing to send, and the endpoint would answer "no valid
    // fields to update" — an error message for having changed his mind. Just close.
    if (Object.keys(payload).length === 2) {
      editOrderSaveBtn.disabled = false;
      editOrderModal?.close();
      return;
    }

    try {
      const res = await fetch('/api/seller/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        if (editOrderError) { editOrderError.textContent = err.error ?? tt('orderEditSaveError'); editOrderError.style.display = 'block'; }
        return;
      }
      const { order: savedOrder } = await res.json() as { order: { buyerName: string; buyerEmail: string; buyerPhone: string; buyerAddress: { city: string; street: string; zip?: string }; items: EomItem[]; storeSubtotals: Record<string, { subtotalAgorot: number; shippingAgorot: number }>; totalAgorot: number } };

      // Update the order card in DOM
      const card = document.querySelector<HTMLElement>(`.order-card[data-order-id="${CSS.escape(orderId)}"]`);
      if (card && savedOrder) {
        const buyerNameEl = card.querySelector('.order-buyer-name strong');
        const buyerEmailEl = card.querySelector('.order-buyer-email');
        const buyerPhoneEl = card.querySelector('.order-buyer-phone');
        const buyerAddrEl  = card.querySelector('.order-buyer-address');
        if (buyerNameEl) buyerNameEl.textContent = savedOrder.buyerName;
        if (buyerEmailEl) buyerEmailEl.textContent = savedOrder.buyerEmail;
        if (buyerPhoneEl) buyerPhoneEl.textContent = `${tt('orderPhone')}: ${savedOrder.buyerPhone}`;
        if (buyerAddrEl) { const a = savedOrder.buyerAddress; buyerAddrEl.textContent = `${tt('orderAddress')}: ${a.street}, ${a.city}${a.zip ? ` ${a.zip}` : ''}`; }

        // Update items list in card
        const cardItemsEl = card.querySelector('.order-card__items');
        if (cardItemsEl && savedOrder.items) {
          const storeItems = savedOrder.items.filter((i) => i.storeSlug === storeSlug);
          cardItemsEl.innerHTML = storeItems.map((item) => `
            <li class="flex items-center gap-2.5 text-sm">
              ${item.image ? orderItemThumbHtml(item.image) : ''}
              <span class="flex-1 text-[color:var(--color-text)]">${escEom(item.productName)}</span>
              <span class="text-[color:var(--color-muted)] text-[0.8rem]">×${item.qty}</span>
              <span class="font-bold text-[color:var(--color-text)] ms-auto">${fmtAgorot(item.priceAgorot * item.qty)}</span>
            </li>`).join('');
          initImageSkeletons('.dash-img-skel', cardItemsEl);
        }
        // Update subtotal display
        const storeSub = savedOrder.storeSubtotals?.[storeSlug] as { subtotalAgorot: number; shippingAgorot: number; discount?: { type: string; value: number; appliedAgorot: number } } | undefined;
        if (storeSub) {
          const discApplied = storeSub.discount?.appliedAgorot ?? 0;
          const total = storeSliceTotalAgorot(storeSub);
          const subtotalsEl = card.querySelector<HTMLElement>('.order-card__subtotals');
          if (subtotalsEl) {
            subtotalsEl.innerHTML = `
              <span>${esc(tt('orderShipping'))}: ${storeSub.shippingAgorot === 0 ? esc(tt('orderShippingFree')) : fmtAgorot(storeSub.shippingAgorot)}</span>
              ${discApplied > 0 ? `<span class="text-[color:var(--color-success)]">${escEom(tt('orderEditDiscount'))}: −${fmtAgorot(discApplied)}</span>` : ''}
              <strong class="text-[color:var(--color-text)] text-[0.9375rem]">${esc(tt('orderTotal'))}: ${fmtAgorot(total)}</strong>`;
          }
          const amountEl = card.querySelector('.order-card__amount');
          if (amountEl) amountEl.textContent = fmtAgorot(total);
        }

        // Update edit button data attributes
        const editBtn = card.querySelector<HTMLElement>('.order-edit-buyer-btn');
        if (editBtn && savedOrder) {
          editBtn.dataset.buyerName     = savedOrder.buyerName;
          editBtn.dataset.buyerEmail    = savedOrder.buyerEmail;
          editBtn.dataset.buyerPhone    = savedOrder.buyerPhone;
          editBtn.dataset.buyerStreet   = savedOrder.buyerAddress.street;
          editBtn.dataset.buyerCity     = savedOrder.buyerAddress.city;
          editBtn.dataset.buyerZip      = savedOrder.buyerAddress.zip ?? '';
          editBtn.dataset.shippingAgorot = String(storeSub?.shippingAgorot ?? 0);
          editBtn.dataset.discountType  = storeSub?.discount?.type ?? 'percent';
          editBtn.dataset.discountValue = String(storeSub?.discount?.value ?? 0);
          if (savedOrder.items) editBtn.dataset.items = JSON.stringify(savedOrder.items.filter((i: EomItem) => i.storeSlug === storeSlug));
        }
      }

      if (editOrderSuccess) { editOrderSuccess.style.display = 'block'; }
      setTimeout(() => { editOrderModal?.close(); if (editOrderSuccess) editOrderSuccess.style.display = 'none'; }, 1400);
    } catch {
      if (editOrderError) { editOrderError.textContent = tt('orderEditNetworkError'); editOrderError.style.display = 'block'; }
    } finally {
      editOrderSaveBtn.disabled = false;
    }
  });
}
