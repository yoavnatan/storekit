/** A "tick the products this applies to" field — shared by the promotions tab's sale scope and
 *  the advertising tab's boost scope.
 *
 *  Rows are built on demand for the current search term (capped per render) instead of one
 *  element per product up front, so the field costs the same for a catalog of 8 or 8,000 (Hard
 *  rules → Scalability). The ticks live in a single comma-joined hidden input, so the form posts
 *  one field however many are picked.
 *
 *  Extracted from promotions.ts when the ad boost needed the same control: a second copy is how
 *  two identical fields start behaving differently (one gains the "selected rows always render"
 *  rule, the other doesn't).
 */
import { escapeHtml } from '../../lib/html-escape.js';
import { formatPrice } from '../../config/store.config.js';

export interface ProductPickerOption { id: string; name: string; price: number }

export interface ProductPickerConfig {
  /** Container the checkbox rows are rendered into. */
  list: HTMLElement;
  /** Hidden input carrying the picked ids, comma-joined. */
  hidden: HTMLInputElement;
  /** Optional free-text filter over product names. */
  search?: HTMLInputElement | null;
  /** Optional "(3 selected)" counter beside the field label. */
  count?: HTMLElement | null;
  options: ProductPickerOption[];
  labels: { selected?: string; none?: string };
  /** Called after every tick — lets a consumer react to the picked set (the ad form pre-fills
   *  the audience from it). */
  onChange?: (ids: string[]) => void;
}

/** How many rows one render draws. Past this the tail becomes a "+N" line rather than a list
 *  nobody scrolls — the search box is the way to reach the rest. */
const MAX_ROWS = 60;

export interface ProductMultiPicker {
  /** Repaint the rows — call when the field becomes visible, since a hidden container renders
   *  nothing a seller can see. */
  render: () => void;
  /** The picked ids, in tick order. */
  selected: () => string[];
}

export function initProductMultiPicker(config: ProductPickerConfig): ProductMultiPicker {
  const { list, hidden, search, count, options, labels, onChange } = config;
  const selected = new Set(hidden.value.split(',').map((v) => v.trim()).filter(Boolean));

  const commit = (): void => {
    hidden.value = [...selected].join(',');
    if (count) count.textContent = selected.size ? `(${selected.size} ${labels.selected ?? ''})` : '';
    onChange?.([...selected]);
  };

  const render = (): void => {
    const q = (search?.value ?? '').trim().toLowerCase();
    // Ticked rows always render, whatever the search term — otherwise a seller could not see
    // (or un-tick) a choice the current filter happens to exclude.
    const matches = options.filter((o) => selected.has(o.id) || (!q || o.name.toLowerCase().includes(q)));
    const shown = matches.slice(0, MAX_ROWS);
    if (!shown.length) {
      list.innerHTML = `<p class="muted m-0 p-2 text-[0.82rem]">${escapeHtml(labels.none ?? '')}</p>`;
      return;
    }
    list.innerHTML = shown.map((o) => `
      <label class="flex items-center gap-2 py-1.5 px-2 rounded-[var(--radius-sm)] cursor-pointer hover:bg-[color:var(--color-bg)]">
        <input type="checkbox" value="${escapeHtml(o.id)}" style="width:15px;height:15px;cursor:pointer"${selected.has(o.id) ? ' checked' : ''}>
        <span class="text-[0.85rem] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" dir="auto">${escapeHtml(o.name)}</span>
        <span class="muted text-[0.78rem]">${escapeHtml(formatPrice(o.price))}</span>
      </label>`).join('')
      + (matches.length > shown.length
        ? `<p class="muted m-0 p-2 text-[0.78rem]">+${matches.length - shown.length}</p>`
        : '');
    commit();
  };

  list.addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    if (box?.type !== 'checkbox') return;
    if (box.checked) selected.add(box.value); else selected.delete(box.value);
    commit();
  });
  search?.addEventListener('input', render);

  return { render, selected: () => [...selected] };
}

/** Reads the `<script type="application/json">` payload a panel renders its options into.
 *  Generic so a consumer can carry extra per-product fields alongside (the ad boost rides its
 *  inferred audience there) without a second reader. */
export function readProductOptions<T extends ProductPickerOption = ProductPickerOption>(dataElementId: string): T[] {
  try { return JSON.parse(document.getElementById(dataElementId)?.textContent ?? '[]') as T[]; }
  catch { return []; }
}
