let statusTimer: ReturnType<typeof setTimeout>;

export function showStatus(msg: string, isError = false): void {
  let el = document.getElementById('ajax-status');
  if (!el) {
    el = document.createElement('p');
    el.id = 'ajax-status';
    document.querySelector('.products-header')?.after(el);
  }
  el.className = isError ? 'dash-error' : 'dash-success';
  el.textContent = msg;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el?.remove(), 3000);
}
