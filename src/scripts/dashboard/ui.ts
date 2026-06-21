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
    const fd = new FormData(settingsForm);
    const res = await fetch('/api/store', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; name?: string; error?: string };
    if (!data.ok) { showSettingsStatus(data.error ?? 'Error saving.', true); return; }

    const newName = data.name ?? String(fd.get('name'));
    const heading = document.querySelector('.dash-head h1');
    if (heading) heading.textContent = newName;
    const activeTab = document.querySelector('.store-tab--active');
    if (activeTab) activeTab.textContent = newName;

    showSettingsStatus('Settings saved.');
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

export function initNewStoreForm(): void {
  const toggleNew  = document.getElementById('toggle-new-store');
  const newStoreForm = document.getElementById('new-store-form');
  const cancelNew  = document.getElementById('cancel-new-store');

  toggleNew?.addEventListener('click', () => newStoreForm?.removeAttribute('hidden'));
  cancelNew?.addEventListener('click', () => newStoreForm?.setAttribute('hidden', ''));
}

export function initSettingsCollapsible(): void {
  const settingsHeader = document.getElementById('settings-header');
  const settingsBodyEl = document.getElementById('settings-body');

  settingsHeader?.addEventListener('click', () => {
    const open = !!settingsBodyEl?.hidden;
    if (settingsBodyEl) settingsBodyEl.hidden = !open;
    settingsHeader.setAttribute('aria-expanded', String(open));
  });

  settingsHeader?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settingsHeader.click(); }
  });
}

export function initAutoHideStatus(): void {
  document.querySelectorAll<HTMLElement>('.dash-success, .dash-error').forEach((el) => {
    setTimeout(() => el.remove(), 3000);
  });
}
