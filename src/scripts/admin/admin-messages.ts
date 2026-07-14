import { escapeHtml } from '../../lib/html-escape.js';
import { formatHeDateTime } from '../../lib/format-date.js';
import { initAdminMsgSellerDropdown, resetAdminMsgSellerDropdown } from './admin-msg-seller-dropdown.js';

interface AdminMsgSellerInfo { id: string; name: string; email: string }
interface AdminMsg { id: string; sellerId: string; fromRole: 'admin' | 'seller'; content: string; createdAt: string }
interface AdminThreadSummary { sellerId: string; lastMessage: AdminMsg; unreadForAdmin: number }

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

function refreshTabDot(known: Map<string, { lastMessageId: string; unreadForAdmin: number }>): void {
  let total = 0;
  for (const v of known.values()) total += v.unreadForAdmin;
  setTabMessagesDot(total);
}

function setTabMessagesDot(count: number): void {
  const tab = document.getElementById('tab-messages');
  if (!tab) return;
  let dot = tab.querySelector<HTMLElement>('.admin-msg-tab-dot');
  if (count > 0) {
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'admin-msg-tab-dot';
      dot.style.cssText = 'position:absolute;top:0.45rem;inset-inline-end:0.6rem;width:7px;height:7px;background:var(--color-danger);border-radius:50%';
      tab.appendChild(dot);
    }
    dot.setAttribute('aria-label', `${count} הודעות שלא נקראו`);
  } else {
    dot?.remove();
  }
}

function bubbleHtml(m: AdminMsg): string {
  const who = m.fromRole === 'admin' ? 'אתה' : 'מוכר/ת';
  return `<div class="msg-thread-entry ${m.fromRole === 'admin' ? 'msg-thread-entry--seller' : 'msg-thread-entry--buyer'}">
    <div class="msg-thread-entry__header"><span class="msg-thread-entry__who">${escapeHtml(who)}</span><span class="msg-thread-entry__date">${escapeHtml(formatHeDateTime(m.createdAt))}</span></div>
    <div class="msg-thread-entry__body">${escapeHtml(m.content)}</div>
  </div>`;
}

function wireThreadRow(row: HTMLElement, sellers: Map<string, AdminMsgSellerInfo>, known: Map<string, { lastMessageId: string; unreadForAdmin: number }>): void {
  const sellerId = row.dataset.sellerId ?? '';
  const threadRow = document.getElementById(`admin-msg-detail-${sellerId}`) as HTMLTableRowElement | null;
  const repliesEl = document.getElementById(`admin-msg-replies-${sellerId}`);
  let isOpen = false;
  let loaded = false;

  function loadThread() {
    fetch(`/api/admin/messages?sellerId=${sellerId}`)
      .then((r) => r.json())
      .then(({ messages }: { messages: AdminMsg[] }) => {
        if (!repliesEl) return;
        repliesEl.innerHTML = messages.map(bubbleHtml).join('');
        loaded = true;
        if (row.classList.contains('msg-table__row--unread')) {
          row.classList.remove('msg-table__row--unread');
          row.querySelector('.msg-unread-sr')?.remove();
          const entry = known.get(sellerId);
          if (entry) { entry.unreadForAdmin = 0; refreshTabDot(known); }
          fetch('/api/admin/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'mark-read', sellerId }),
          }).catch(() => {});
        }
        threadRow?.querySelector<HTMLElement>('[data-reply-for-seller]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  const replyForm = threadRow?.querySelector<HTMLElement>('[data-reply-for-seller]');
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
          body: JSON.stringify({ sellerId, content }),
        });
        const data = await res.json() as { message?: AdminMsg };
        if (res.ok && data.message && repliesEl) {
          repliesEl.insertAdjacentHTML('beforeend', bubbleHtml(data.message));
          updateRowPreview(row, data.message);
          textarea.value = '';
          moveRowToTop(row);
          known.set(sellerId, { lastMessageId: data.message.id, unreadForAdmin: 0 });
        }
      } catch { /* ignore */ } finally {
        sendBtn.disabled = false;
      }
    });
  }
}

