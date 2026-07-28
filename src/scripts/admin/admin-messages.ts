import { escapeHtml } from '../../lib/html-escape.js';
import { formatHeDateTime } from '../../lib/format-date.js';
import { initAdminMsgSellerDropdown, resetAdminMsgSellerDropdown } from './admin-msg-seller-dropdown.js';
import { ADMIN_PAGE_SIZE } from '../../lib/pagination.js';
import { buildAdminUrl, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { showErrorToast } from '../../lib/toast.js';

const PANEL_ID = 'dash-panel-messages';
const messagesPortal = createFloatingPortal('admin-messages-toolbar-portal');

interface AdminMsgSellerInfo { id: string; name: string; email: string }
interface AdminMsg { id: string; sellerId: string; fromRole: 'admin' | 'seller'; content: string; createdAt: string }
// A thread = one subject-titled conversation with a seller (a seller can have
// several) — keyed by the root message's id, NOT by sellerId as it was while
// admin<->seller messaging was a single flat per-seller conversation.
interface AdminThreadInfo { id: string; sellerId: string; subject: string; lastMessage: AdminMsg; unreadForAdmin: number }
interface KnownThread { sellerId: string; subject: string; lastMessageId: string; unreadForAdmin: number }

function setRowUnread(row: HTMLElement, unread: boolean): void {
  const fromTd = row.querySelector('.msg-table__td--from');
  const existingMarker = fromTd?.querySelector('.msg-unread-sr');
  row.classList.toggle('msg-table__row--unread', unread);
  if (unread && fromTd && !existingMarker) {
    const span = document.createElement('span');
    span.className = 'visually-hidden msg-unread-sr';
    span.textContent = 'לא נקרא · ';
    fromTd.insertBefore(span, fromTd.firstChild);
  } else if (!unread) {
    existingMarker?.remove();
  }
}

function updateRowPreview(row: HTMLElement, message: AdminMsg): void {
  const previewTd = row.querySelector('.msg-table__td--preview');
  if (previewTd) {
    previewTd.innerHTML = `${escapeHtml(message.content)}${message.fromRole === 'admin' ? ' <span class="msg-table__preview-you">(אתה)</span>' : ''}`;
  }
  const dateTd = row.querySelector('.msg-table__td--date');
  if (dateTd) dateTd.textContent = formatHeDateTime(message.createdAt);
}

// The tab strip's "(N)" badge (see admin/index.astro's tabs.map) is
// computed server-side on load; this keeps it live as the 15s poll below
// learns about new/read messages without needing a full reload. All other
// tabs' badges are static per-page-load (see admin-tab-views.ts) — Messages
// is the one exception because it already has this poll infrastructure and
// an exact per-message unread signal.
function refreshTabDot(known: Map<string, KnownThread>): void {
  let total = 0;
  for (const v of known.values()) total += v.unreadForAdmin;
  setTabMessagesCount(total);
}

function setTabMessagesCount(count: number): void {
  const span = document.getElementById('tab-count-messages');
  if (!span) return;
  span.hidden = count === 0;
  span.textContent = count > 0 ? `(${count})` : '';
}

function bubbleHtml(m: AdminMsg): string {
  const who = m.fromRole === 'admin' ? 'אתה' : 'מוכר/ת';
  return `<div class="msg-thread-entry ${m.fromRole === 'admin' ? 'msg-thread-entry--seller' : 'msg-thread-entry--buyer'}">
    <div class="msg-thread-entry__header"><span class="msg-thread-entry__who">${escapeHtml(who)}</span><span class="msg-thread-entry__date">${escapeHtml(formatHeDateTime(m.createdAt))}</span></div>
    <div class="msg-thread-entry__body">${escapeHtml(m.content)}</div>
  </div>`;
}

function wireThreadRow(row: HTMLElement, known: Map<string, KnownThread>): void {
  const threadId = row.dataset.threadId ?? '';
  const threadRow = document.getElementById(`admin-msg-detail-${threadId}`) as HTMLTableRowElement | null;
  const repliesEl = document.getElementById(`admin-msg-replies-${threadId}`);
  let isOpen = false;
  let loaded = false;

  function loadThread() {
    fetch(`/api/admin/messages?threadId=${encodeURIComponent(threadId)}`)
      .then((r) => r.json())
      .then(({ messages }: { messages?: AdminMsg[] }) => {
        if (!repliesEl || !messages) return;
        repliesEl.innerHTML = messages.map(bubbleHtml).join('');
        loaded = true;
        if (row.classList.contains('msg-table__row--unread')) {
          row.classList.remove('msg-table__row--unread');
          row.querySelector('.msg-unread-sr')?.remove();
          const entry = known.get(threadId);
          if (entry) { entry.unreadForAdmin = 0; refreshTabDot(known); }
          fetch('/api/admin/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'mark-read', threadId }),
          }).catch(() => {});
        }
        threadRow?.querySelector<HTMLElement>('[data-reply-for-thread]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      })
      .catch(() => {});
  }

  function open() {
    if (!threadRow) return;
    threadRow.hidden = false;
    row.setAttribute('aria-expanded', 'true');
    isOpen = true;
    if (!loaded) loadThread();
  }
  function close() {
    if (!threadRow) return;
    threadRow.hidden = true;
    row.setAttribute('aria-expanded', 'false');
    isOpen = false;
  }

  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    isOpen ? close() : open();
  });
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen ? close() : open(); }
  });

  const replyForm = threadRow?.querySelector<HTMLElement>('[data-reply-for-thread]');
  if (replyForm) {
    const textarea = replyForm.querySelector<HTMLTextAreaElement>('textarea')!;
    const sendBtn  = replyForm.querySelector<HTMLButtonElement>('.seller-msg-reply-send')!;
    const closeBtn = replyForm.querySelector<HTMLButtonElement>('.seller-msg-reply-close')!;
    closeBtn.addEventListener('click', () => { close(); row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    sendBtn.addEventListener('click', async () => {
      const content = textarea.value.trim();
      if (!content) return;
      sendBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, content }),
        });
        const data = await res.json() as { message?: AdminMsg };
        if (res.ok && data.message && repliesEl) {
          repliesEl.insertAdjacentHTML('beforeend', bubbleHtml(data.message));
          updateRowPreview(row, data.message);
          textarea.value = '';
          moveRowToTop(row);
          const prev = known.get(threadId);
          known.set(threadId, { sellerId: prev?.sellerId ?? row.dataset.sellerId ?? '', subject: prev?.subject ?? '', lastMessageId: data.message.id, unreadForAdmin: 0 });
        }
      } catch { /* ignore */ } finally {
        sendBtn.disabled = false;
      }
    });
  }
}

