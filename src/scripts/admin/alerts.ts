export function initAdminAlertsPanel(): void {
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