// getAdminThreadSummaries() sorts threads by most-recently-active first —
// moves a row (and its paired detail row) back to the top after a send/reply
// so the client-side order keeps matching that same rule without a reload.
function moveRowToTop(row: HTMLElement): void {
  const tbody = row.parentElement;
  const threadRow = row.nextElementSibling;
  if (!tbody || !threadRow?.classList.contains('msg-thread-row')) return;
  tbody.prepend(row, threadRow);
}

function insertThreadRow(sellerId: string, seller: AdminMsgSellerInfo | undefined, message: AdminMsg, unread = false): HTMLElement | null {
  const table = document.getElementById('admin-msg-table');
  const tbody = table?.querySelector('tbody');
  if (!tbody) return null;
  const label = seller ? `${seller.name} (${seller.email})` : sellerId;
  const previewTag = message.fromRole === 'admin' ? ' <span class="msg-table__preview-you">(אתה)</span>' : '';
  const unreadMarker = unread ? '<span class="visually-hidden msg-unread-sr">לא נקרא · </span>' : '';
  const rowHtml = `<tr class="msg-table__row${unread ? ' msg-table__row--unread' : ''}" data-seller-id="${escapeHtml(sellerId)}" tabindex="0" role="button" aria-expanded="false">
    <td class="msg-table__td msg-table__td--status"></td>
    <td class="msg-table__td msg-table__td--from">${unreadMarker}${escapeHtml(label)}</td>
    <td class="msg-table__td msg-table__td--preview">${escapeHtml(message.content)}${previewTag}</td>
    <td class="msg-table__td msg-table__td--date">${escapeHtml(formatHeDateTime(message.createdAt))}</td>
  </tr>
  <tr class="msg-thread-row" id="admin-msg-detail-${escapeHtml(sellerId)}" hidden>
    <td colspan="4">
      <div class="msg-thread" id="admin-msg-replies-${escapeHtml(sellerId)}">${bubbleHtml(message)}</div>
      <div class="seller-msg-reply-form" data-reply-for-seller="${escapeHtml(sellerId)}" style="padding:0.75rem 1rem;border-top:1px solid var(--color-border)">
        <textarea class="seller-msg-reply-textarea" placeholder="כתוב תשובה..." rows="3"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button class="seller-msg-reply-close" type="button">סגור שיחה</button>
          <button class="seller-msg-reply-send" type="button">שלח</button>
        </div>
      </div>
    </td>
  </tr>`;
  tbody.insertAdjacentHTML('afterbegin', rowHtml);
  return tbody.querySelector<HTMLElement>(`[data-seller-id="${CSS.escape(sellerId)}"]`);
}