// groupAdminThreads() sorts threads by most-recently-active first —
// moves a row (and its paired detail row) back to the top after a send/reply
// so the client-side order keeps matching that same rule without a reload.
function moveRowToTop(row: HTMLElement): void {
  const tbody = row.parentElement;
  const threadRow = row.nextElementSibling;
  if (!tbody || !threadRow?.classList.contains('msg-thread-row')) return;
  tbody.prepend(row, threadRow);
}

// A brand-new thread prepended to page 1 by the live poll (see
// pollAdminMessages) isn't backed by a server-side reload, so nothing else
// caps the tbody back down to what the server would actually render as page
// 1 — without this, a long-open session can silently accumulate more than
// ADMIN_PAGE_SIZE rows.
function trimToPageSize(): void {
  const tbody = document.querySelector('#admin-msg-table tbody');
  if (!tbody) return;
  const mainRows = [...tbody.querySelectorAll<HTMLElement>('.msg-table__row')];
  for (const row of mainRows.slice(ADMIN_PAGE_SIZE)) {
    const threadRow = row.nextElementSibling;
    if (threadRow?.classList.contains('msg-thread-row')) threadRow.remove();
    row.remove();
  }
}

function insertThreadRow(threadId: string, sellerId: string, subject: string, seller: AdminMsgSellerInfo | undefined, message: AdminMsg, unread = false): HTMLElement | null {
  const table = document.getElementById('admin-msg-table');
  const tbody = table?.querySelector('tbody');
  if (!tbody) return null;
  const label = seller ? `${seller.name} (${seller.email})` : sellerId;
  const previewTag = message.fromRole === 'admin' ? ' <span class="msg-table__preview-you">(אתה)</span>' : '';
  const unreadMarker = unread ? '<span class="visually-hidden msg-unread-sr">לא נקרא · </span>' : '';
  const rowHtml = `<tr class="msg-table__row${unread ? ' msg-table__row--unread' : ''}" data-thread-id="${escapeHtml(threadId)}" data-seller-id="${escapeHtml(sellerId)}" tabindex="0" role="button" aria-expanded="false">
    <td class="msg-table__td msg-table__td--status"></td>
    <td class="msg-table__td msg-table__td--from">${unreadMarker}${escapeHtml(label)}</td>
    <td class="msg-table__td msg-table__td--subject">${escapeHtml(subject)}</td>
    <td class="msg-table__td msg-table__td--preview">${escapeHtml(message.content)}${previewTag}</td>
    <td class="msg-table__td msg-table__td--date">${escapeHtml(formatHeDateTime(message.createdAt))}</td>
    <td class="msg-table__td msg-table__td--actions">
      <button class="seller-msg-delete" data-delete-thread-id="${escapeHtml(threadId)}" data-thread-subject="${escapeHtml(subject)}" type="button" aria-label="מחק שיחה" title="מחק שיחה">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </td>
  </tr>
  <tr class="msg-thread-row" id="admin-msg-detail-${escapeHtml(threadId)}" hidden>
    <td colspan="6">
      <div class="msg-thread" id="admin-msg-replies-${escapeHtml(threadId)}">${bubbleHtml(message)}</div>
      <div class="seller-msg-reply-form" data-reply-for-thread="${escapeHtml(threadId)}" style="padding:0.75rem 1rem;border-top:1px solid var(--color-border)">
        <textarea class="seller-msg-reply-textarea" placeholder="כתוב תשובה..." rows="3"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button class="seller-msg-reply-close" type="button">סגור שיחה</button>
          <button class="seller-msg-reply-send" type="button">שלח</button>
        </div>
      </div>
    </td>
  </tr>`;
  tbody.insertAdjacentHTML('afterbegin', rowHtml);
  return tbody.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`);
}

// Polls for messages the admin didn't just send themselves (a seller reply
// arriving, or a brand-new seller thread) — the admin's own sends already
// update the DOM immediately via the handlers above, this only covers what
// those can't see. Mirrors the seller dashboard's pollSellerUnread pattern.
// `onPage1` gates only the "insert as a brand-new row" branch — threads are
// sorted most-recent-first, so a thread missing from the DOM only means
// "genuinely new" when the table is showing its newest page; off page 1 it
// more likely just means "lives on a different page," and inserting it here
// would be wrong. A row that IS in the current page's DOM, though — however
// many new messages arrive, wherever the admin has that page's table open —
// is always safe to refresh in place regardless of page number, including
// live-appending into an already-open thread and auto-marking it read.
function pollAdminMessages(sellers: Map<string, AdminMsgSellerInfo>, known: Map<string, KnownThread>, onPage1: boolean): void {
  fetch('/api/admin/messages')
    .then((r) => r.json())
    .then(({ threads }: { threads: AdminThreadInfo[] }) => {
      for (const t of threads) {
        const prev = known.get(t.id);
        const isNewMessage = !prev || prev.lastMessageId !== t.lastMessage.id;
        known.set(t.id, { sellerId: t.sellerId, subject: t.subject, lastMessageId: t.lastMessage.id, unreadForAdmin: t.unreadForAdmin });
        if (!isNewMessage) continue;

        const row = document.querySelector<HTMLElement>(`#admin-msg-table [data-thread-id="${CSS.escape(t.id)}"]`);
        if (!row) {
          if (onPage1) {
            document.getElementById('admin-msg-empty')?.remove();
            const wrap = document.getElementById('admin-msg-table-wrap');
            if (wrap) wrap.hidden = false;
            const newRow = insertThreadRow(t.id, t.sellerId, t.subject, sellers.get(t.sellerId), t.lastMessage, t.unreadForAdmin > 0);
            if (newRow) wireThreadRow(newRow, known);
            trimToPageSize();
          }
          continue;
        }

        updateRowPreview(row, t.lastMessage);
        moveRowToTop(row);

        const threadRow = document.getElementById(`admin-msg-detail-${t.id}`) as HTMLTableRowElement | null;
        const isOpen = threadRow ? !threadRow.hidden : false;
        if (isOpen) {
          fetch(`/api/admin/messages?threadId=${encodeURIComponent(t.id)}`)
            .then((r2) => r2.json())
            .then(({ messages }: { messages?: AdminMsg[] }) => {
              const repliesEl = document.getElementById(`admin-msg-replies-${t.id}`);
              if (repliesEl && messages) repliesEl.innerHTML = messages.map(bubbleHtml).join('');
            })
            .catch(() => {});
          if (t.unreadForAdmin > 0) {
            fetch('/api/admin/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'mark-read', threadId: t.id }),
            }).catch(() => {});
            known.set(t.id, { sellerId: t.sellerId, subject: t.subject, lastMessageId: t.lastMessage.id, unreadForAdmin: 0 });
          }
          setRowUnread(row, false);
        } else {
          setRowUnread(row, t.unreadForAdmin > 0);
        }
      }

      refreshTabDot(known);
    })
    .catch(() => {});
}

