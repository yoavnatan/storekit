export function initAdminOrdersFilter(): void {
  const input = document.getElementById('admin-order-search') as HTMLInputElement | null;
  const table = document.getElementById('admin-orders-table');
  const noMatch = document.getElementById('admin-orders-no-match');
  if (!input || !table) return;

  const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')];

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let visibleCount = 0;
    rows.forEach((row) => {
      const match = !q || (row.dataset.orderSearch ?? '').includes(q);
      row.hidden = !match;
      if (match) visibleCount++;
    });
    if (noMatch) noMatch.hidden = visibleCount > 0;
  });
}
