import { scrollBelowPinnedChrome } from './scroll-utils.js';

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
  // **Bring the message to the seller, do not hope it is already there (reported 2026-08-03).**
  // Two things were wrong with `scrollIntoView({block:'nearest'})` here. `nearest` does nothing
  // when the element is technically "in view" — including when it is sitting UNDER the products
  // table's sticky header, which is exactly where it lands — so after adding a product the form
  // collapsed and the confirmation was never seen; the seller had to scroll up to find out whether
  // it had worked at all. And native `behavior:'smooth'` is banned on this RTL site: it drifts
  // `scrollX` off 0 mid-animation and cannot be corrected (see scroll-utils.ts / animateScrollTo).
  // `scrollBelowPinnedChrome` exists for precisely this — it parks the target clear of every
  // pinned layer above it.
  scrollBelowPinnedChrome(el);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el?.remove(), 3000);
}