// Deleting a thread wipes it for the seller too, so it always routes through
// the global confirm dialog (ConfirmModal.astro) — same treatment as blocking
// a store in admin/stores.ts. Event-delegated on document so a row inserted
// later by the poll or the compose box needs no separate bind — which also
// means it must bind exactly ONCE, since initAdminMessagesPanel() re-runs on
// every panel swap and a second listener would fire a second confirm dialog.
// The listener reads the LIVE known-threads map through this ref rather than
// closing over one — a panel swap builds a fresh map, and a listener holding
// the first one would keep updating a map nothing else reads any more.
let currentKnownThreads: Map<string, KnownThread> = new Map();
let deleteWired = false;
function wireThreadDelete(): void {
  if (deleteWired) return;
  deleteWired = true;
  document.addEventListener('click', (e) => {
    const known = currentKnownThreads;
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-thread-id]');
    if (!btn) return;
    e.stopPropagation(); // don't also toggle the row open
    const threadId = btn.dataset.deleteThreadId ?? '';
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: 'למחוק את השיחה?',
        message: `"${btn.dataset.threadSubject ?? ''}" תימחק גם אצל המוכר/ת, ללא אפשרות שחזור.`,
        okLabel: 'מחק שיחה',
        workingLabel: 'מוחק…',
        onConfirm: async () => {
          try {
            const res = await fetch('/api/admin/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', threadId }),
            });
            if (!res.ok) throw new Error('request failed');
            const row = btn.closest('tr');
            const threadRow = row?.nextElementSibling;
            if (threadRow?.classList.contains('msg-thread-row')) threadRow.remove();
            row?.remove();
            // Drop it from `known` too — refreshTabDot sums that map, so a
            // deleted thread's unread count would otherwise stay in the badge.
            known.delete(threadId);
            refreshTabDot(known);
          } catch {
            showErrorToast('המחיקה נכשלה, נסו שוב');
          }
        },
      },
    }));
  });
}

