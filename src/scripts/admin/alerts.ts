import { buildAdminUrl, debounce, encodeList, decodeList, swapPanel, wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { openRangePicker } from '../../lib/toolbar-range-picker.js';
import { showErrorToast } from '../../lib/toast.js';

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
  const severitySet = new Set((state.severity ?? '').split(',').filter(Boolean));
  const storeSet = new Set(decodeList(state.store ?? ''));
  const storeOptions: { slug: string; name: string }[] = JSON.parse(state.storeOptions ?? '[]');
  let newOnly = state.newOnly === '1';
  // Held as locals like every other control here, so no control can drop another's state — the
  // reason this toolbar reads itself back off the DOM the server just rendered.
  let from = state.from ?? '';
  let to = state.to ?? '';

  function navigate(afterSwap?: () => void): void {
    const url = buildAdminUrl('alerts', {
      alsort: sortDir !== 'desc' ? sortDir : undefined,
      alsource: sourceSet.size ? [...sourceSet].join(',') : undefined,
      alsev: severitySet.size ? [...severitySet].join(',') : undefined,
      alstore: storeSet.size ? encodeList([...storeSet]) : undefined,
      // Read off the LIVE input rather than a captured local: this is the one control that changes
      // between keystrokes, and a chip clicked mid-typing must carry what is on screen.
      alq: (document.getElementById('admin-alerts-search') as HTMLInputElement | null)?.value.trim() || undefined,
      alfrom: from || undefined,
      alto: to || undefined,
      alnew: newOnly ? '1' : undefined,
    });
    swapPanel(url, PANEL_ID, () => {
      initAdminAlertsPanel();
      afterSwap?.();
    });
  }

  // Refocuses itself after the swap (the input node is replaced) so typing continues uninterrupted
  // — same as the money journal's and the Orders tab's search boxes.
  const search = document.getElementById('admin-alerts-search') as HTMLInputElement | null;
  search?.addEventListener('input', debounce(() => navigate(() => {
    const fresh = document.getElementById('admin-alerts-search') as HTMLInputElement | null;
    if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
  }), 250));

  const rangeTrigger = document.getElementById('admin-alerts-range-trigger') as HTMLButtonElement | null;
  rangeTrigger?.addEventListener('click', () => {
    if (alertsPortal.currentTrigger() === rangeTrigger) { alertsPortal.close(); return; }
    // The panel is `lib/toolbar-range-picker.ts`, shared with the money journal. "נקה" really does
    // mean everything here: unlike the journal, this tab has no default window.
    openRangePicker(alertsPortal, rangeTrigger, {
      from, to,
      clearLabel: 'כל התאריכים',
      onApply: (r) => { from = r.from; to = r.to; navigate(); },
      onClear: () => { from = ''; to = ''; navigate(); },
    });
  });

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

  const newToggle = document.getElementById('admin-alerts-new-toggle') as HTMLButtonElement | null;
  newToggle?.addEventListener('click', () => {
    newOnly = !newOnly;
    navigate();
  });

  root.querySelectorAll<HTMLButtonElement>('.admin-alerts-source-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.sourceValue!;
      if (sourceSet.has(v)) sourceSet.delete(v); else sourceSet.add(v);
      navigate();
    });
  });

  // Same toggle shape as the source chips above — a chip is its own filter, and an empty set means
  // "no severity filter" rather than "none of them", which is what makes the default show everything.
  root.querySelectorAll<HTMLButtonElement>('.admin-alerts-severity-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.severityValue!;
      if (severitySet.has(v)) severitySet.delete(v); else severitySet.add(v);
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
      // Tint the HEAD row while its details are showing (owner, 2026-08-07). The details row sits
      // directly below its own head row and is the only thing on screen that changes, so with a
      // long list open there was nothing tying the panel of text to the line it belongs to — and
      // the moment the pointer moved away even the hover tint was gone. Same grey as hover, so it
      // reads as "this is the one" rather than as a new colour with a new meaning.
      const headRow = detailsRow.previousElementSibling as HTMLElement | null;
      if (headRow?.hasAttribute('data-alert-row')) headRow.toggleAttribute('data-open', !isOpen);
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
  // Wiping the log is irreversible, so it routes through the global confirm
  // dialog (ConfirmModal.astro) like every other destructive admin action —
  // never the browser's native confirm().
  clearBtn?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: 'לנקות את יומן השגיאות?',
        message: 'כל הרשומות יימחקו לצמיתות, ללא אפשרות שחזור.',
        okLabel: 'נקה יומן',
        workingLabel: 'מנקה…',
        onConfirm: async () => {
          clearBtn.disabled = true;
          try {
            const res = await fetch('/api/admin/errors', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'clear' }),
            });
            if (!res.ok) throw new Error('request failed');
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
          } catch {
            showErrorToast('ניקוי היומן נכשל, נסו שוב');
          } finally {
            clearBtn.disabled = false;
          }
        },
      },
    }));
  });
}
