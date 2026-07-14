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

// Store/product block toggle — admin-only kill switch (see moderation.ts).
// Optimistic DOM update (button label + badge) so the accordion doesn't
// collapse/reload; a failed request reverts the button back.
export function initAdminSellersPanel(): void {
  wireSellerMessageModal();

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