type ThreadSortCol = 'recent' | 'unread';
const THREAD_SORT_OPTIONS: { col: ThreadSortCol; label: string }[] = [
  { col: 'recent', label: 'עדכון אחרון' },
  { col: 'unread', label: 'לא נקראו קודם' },
];

function wireMessagesToolbar(): void {
  const root = document.getElementById('admin-messages-toolbar');
  if (!root) return;

  const state = root.dataset;
  let sortCol = (state.sortCol as ThreadSortCol) || 'recent';
  let unreadOnly = state.unreadOnly === '1';

  function navigate(): void {
    const url = buildAdminUrl('messages', {
      msort: sortCol !== 'recent' ? sortCol : undefined,
      munread: unreadOnly ? '1' : undefined,
    });
    swapPanel(url, PANEL_ID, () => initAdminMessagesPanel());
  }

  const sortTrigger = document.getElementById('admin-messages-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (messagesPortal.currentTrigger() === sortTrigger) { messagesPortal.close(); return; }
    messagesPortal.open(sortTrigger, '13rem', () => THREAD_SORT_OPTIONS.map((o) => {
      const selected = o.col === sortCol;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${o.col}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortCol = (btn.dataset.sortCol as ThreadSortCol) ?? 'recent';
          navigate();
        });
      });
    });
  });

  const unreadToggle = document.getElementById('admin-messages-unread-toggle') as HTMLButtonElement | null;
  unreadToggle?.addEventListener('click', () => {
    unreadOnly = !unreadOnly;
    navigate();
  });
}

