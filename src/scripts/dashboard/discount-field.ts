// Behaviour for the per-product discount block (lib/discount-field.ts builds its markup).
//
// Delegated from the document, not bound per element: the products table rebuilds its edit forms
// client-side on every search/sort/page, so anything bound at init would be lost on the first
// re-render. One listener covers every block that exists now or later.
//
// The block answers the only question a seller actually has while setting a discount — "what will
// the price be?" — by resolving it with the SAME discounts.ts the storefront and checkout use,
// rather than re-implementing the arithmetic here.

import { resolvePrice, type DiscountType } from '../../lib/discounts.js';
import { formatPrice } from '../../config/store.config.js';
import { initSelectDropdown, refreshSelectDropdown } from './select-dropdown.js';

function refresh(field: HTMLElement): void {
  const typeSel = field.querySelector<HTMLSelectElement>('[data-discount-type]');
  const valueInput = field.querySelector<HTMLInputElement>('[data-discount-value]');
  const valueField = field.querySelector<HTMLElement>('[data-discount-value-field]');
  const details = field.querySelectorAll<HTMLElement>('[data-discount-detail]');
  const preview = field.querySelector<HTMLElement>('[data-discount-preview]');
  if (!typeSel) return;

  const active = typeSel.value === 'percent' || typeSel.value === 'amount';
  if (valueField) valueField.hidden = !active;
  details.forEach((el) => { el.hidden = !active; });
  // Clearing the number as the seller switches to "no discount" is what makes the server read
  // it as a removal — a leftover value with an empty type would be an inert half-record.
  if (!active && valueInput) valueInput.value = '';

  if (!preview) return;

  // The bulk dialog has no price field of its own — it applies ONE discount across many products
  // at many prices, so there is no single "price after discount" to show. Hide the line rather
  // than leaving an empty one reserving space under the controls.
  const priceInput = field.closest('form')?.querySelector<HTMLInputElement>('[name="price"]');
  preview.hidden = !active || !priceInput;
  if (!active || !priceInput) return;

  const price = Number(priceInput.value ?? 0);
  const value = Number(valueInput?.value ?? 0);
  const view = resolvePrice({ price, discount: { type: typeSel.value as DiscountType, value } });
  preview.textContent = view.isDiscounted
    ? `${preview.dataset.label ?? ''}: ${formatPrice(view.price)} (-${view.percentOff}%)`
    : '';
}

export function initDiscountFields(): void {
  const handler = (e: Event): void => {
    const field = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-discount-field]');
    if (field) refresh(field);
    // A price edit changes the discounted result too, and the price input sits outside the block.
    else if ((e.target as HTMLInputElement | null)?.name === 'price') {
      (e.target as HTMLElement).closest('form')
        ?.querySelectorAll<HTMLElement>('[data-discount-field]').forEach(refresh);
    }
  };
  document.addEventListener('input', handler);
  document.addEventListener('change', handler);

  // Paint the readout for the blocks already on the page.
  refreshDiscountFieldsIn(document);
}

/** Called by products.ts after it rebuilds a row's edit form, so the new block starts painted —
 *  and its type select gets the site's dropdown rather than the OS one. initSelectDropdown
 *  self-guards against a double bind, so this is safe to call on already-wired blocks. */
export function refreshDiscountFieldsIn(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-discount-field]').forEach((field) => {
    const select = field.querySelector<HTMLSelectElement>('[data-discount-type]');
    if (select) {
      initSelectDropdown(select);
      // A programmatic `.value` write (the bulk panel prefilling from the selection) fires no
      // `change`, so the portal trigger would keep showing the previous option's label.
      refreshSelectDropdown(select);
    }
    refresh(field);
  });
}
