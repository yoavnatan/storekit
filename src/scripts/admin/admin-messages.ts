import { escapeHtml } from '../../lib/html-escape.js';
import { formatHeDateTime } from '../../lib/format-date.js';
import { initAdminMsgSellerDropdown, resetAdminMsgSellerDropdown } from './admin-msg-seller-dropdown.js';

interface AdminMsgSellerInfo { id: string; name: string; email: string }
interface AdminMsg { id: string; sellerId: string; fromRole: 'admin' | 'seller'; content: string; createdAt: string }

function bubbleHtml(m: AdminMsg): string {
  const who = m.fromRole === 'admin' ? 'אתה' : 'מוכר/ת';
  return `<div class="msg-thread-entry ${m.fromRole === 'admin' ? 'msg-thread-entry--seller' : 'msg-thread-entry--buyer'}">
    <div class="msg-thread-entry__header"><span class="msg-thread-entry__who">${escapeHtml(who)}</span><span class="msg-thread-entry__date">${escapeHtml(formatHeDateTime(m.createdAt))}</span></div>
    <div class="msg-thread-entry__body">${escapeHtml(m.content)}</div>
  </div>`;
}

function wireThreadRow(row: HTMLElement, sellers: Map<string, AdminMsgSellerInfo>): void {
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
          const previewTd = row.querySelector('.msg-table__td--preview');
          if (previewTd) previewTd.innerHTML = `${escapeHtml(content)} <span class="msg-table__preview-you">(אתה)</span>`;
          const dateTd = row.querySelector('.msg-table__td--date');
          if (dateTd) dateTd.textContent = formatHeDateTime(data.message.createdAt);
          textarea.value = '';
          moveRowToTop(row);
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

function insertThreadRow(sellerId: string, seller: AdminMsgSellerInfo | undefined, message: AdminMsg): HTMLElement | null {
  const table = document.getElementById('admin-msg-table');
  const tbody = table?.querySelector('tbody');
  if (!tbody) return null;
  const label = seller ? `${seller.name} (${seller.email})` : sellerId;
  const rowHtml = `<tr class="msg-table__row" data-seller-id="${escapeHtml(sellerId)}" tabindex="0" role="button" aria-expanded="false">
    <td class="msg-table__td msg-table__td--status"></td>
    <td class="msg-table__td msg-table__td--from">${escapeHtml(label)}</td>
    <td class="msg-table__td msg-table__td--preview">${escapeHtml(message.content)} <span class="msg-table__preview-you">(אתה)</span></td>
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

export function initAdminMessagesPanel(): void {
  const i18nEl = document.getElementById('admin-msg-i18n');
  const sellerList: AdminMsgSellerInfo[] = i18nEl?.dataset.sellers ? JSON.parse(i18nEl.dataset.sellers) : [];
  const sellers = new Map(sellerList.map((s) => [s.id, s]));

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

  document.querySelectorAll<HTMLElement>('#admin-msg-table [data-seller-id]').forEach((row) => wireThreadRow(row, sellers));

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
          const previewTd = existingRow.querySelector('.msg-table__td--preview');
          if (previewTd) previewTd.innerHTML = `${escapeHtml(content)} <span class="msg-table__preview-you">(אתה)</span>`;
          const dateTd = existingRow.querySelector('.msg-table__td--date');
          if (dateTd) dateTd.textContent = formatHeDateTime(data.message.createdAt);
          moveRowToTop(existingRow);
        } else {
          document.getElementById('admin-msg-empty')?.remove();
          const wrap = document.getElementById('admin-msg-table-wrap');
          if (wrap) wrap.hidden = false;
          const newRow = insertThreadRow(sellerId, sellers.get(sellerId), data.message);
          if (newRow) wireThreadRow(newRow, sellers);
        }
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
}
