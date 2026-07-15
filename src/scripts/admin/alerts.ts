export function initAdminAlertsPanel(): void {
  const table = document.getElementById('admin-alerts-table');
  table?.addEventListener('click', (e) => {
    const detailsBtn = (e.target as HTMLElement).closest('.admin-alerts-details-btn') as HTMLButtonElement | null;
    if (detailsBtn) {
      const detailsRow = document.getElementById(detailsBtn.getAttribute('aria-controls') ?? '');
      if (!detailsRow) return;
      const isOpen = detailsBtn.getAttribute('aria-expanded') === 'true';
      detailsBtn.setAttribute('aria-expanded', String(!isOpen));
      detailsRow.hidden = isOpen;
      return;
    }

    const copyBtn = (e.target as HTMLElement).closest('.admin-alerts-copy-btn') as HTMLButtonElement | null;
    if (copyBtn) {
      const text = copyBtn.dataset.copyText ?? '';
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('admin-alerts-copy-btn--done');
        setTimeout(() => copyBtn.classList.remove('admin-alerts-copy-btn--done'), 1200);
      }).catch(() => { /* clipboard permission denied — nothing more we can do */ });
    }
  });

  const clearBtn = document.getElementById('admin-alerts-clear') as HTMLButtonElement | null;
  clearBtn?.addEventListener('click', async () => {
    if (!confirm('לנקות את כל יומן השגיאות?')) return;
    clearBtn.disabled = true;
    try {
      const res = await fetch('/api/admin/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });
      if (res.ok) {
        document.getElementById('admin-alerts-wrap')?.remove();
        clearBtn.remove();
        const toolbar = document.querySelector('.admin-alerts-toolbar');
        if (toolbar && !document.getElementById('admin-alerts-empty')) {
          const p = document.createElement('p');
          p.className = 'admin-empty';
          p.id = 'admin-alerts-empty';
          p.textContent = 'אין שגיאות רשומות.';
          toolbar.insertAdjacentElement('afterend', p);
        }
      }
    } catch { /* ignore */ } finally {
      clearBtn.disabled = false;
    }
  });
}