// Polls for messages the admin didn't just send themselves (a seller reply
// arriving, or a brand-new seller thread) — the admin's own sends already
// update the DOM immediately via the handlers above, this only covers what
// those can't see. Mirrors the seller dashboard's pollSellerUnread pattern.
function pollAdminMessages(sellers: Map<string, AdminMsgSellerInfo>, known: Map<string, { lastMessageId: string; unreadForAdmin: number }>): void {
  fetch('/api/admin/messages')
    .then((r) => r.json())
    .then(({ threads }: { threads: AdminThreadSummary[] }) => {
      for (const t of threads) {
        const prev = known.get(t.sellerId);
        const isNewMessage = !prev || prev.lastMessageId !== t.lastMessage.id;
        known.set(t.sellerId, { lastMessageId: t.lastMessage.id, unreadForAdmin: t.unreadForAdmin });
        if (!isNewMessage) continue;

        const row = document.querySelector<HTMLElement>(`#admin-msg-table [data-seller-id="${CSS.escape(t.sellerId)}"]`);
        if (!row) {
          document.getElementById('admin-msg-empty')?.remove();
          const wrap = document.getElementById('admin-msg-table-wrap');
          if (wrap) wrap.hidden = false;
          const newRow = insertThreadRow(t.sellerId, sellers.get(t.sellerId), t.lastMessage, t.unreadForAdmin > 0);
          if (newRow) wireThreadRow(newRow, sellers, known);
          continue;
        }

        updateRowPreview(row, t.lastMessage);
        moveRowToTop(row);

        const threadRow = document.getElementById(`admin-msg-detail-${t.sellerId}`) as HTMLTableRowElement | null;
        const isOpen = threadRow ? !threadRow.hidden : false;
        if (isOpen) {
          fetch(`/api/admin/messages?sellerId=${t.sellerId}`)
            .then((r2) => r2.json())
            .then(({ messages }: { messages: AdminMsg[] }) => {
              const repliesEl = document.getElementById(`admin-msg-replies-${t.sellerId}`);
              if (repliesEl) repliesEl.innerHTML = messages.map(bubbleHtml).join('');
            })
            .catch(() => {});
          if (t.unreadForAdmin > 0) {
            fetch('/api/admin/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'mark-read', sellerId: t.sellerId }),
            }).catch(() => {});
            known.set(t.sellerId, { lastMessageId: t.lastMessage.id, unreadForAdmin: 0 });
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

export function initAdminMessagesPanel(): void {
  const i18nEl = document.getElementById('admin-msg-i18n');
  const sellerList: AdminMsgSellerInfo[] = i18nEl?.dataset.sellers ? JSON.parse(i18nEl.dataset.sellers) : [];
  const sellers = new Map(sellerList.map((s) => [s.id, s]));
  const threadsSeed: { sellerId: string; lastMessageId: string; unreadForAdmin: number }[] =
    i18nEl?.dataset.threadsSeed ? JSON.parse(i18nEl.dataset.threadsSeed) : [];
  const knownThreads = new Map(threadsSeed.map((t) => [t.sellerId, { lastMessageId: t.lastMessageId, unreadForAdmin: t.unreadForAdmin }]));

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

  document.querySelectorAll<HTMLElement>('#admin-msg-table [data-seller-id]').forEach((row) => wireThreadRow(row, sellers, knownThreads));

  const sendNewBtn = document.getElementById('admin-msg-send-new') as HTMLButtonElement | null;
  const sellerSelect = document.getElementById('admin-msg-seller-select') as HTMLInputElement | null;
  const contentInput = document.getElementById('admin-msg-new-content') as HTMLTextAreaElement | null;

  sendNewBtn?.addEventListener('click', async () => {
    const sellerId = sellerSelect?.value ?? '';
    const content = contentInput?.value.trim() ?? '';
    if (!sellerId || !content) return;
    sendNewBtn.disabled = true;
    try {
      const res = await fetch('/api/admin/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerId, content }),
      });
      const data = await res.json() as { message?: AdminMsg };
      if (res.ok && data.message) {
        const existingRow = document.querySelector<HTMLElement>(`#admin-msg-table [data-seller-id="${CSS.escape(sellerId)}"]`);
        if (existingRow) {
          document.getElementById(`admin-msg-replies-${sellerId}`)?.insertAdjacentHTML('beforeend', bubbleHtml(data.message));
          updateRowPreview(existingRow, data.message);
          moveRowToTop(existingRow);
        } else {
          document.getElementById('admin-msg-empty')?.remove();
          const wrap = document.getElementById('admin-msg-table-wrap');
          if (wrap) wrap.hidden = false;
          const newRow = insertThreadRow(sellerId, sellers.get(sellerId), data.message);
          if (newRow) wireThreadRow(newRow, sellers, knownThreads);
        }
        knownThreads.set(sellerId, { lastMessageId: data.message.id, unreadForAdmin: 0 });
        if (contentInput) contentInput.value = '';
        if (sellerSelect) sellerSelect.value = '';
        resetAdminMsgSellerDropdown();
        if (composeEl) composeEl.hidden = true;
        composeToggle?.setAttribute('aria-expanded', 'false');
      }
    } catch { /* ignore */ } finally {
      sendNewBtn.disabled = false;
    }
  });

  setInterval(() => pollAdminMessages(sellers, knownThreads), 15000);
}
