// Store/product block toggle — admin-only kill switch (see moderation.ts).
// Optimistic DOM update (button label + badge) so the accordion doesn't
// collapse/reload; a failed request reverts the button back.
export function initAdminSellersPanel(): void {
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
