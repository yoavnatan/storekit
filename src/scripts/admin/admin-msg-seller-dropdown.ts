interface AdminMsgSellerInfo { id: string; name: string; email: string }

const SELLER_DD_PLACEHOLDER = 'בחר/י מוכר/ת...';

export function resetAdminMsgSellerDropdown(): void {
  const label = document.getElementById('admin-msg-seller-dd-label');
  if (label) label.textContent = SELLER_DD_PLACEHOLDER;
  document.querySelectorAll('#admin-msg-seller-dd-menu [role="option"]').forEach((opt) => opt.setAttribute('aria-selected', 'false'));
}

// Custom listbox dropdown replacing a native <select> — matches the
// "Dropdown design system" hard rule (same look/spring as the seller
// dashboard's store-switcher) rather than an unstyleable native control.
// A hidden input (#admin-msg-seller-select) still carries the chosen seller
// id so the rest of admin-messages.ts's send logic doesn't need to change.
export function initAdminMsgSellerDropdown(sellers: Map<string, AdminMsgSellerInfo>): void {
  const dd     = document.getElementById('admin-msg-seller-dd');
  const btn    = document.getElementById('admin-msg-seller-dd-btn') as HTMLButtonElement | null;
  const menu   = document.getElementById('admin-msg-seller-dd-menu') as HTMLElement | null;
  const label  = document.getElementById('admin-msg-seller-dd-label');
  const hidden = document.getElementById('admin-msg-seller-select') as HTMLInputElement | null;
  if (!dd || !btn || !menu || !label || !hidden) return;

  function selectSeller(sellerId: string): void {
    const seller = sellers.get(sellerId);
    hidden!.value = sellerId;
    label!.textContent = seller ? `${seller.name} (${seller.email})` : SELLER_DD_PLACEHOLDER;
    menu!.querySelectorAll<HTMLButtonElement>('[role="option"]').forEach((opt) => {
      opt.setAttribute('aria-selected', String(opt.dataset.sellerId === sellerId));
    });
  }

  function open(): void {
    menu!.hidden = false;
    btn!.setAttribute('aria-expanded', 'true');
    const items = menu!.querySelectorAll<HTMLButtonElement>('[role="option"]');
    (menu!.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? items[0])?.focus();
  }
  function close(returnFocus = true): void {
    menu!.hidden = true;
    btn!.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn?.focus();
  }

  btn.addEventListener('click', () => (menu.hidden ? open() : close(false)));
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target as Node) && !menu.hidden) close(false);
  });
  btn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const idx   = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  menu.querySelectorAll<HTMLButtonElement>('[role="option"]').forEach((opt) => {
    opt.addEventListener('click', () => { selectSeller(opt.dataset.sellerId ?? ''); close(); });
  });

  // Deep-link from a seller card's "שלח הודעה" link (AdminSellersPanel):
  // /admin?panel=messages&sellerId=<id> — pre-select that seller and bring
  // the composer into view instead of leaving the picker empty.
  const preselect = new URLSearchParams(window.location.search).get('sellerId');
  if (preselect && sellers.has(preselect)) {
    selectSeller(preselect);
    dd.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('admin-msg-new-content')?.focus();
  }
}
