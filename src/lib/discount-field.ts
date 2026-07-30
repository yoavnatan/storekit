/** The seller's per-product discount block, as one HTML string.
 *
 *  The product edit form exists TWICE — server-rendered in dashboard.astro, and rebuilt
 *  client-side by scripts/dashboard/products.ts whenever the table re-renders (search, sort,
 *  paging). A field defined in only one of them silently disappears from the other, so this
 *  block is defined once here and both call it (same pattern as price-html.ts).
 *
 *  Pure/isomorphic; every interpolated value is escaped or numeric. The behaviour that makes it
 *  live (show/hide the amount, the "final price" readout) is initDiscountFields() in
 *  scripts/dashboard/discount-field.ts.
 */

import { escapeHtml } from './html-escape.js';
import type { ProductDiscount } from './discounts.js';

export interface DiscountFieldLabels {
  label: string;
  type: string;
  none: string;
  percent: string;
  amount: string;
  value: string;
  starts: string;
  ends: string;
  showBadge: string;
  finalPrice: string;
}

const FALLBACK: DiscountFieldLabels = {
  label: 'הנחה', type: 'סוג ההנחה', none: 'ללא הנחה', percent: 'אחוזים', amount: 'שקלים',
  value: 'גובה ההנחה', starts: 'תאריך התחלה', ends: 'תאריך סיום',
  showBadge: 'להציג תג מבצע', finalPrice: 'מחיר אחרי הנחה',
};

/** Takes the whole dashboard translation table (readonly, with non-string members like the CSV
 *  hint arrays) and picks out just the strings this block needs. */
export function discountFieldLabels(d: Readonly<Record<string, unknown>>): DiscountFieldLabels {
  const pick = (k: string, fallback: string): string => (typeof d[k] === 'string' ? d[k] : fallback);
  return {
    label: pick('discountLabel', FALLBACK.label),
    type: pick('discountTypeLabel', FALLBACK.type),
    none: pick('discountNone', FALLBACK.none),
    percent: pick('discountPercent', FALLBACK.percent),
    amount: pick('discountAmount', FALLBACK.amount),
    value: pick('discountValue', FALLBACK.value),
    starts: pick('saleStarts', FALLBACK.starts),
    ends: pick('saleEnds', FALLBACK.ends),
    showBadge: pick('discountBadgeShow', FALLBACK.showBadge),
    finalPrice: pick('discountFinalPrice', FALLBACK.finalPrice),
  };
}

/** `discount` is the product's current record (undefined on the add-product form).
 *  `header: false` drops the block's own "הנחה" heading — the bulk panel's own title already
 *  says what the block is, and both together read as the word twice. */
export function discountFieldHtml(
  discount: ProductDiscount | undefined,
  l: DiscountFieldLabels,
  { header = true }: { header?: boolean } = {},
): string {
  const type = discount?.type ?? '';
  const e = escapeHtml;
  // The dates + badge toggle only matter once a discount actually exists, so they stay collapsed
  // behind the type select rather than adding four permanently-empty controls to every product.
  const detailsHidden = discount ? '' : ' hidden';
  // Coerced, not interpolated as-is: this lands inside a quoted attribute, and the record comes
  // from stored JSON rather than from the normalizer on every path (a legacy/hand-edited row
  // could hold a string). A non-number becomes an empty field instead of breaking out of it.
  const value = Number.isFinite(Number(discount?.value)) ? Number(discount?.value) : '';
  return `
    <div class="field" data-discount-field>
      ${header ? `<span class="field-label">${e(l.label)}</span>` : ''}
      <div class="flex flex-wrap items-end gap-3">
        <label class="field" style="max-width:170px;margin-bottom:0">
          <span>${e(l.type)}</span>
          <select class="input" name="discount_type" data-discount-type>
            <option value=""${type === '' ? ' selected' : ''}>${e(l.none)}</option>
            <option value="percent"${type === 'percent' ? ' selected' : ''}>${e(l.percent)} (%)</option>
            <option value="amount"${type === 'amount' ? ' selected' : ''}>${e(l.amount)} (₪)</option>
          </select>
        </label>
        <label class="field" style="max-width:140px;margin-bottom:0" data-discount-value-field${detailsHidden}>
          <span>${e(l.value)}</span>
          <input class="input" name="discount_value" type="number" min="0" step="0.01" value="${discount ? value : ''}" data-discount-value>
        </label>
        <label class="field" style="max-width:170px;margin-bottom:0" data-discount-detail${detailsHidden}>
          <span>${e(l.starts)}</span>
          <input class="input" name="discount_starts" type="date" value="${e(discount?.startsAt ?? '')}">
        </label>
        <label class="field" style="max-width:170px;margin-bottom:0" data-discount-detail${detailsHidden}>
          <span>${e(l.ends)}</span>
          <input class="input" name="discount_ends" type="date" value="${e(discount?.endsAt ?? '')}">
        </label>
        <label class="flex items-center gap-2 text-[0.84rem] cursor-pointer" style="padding-bottom:0.55rem" data-discount-detail${detailsHidden}>
          <input type="checkbox" name="discount_badge" style="width:15px;height:15px;cursor:pointer"${discount?.showBadge === false ? '' : ' checked'}>
          ${e(l.showBadge)}
        </label>
      </div>
      <p class="muted" style="margin:0.35rem 0 0;font-size:0.8rem" data-discount-preview data-label="${e(l.finalPrice)}"${detailsHidden}></p>
    </div>`;
}