export function initAdminMessagesPanel(): void {
  wireMessagesToolbar();
  wirePanelLinks(PANEL_ID, () => initAdminMessagesPanel());
  wirePopstateReload();

  const i18nEl = document.getElementById('admin-msg-i18n');
  const sellerList: AdminMsgSellerInfo[] = i18nEl?.dataset.sellers ? JSON.parse(i18nEl.dataset.sellers) : [];
  const sellers = new Map(sellerList.map((s) => [s.id, s]));
  const threadsSeed: ({ threadId: string } & KnownThread)[] =
    i18nEl?.dataset.threadsSeed ? JSON.parse(i18nEl.dataset.threadsSeed) : [];
  const knownThreads = new Map(threadsSeed.map((t) => [t.threadId, { sellerId: t.sellerId, subject: t.subject, lastMessageId: t.lastMessageId, unreadForAdmin: t.unreadForAdmin }]));
  currentKnownThreads = knownThreads;
  wireThreadDelete();
  const onPage1 = (i18nEl?.dataset.page ?? '1') === '1';

  initAdminMsgSellerDropdown(sellers);

  const composeToggle = document.getElementById('admin-msg-compose-toggle') as HTMLButtonElement | null;
  const composeEl = document.getElementById('admin-msg-compose');
  composeToggle?.addEventListener('click', () => {
    if (!composeEl) return;
    const open = composeEl.hidden;
    composeEl.hidden = !open;
    composeToggle.setAttribute('aria-expanded', String(open));
    if (open) composeEl.querySelector<HTMLElement>('.admin-msg-seller-dd__btn')?.focus();
  });

  document.querySelectorAll<HTMLElement>('#admin-msg-table [data-thread-id]').forEach((row) => wireThreadRow(row, knownThreads));

  const sendNewBtn = document.getElementById('admin-msg-send-new') as HTMLButtonElement | null;
  const sellerSelect = document.getElementById('admin-msg-seller-select') as HTMLInputElement | null;
  const subjectInput = document.getElementById('admin-msg-new-subject') as HTMLInputElement | null;
  const contentInput = document.getElementById('admin-msg-new-content') as HTMLTextAreaElement | null;

  // Composing always opens a NEW thread — an existing conversation is
  // continued from its own row's reply box, never from here.
  sendNewBtn?.addEventListener('click', async () => {
    const sellerId = sellerSelect?.value ?? '';
    const subject = subjectInput?.value.trim() ?? '';
    const content = contentInput?.value.trim() ?? '';
    if (!sellerId || !subject || !content) return;
    sendNewBtn.disabled = true;
    try {
      const res = await fetch('/api/admin/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerId, subject, content }),
      });
      const data = await res.json() as { message?: AdminMsg; threadId?: string };
      if (res.ok && data.message && data.threadId) {
        document.getElementById('admin-msg-empty')?.remove();
        const wrap = document.getElementById('admin-msg-table-wrap');
        if (wrap) wrap.hidden = false;
        const newRow = insertThreadRow(data.threadId, sellerId, subject, sellers.get(sellerId), data.message);
        if (newRow) wireThreadRow(newRow, knownThreads);
        trimToPageSize();
        knownThreads.set(data.threadId, { sellerId, subject, lastMessageId: data.message.id, unreadForAdmin: 0 });
        if (contentInput) contentInput.value = '';
        if (subjectInput) subjectInput.value = '';
        if (sellerSelect) sellerSelect.value = '';
        resetAdminMsgSellerDropdown();
        if (composeEl) composeEl.hidden = true;
        composeToggle?.setAttribute('aria-expanded', 'false');
      }
    } catch { /* ignore */ } finally {
      sendNewBtn.disabled = false;
    }
  });

  setInterval(() => pollAdminMessages(sellers, knownThreads, onPage1), 15000);
}
