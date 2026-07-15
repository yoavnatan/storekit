let statusTimer: ReturnType<typeof setTimeout>;

export function showStatus(msg: string, isError = false): void {
  let el = document.getElementById('ajax-status');
  if (!el) {
    el = document.createElement('p');
    el.id = 'ajax-status';
    document.querySelector('.products-header')?.after(el);
  }
  el.className = isError
    ? 'dash-error bg-[#fef2f2] text-[color:var(--color-danger)] py-2 px-[.85rem] rounded-[var(--radius)] border border-[#fecaca] text-sm mb-4'
    : 'dash-success bg-[#f0fdf4] text-[#166534] py-2 px-[.85rem] rounded-[var(--radius)] border border-[#bbf7d0] text-sm mb-4';
  el.textContent = msg;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el?.remove(), 3000);
}
