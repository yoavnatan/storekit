const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;

export function initSettingsForm(): void {
  const settingsForm   = document.getElementById('settings-form') as HTMLFormElement | null;
  const settingsStatus = document.getElementById('settings-status') as HTMLElement | null;
  let settingsTimer: ReturnType<typeof setTimeout>;

  function showSettingsStatus(msg: string, isError = false) {
    if (!settingsStatus) return;
    settingsStatus.className = isError ? 'dash-error' : 'dash-success';
    settingsStatus.textContent = msg;
    settingsStatus.hidden = false;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { settingsStatus.hidden = true; }, 3000);
  }

  settingsForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = settingsForm.querySelector<HTMLButtonElement>('[type="submit"]');
    const origText = submitBtn?.textContent ?? '';

    const fd = new FormData(settingsForm);
    const res = await fetch('/api/store', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; name?: string; error?: string };
    if (!data.ok) { showSettingsStatus(data.error ?? 'שגיאה בשמירה.', true); return; }

    const newName = data.name ?? String(fd.get('name'));
    const storeNameEl = document.querySelector<HTMLElement>('.dash-store-name');
    if (storeNameEl) storeNameEl.textContent = newName;

    if (submitBtn) {
      submitBtn.style.minWidth = `${submitBtn.offsetWidth}px`;
      submitBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${checkSvg}נשמר</span>`;
      submitBtn.disabled = true;
      submitBtn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      );
      setTimeout(() => {
        submitBtn.disabled = false;
        submitBtn.style.minWidth = '';
        submitBtn.textContent = origText;
      }, 1500);
    }
  });
}

export function initFormToggles(): void {
  const toggleAdd  = document.getElementById('toggle-add-form');
  const addFormWrap = document.getElementById('add-product-form');
  const cancelAdd  = document.getElementById('cancel-add');

  toggleAdd?.addEventListener('click', () => {
    addFormWrap?.removeAttribute('hidden');
    toggleAdd.setAttribute('hidden', '');
  });
  cancelAdd?.addEventListener('click', () => {
    addFormWrap?.setAttribute('hidden', '');
    toggleAdd?.removeAttribute('hidden');
  });
}

export function initStoreSwitcher(): void {
  const btn  = document.getElementById('store-switcher-btn') as HTMLButtonElement | null;
  const menu = document.getElementById('store-switcher-menu') as HTMLElement | null;
  if (!btn || !menu) return;

  function open() {
    menu!.hidden = false;
    btn!.setAttribute('aria-expanded', 'true');
    (menu!.querySelector<HTMLAnchorElement>('a'))?.focus();
  }

  function close(returnFocus = true) {
    menu!.hidden = true;
    btn!.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn?.focus();
  }

  btn.addEventListener('click', () => menu.hidden ? open() : close(false));

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target as Node) && !menu.contains(e.target as Node)) {
      if (!menu.hidden) close(false);
    }
  });

  btn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const items = [...menu.querySelectorAll<HTMLAnchorElement>('a')];
    const idx   = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

export function initAutoHideStatus(): void {
  document.querySelectorAll<HTMLElement>('.dash-success, .dash-error').forEach((el) => {
    setTimeout(() => el.remove(), 3000);
  });
}

export function initDashTabs(): void {
  const tabs   = document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-panel]');
  const panels = document.querySelectorAll<HTMLElement>('.dash-panel');

  function activateTab(tab: HTMLButtonElement) {
    tabs.forEach(t => {
      t.classList.remove('dash-tab--active');
      t.setAttribute('aria-selected', 'false');
      t.setAttribute('tabindex', '-1');
    });
    panels.forEach(p => { p.hidden = true; });
    tab.classList.add('dash-tab--active');
    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');
    const panel = document.getElementById(`dash-panel-${tab.dataset.panel}`);
    if (panel) panel.hidden = false;
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (e: KeyboardEvent) => {
      const list = [...tabs];
      const idx  = list.indexOf(tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = list[(idx + 1) % list.length] as HTMLButtonElement;
        next.focus(); activateTab(next);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = list[(idx - 1 + list.length) % list.length] as HTMLButtonElement;
        prev.focus(); activateTab(prev);
      }
    });
  });

  tabs.forEach((tab, i) => tab.setAttribute('tabindex', i === 0 ? '0' : '-1'));
}
