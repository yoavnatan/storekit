import { buildAdminUrl, encodeList, decodeList, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const PANEL_ID = 'dash-panel-alerts';
const alertsPortal = createFloatingPortal('admin-alerts-toolbar-portal');

type SortDir = 'asc' | 'desc';
const SORT_OPTIONS: { dir: SortDir; label: string }[] = [
  { dir: 'desc', label: 'תאריך: חדש — ישן' },
  { dir: 'asc', label: 'תאריך: ישן — חדש' },
];

function wireAlertsToolbar(): void {
  const root = document.getElementById('admin-alerts-toolbar-controls');
  if (!root) return;

  const state = root.dataset;
  let sortDir = (state.sortDir as SortDir) || 'desc';
  const sourceSet = new Set((state.source ?? '').split(',').filter(Boolean));
  const storeSet = new Set(decodeList(state.store ?? ''));
  const storeOptions: { slug: string; name: string }[] = JSON.parse(state.storeOptions ?? '[]');

  function navigate(): void {
    const url = buildAdminUrl('alerts', {
      alsort: sortDir !== 'desc' ? sortDir : undefined,
      alsource: sourceSet.size ? [...sourceSet].join(',') : undefined,
      alstore: storeSet.size ? encodeList([...storeSet]) : undefined,
    });
    swapPanel(url, PANEL_ID, () => initAdminAlertsPanel());
  }

  const sortTrigger = document.getElementById('admin-alerts-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (alertsPortal.currentTrigger() === sortTrigger) { alertsPortal.close(); return; }
    alertsPortal.open(sortTrigger, '13rem', () => SORT_OPTIONS.map((o) => {
      const selected = o.dir === sortDir;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-dir="${o.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${o.label}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-sort-dir]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sortDir = (btn.dataset.sortDir as SortDir) ?? 'desc';
          navigate();
        });
      });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('.admin-alerts-source-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.sourceValue!;
      if (sourceSet.has(v)) sourceSet.delete(v); else sourceSet.add(v);
      navigate();
    });
  });

  const storeTrigger = document.getElementById('admin-alerts-store-trigger') as HTMLButtonElement | null;
  storeTrigger?.addEventListener('click', () => {
    if (alertsPortal.currentTrigger() === storeTrigger) { alertsPortal.close(); return; }
    alertsPortal.open(storeTrigger, '13rem', () => [
      ...storeOptions.map((s) => `
        <label class="product-menu__checkbox-item flex items-center gap-[.4rem] py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer text-[.82rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]">
          <input type="checkbox" class="cursor-pointer shrink-0" data-store-value="${s.slug}" ${storeSet.has(s.slug) ? 'checked' : ''} />
          ${s.name}
        </label>`),
      `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
      `<div style="display:flex;gap:0.4rem;padding:0.3rem 0.6rem">
        <button type="button" class="btn btn--ghost btn--sm" data-store-clear style="flex:1">נקה</button>
        <button type="button" class="btn btn--accent btn--sm" data-store-apply style="flex:1">החל</button>
      </div>`,
    ].join(''), (p) => {
      p.querySelectorAll<HTMLInputElement>('[data-store-value]').forEach((cb) => {
        cb.addEventListener('change', () => {
          if (cb.checked) storeSet.add(cb.dataset.storeValue!); else storeSet.delete(cb.dataset.storeValue!);
        });
      });
      p.querySelector('[data-store-clear]')?.addEventListener('click', () => { storeSet.clear(); navigate(); });
      p.querySelector('[data-store-apply]')?.addEventListener('click', () => navigate());
    });
  });
}

export function initAdminAlertsPanel(): void {
  wireAlertsToolbar();
  wirePanelLinks(PANEL_ID, () => initAdminAlertsPanel());
  wirePopstateReload();

  const table = document.getElementById('admin-alerts-table');
  table?.addEventListener('click', (e) => {
    const resolveBtn = (e.target as HTMLElement).closest('.admin-alerts-resolve-btn') as HTMLButtonElement | null;
    if (resolveBtn) {
      const row = resolveBtn.closest('tr[data-alert-row]');
      const id = resolveBtn.dataset.id;
      if (!row || !id) return;
      const wasResolved = resolveBtn.getAttribute('aria-pressed') === 'true';
      const nextResolved = !wasResolved;

      const applyState = (resolved: boolean) => {
        resolveBtn.setAttribute('aria-pressed', String(resolved));
        const label = resolved ? 'בטל סימון כטופל' : 'סמן כטופל';
        resolveBtn.setAttribute('aria-label', label);
        resolveBtn.title = label;
        row.classList.toggle('admin-alerts-row--resolved', resolved);
      };

      applyState(nextResolved); // optimistic
      fetch('/api/admin/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', id, resolved: nextResolved }),
      }).then((res) => {
        if (!res.ok) throw new Error();
      }).catch(() => {
        applyState(wasResolved); // rollback
        window.dispatchEvent(new CustomEvent('toast:show', {
          detail: { title: 'לא ניתן היה לעדכן את סטטוס הטיפול', body: '' },
        }));
      });
      return;
    }

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
