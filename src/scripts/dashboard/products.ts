import { esc } from '../../lib/gallery-widget.js';
import { galleryWidgetHtml, initGalleryWidget, resolveGalleryUrls, resetGallery, finalizeGallery, closeGalleryPanel } from './gallery.js';
import { showStatus } from './status.js';
import { formatPrice } from '../../config/store.config.js';
import { thumbUrl } from './cloudinary.js';
import { resolveVariantColor, isColorVariant } from '../../lib/color-variants.js';
import { comboKey, generateCombos, canonicalDimName, type VariantDimension } from '../../lib/variant-combo.js';

export interface ProductData {
  id: string; storeId: string; slug?: string; name: string;
  description: string; price: number; stock: number; images?: string[];
  category?: string; tags?: string[];
  specs?: Array<{ label: string; value: string }>;
  variants?: VariantDimension[];
  variantStock?: Record<string, number>;
  createdAt?: string;
}

function fmtPrice(n: number) { return formatPrice(n); }

// ── Products pagination + category filter (shared state) ─────────────────────
const PRODUCTS_PAGE_SIZE = 20;
let productsActiveCategory = '';
let productsCurrentPage = 1;

function rowMatchesCategoryFilter(row: HTMLElement): boolean {
  return !productsActiveCategory || row.dataset.category === productsActiveCategory;
}

function fmtDateAdded(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}


function warnIcon(label: string): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${esc(label)}" style="color:var(--color-danger,#dc2626);flex-shrink:0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

function stockHtml(stock: number, outOfStockLabel: string): string {
  return stock <= 0
    ? `<span style="display:inline-flex;align-items:center;gap:0.3rem"><span>0</span>${warnIcon(outOfStockLabel)}</span>`
    : String(stock);
}

// Joins a combo's values for display — color dimensions must go through
// resolveVariantColor() first, or a custom color assigned via the picker
// (stored as "name #hex") would leak its hex code straight into the label —
// and get a small swatch right next to the color name so it's easy to tell
// them apart at a glance in the stock list / breakdown dropdown.
function comboLabelHtml(dims: VariantDimension[], combo: Record<string, string>): string {
  return dims.map(d => {
    const raw = combo[d.name] ?? '';
    if (!isColorVariant(d.name)) return esc(raw);
    const { display, hex } = resolveVariantColor(raw);
    const swatch = hex ? `<span aria-hidden="true" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${hex};border:1px solid rgba(0,0,0,0.15);flex-shrink:0"></span>` : '';
    return `<span style="display:inline-flex;align-items:center;gap:0.3rem">${swatch}${esc(display)}</span>`;
  }).join(' · ');
}

// Read-only quick-glance breakdown next to the products-table stock number —
// lets a seller scan per-variant stock across the whole table without opening
// each product's full edit form.
function stockBreakdownHtml(variants: VariantDimension[] | undefined, variantStock: Record<string, number> | undefined, totalStock: number, i18n: Record<string, string>): string {
  if (!variants?.length) return '';
  const stockMap = variantStock ?? {};
  const hasAnyStock = Object.keys(stockMap).length > 0;
  const combos = generateCombos(variants);
  const splitDefaults = hasAnyStock ? [] : evenSplit(combos.length, totalStock);
  const rows = combos.map((combo, idx) => {
    const key = comboKey(combo);
    const label = comboLabelHtml(variants, combo);
    const value = key in stockMap ? stockMap[key] : (hasAnyStock ? 0 : (splitDefaults[idx] ?? 0));
    const warn = value <= 0 ? warnIcon(i18n.outOfStock ?? 'Out of stock') : '';
    return `<div class="stock-breakdown__row"><span style="display:inline-flex;align-items:center;gap:0.35rem">${label}</span><span style="display:inline-flex;align-items:center;gap:0.3rem">${value}${warn}</span></div>`;
  }).join('');
  return `<span class="stock-breakdown" data-stock-breakdown>
    <button type="button" class="stock-breakdown__btn" aria-expanded="false" aria-haspopup="true" aria-label="${esc(i18n.stockBreakdownLabel ?? 'Show stock breakdown by variant')}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="stock-breakdown__dropdown" role="menu" hidden>${rows}</div>
  </span>`;
}

function getRawI18n() {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}'); } catch { return {}; }
}
function getDashI18n() { return getRawI18n().dashboard ?? {}; }
function getGalleryI18n() { return getRawI18n().gallery ?? {}; }

function categoryFieldHtml(category: string, i18n: Record<string, string>): string {
  return `<label class="field field--narrow">
    <span>${esc(i18n.categoryLabel ?? 'Category')}</span>
    <input class="input" name="category" value="${esc(category)}" placeholder="${esc(i18n.categoryPlaceholder ?? '')}" list="store-categories-list">
  </label>`;
}

function tagChipRemoveButtonHtml(i18n: Record<string, string>): string {
  return `<button type="button" class="variant-chip-remove" data-tag-chip-remove aria-label="${esc(i18n.variantChipRemove ?? 'Remove value')}" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:none;background:none;color:var(--color-muted);cursor:pointer;font-size:0.85rem;line-height:1;padding:0">×</button>`;
}

function tagChipHtml(value: string, i18n: Record<string, string>): string {
  return `<span class="variant-chip" data-tag-chip data-value="${esc(value)}" style="display:inline-flex;align-items:center;gap:0.35rem;border:1px solid var(--color-border);border-radius:999px;padding:0.25rem 0.5rem 0.25rem 0.4rem;font-size:0.82rem"><span class="variant-chip-label">${esc(value)}</span>${tagChipRemoveButtonHtml(i18n)}</span>`;
}

function tagAddTriggerHtml(i18n: Record<string, string>): string {
  return `<button type="button" class="variant-chip-add-trigger btn btn--ghost btn--sm" data-tag-add-trigger style="border-radius:999px">${esc(i18n.variantValueAddBtn ?? '+ Add')}</button>`;
}

function tagAddInputHtml(i18n: Record<string, string>): string {
  return `<input class="input" data-tag-add-input placeholder="${esc(i18n.tagsPlaceholder ?? '')}" style="width:110px;flex:0 0 auto">`;
}

// Tags are added one at a time the same way variant values are (collapsed
// "+ Add" trigger → inline input → Enter commits and reopens for the next
// one) instead of one comma-separated line — the hidden input keeps the
// comma-joined string the server (`parseTags`) already expects, so nothing
// downstream had to change.
function tagsFieldHtml(tags: string[], i18n: Record<string, string>): string {
  const chipsHtml = tags.map(t => tagChipHtml(t, i18n)).join('');
  return `<div class="field field--tags" data-tags-field>
    <span>${esc(i18n.tagsLabel ?? 'Tags')}</span>
    <div class="variant-chips" data-tag-chips style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center">${chipsHtml}<span data-tag-adder>${tagAddTriggerHtml(i18n)}</span></div>
    <input type="hidden" name="tags" value="${esc(tags.join(','))}">
  </div>`;
}

// Replacing the adder's innerHTML while it still contains the focused input
// (the normal case — Enter re-expands immediately after committing) makes
// the browser fire a synchronous blur/focusout on that input mid-removal.
// The global focusout listener below reacts to that by calling this same
// pair of functions again, re-entering innerHTML on the same element the
// outer call hasn't finished mutating yet — Chrome throws
// "the node to be removed is no longer a child of this node" and the adder
// is left collapsed instead of ready for the next value. `data-mutating`
// marks "this blur is our own doing," so the reentrant call becomes a no-op.
function expandTagAdder(field: HTMLElement, i18n: Record<string, string>): void {
  const adder = field.querySelector<HTMLElement>('[data-tag-adder]');
  if (!adder || adder.dataset.mutating) return;
  adder.dataset.mutating = '1';
  adder.innerHTML = tagAddInputHtml(i18n);
  delete adder.dataset.mutating;
  adder.querySelector<HTMLInputElement>('[data-tag-add-input]')?.focus();
}

function collapseTagAdder(field: HTMLElement, i18n: Record<string, string>): void {
  const adder = field.querySelector<HTMLElement>('[data-tag-adder]');
  if (!adder || adder.dataset.mutating) return;
  adder.dataset.mutating = '1';
  adder.innerHTML = tagAddTriggerHtml(i18n);
  delete adder.dataset.mutating;
}

function syncTagsHiddenInput(field: HTMLElement): void {
  const hidden = field.querySelector<HTMLInputElement>('input[name="tags"]');
  const values = [...field.querySelectorAll<HTMLElement>('[data-tag-chip]')].map(c => c.dataset.value ?? '');
  if (hidden) hidden.value = values.join(',');
}

function commitTagValue(field: HTMLElement, i18n: Record<string, string>): void {
  const input = field.querySelector<HTMLInputElement>('[data-tag-add-input]');
  const adder = field.querySelector<HTMLElement>('[data-tag-adder]');
  if (!input || !adder) return;
  const value = input.value.trim();
  if (!value) return;
  const existing = [...field.querySelectorAll<HTMLElement>('[data-tag-chip]')].map(c => (c.dataset.value ?? '').toLowerCase());
  if (existing.includes(value.toLowerCase())) { input.value = ''; return; }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = tagChipHtml(value, i18n);
  adder.before(wrapper.firstElementChild as HTMLElement);
  input.value = '';
  syncTagsHiddenInput(field);
}

export function initTagsEditor(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const field = target.closest<HTMLElement>('[data-tags-field]');
    if (!field) return;
    const i18n = getDashI18n();

    const trigger = target.closest<HTMLButtonElement>('[data-tag-add-trigger]');
    if (trigger) { expandTagAdder(field, i18n); return; }

    // Arms the shared "Sure? Yes/No" confirm (see initRemoveConfirm) instead
    // of deleting on the spot — same one-stray-click protection as variant chips.
    const removeBtn = target.closest<HTMLButtonElement>('[data-tag-chip-remove]');
    if (removeBtn) { replaceWithHtml(removeBtn, removeConfirmHtml('tag', i18n)); return; }
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target as Element;
    if (!target.matches('[data-tag-add-input]')) return;
    const field = target.closest<HTMLElement>('[data-tags-field]');
    if (!field) return;
    const i18n = getDashI18n();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTagValue(field, i18n);
      expandTagAdder(field, i18n); // stays open — cleared and refocused, for adding several tags in a row
    } else if (e.key === 'Escape') {
      e.preventDefault();
      collapseTagAdder(field, i18n);
    }
  });

  document.addEventListener('focusout', (e) => {
    const target = e.target as Element;
    if (!target.matches('[data-tag-add-input]')) return;
    const field = target.closest<HTMLElement>('[data-tags-field]');
    if (!field) return;
    // This blur can be our own expand/collapseTagAdder removing the input as
    // part of its own innerHTML swap, not the user actually clicking away —
    // see the comment above those functions. Let the outer call finish.
    if (field.querySelector<HTMLElement>('[data-tag-adder]')?.dataset.mutating) return;
    const i18n = getDashI18n();
    commitTagValue(field, i18n);
    collapseTagAdder(field, i18n);
  });
}

function specsEditorHtml(specs: Array<{ label: string; value: string }>, i18n: Record<string, string>): string {
  const lp = esc(i18n.specsLabelPlaceholder ?? '');
  const vp = esc(i18n.specsValuePlaceholder ?? '');
  const rowsHtml = specs.map(s => `
    <div class="specs-row" style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
      <input class="input" name="specs_label" value="${esc(s.label)}" placeholder="${lp}" style="flex:1">
      <input class="input" name="specs_value" value="${esc(s.value)}" placeholder="${vp}" style="flex:1">
      <button type="button" class="specs-remove-row btn btn--ghost btn--sm" aria-label="${esc(i18n.specsRemoveRow ?? 'Remove')}">×</button>
    </div>`).join('');
  return `<div class="field">
    <span class="field-label">${esc(i18n.specsLabel ?? 'Specifications')}</span>
    <div class="specs-rows" data-label-placeholder="${lp}" data-value-placeholder="${vp}">${rowsHtml}</div>
    <button type="button" class="specs-add-row btn btn--ghost btn--sm" style="margin-top:0.5rem">${esc(i18n.specsAddRow ?? '+ Add row')}</button>
  </div>`;
}

// ── Variants & inventory editor ───────────────────────────────────────────
// Each variant "dimension" (e.g. Color, Size, Storage — free-form, unlimited)
// gets its own chip list of values. Combinations across all dimensions are
// generated live into a per-combo stock grid. Color-named dimensions get a
// swatch per chip: resolved from the shared color dictionary, or — for a
// color the dictionary doesn't recognize — an inline native color picker so
// it never silently falls back to a plain unstyled text button.

function colorChipVisualHtml(dimName: string, value: string, i18n: Record<string, string>): string {
  if (!isColorVariant(dimName)) return '';
  const { hex } = resolveVariantColor(value);
  if (hex) {
    return `<span class="variant-chip-swatch" aria-hidden="true" style="width:14px;height:14px;border-radius:3px;background:${hex};border:1px solid rgba(0,0,0,0.15);flex-shrink:0;display:inline-block"></span>`;
  }
  return `<input type="color" class="variant-chip-color-input" value="#9ca3af" aria-label="${esc(i18n.variantColorPicker ?? 'Pick exact color')}" style="width:16px;height:16px;padding:0;border:1px solid rgba(0,0,0,0.15);border-radius:3px;flex-shrink:0;cursor:pointer;background:none">`;
}

function chipRemoveButtonHtml(i18n: Record<string, string>): string {
  return `<button type="button" class="variant-chip-remove" aria-label="${esc(i18n.variantChipRemove ?? 'Remove value')}" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:none;background:none;color:var(--color-muted);cursor:pointer;font-size:0.85rem;line-height:1;padding:0">×</button>`;
}

function chipHtml(dimName: string, value: string, i18n: Record<string, string>): string {
  const display = isColorVariant(dimName) ? resolveVariantColor(value).display : value;
  return `<span class="variant-chip" data-variant-chip data-value="${esc(value)}" style="display:inline-flex;align-items:center;gap:0.35rem;border:1px solid var(--color-border);border-radius:999px;padding:0.25rem 0.5rem 0.25rem 0.4rem;font-size:0.82rem">${colorChipVisualHtml(dimName, value, i18n)}<span class="variant-chip-label">${esc(display)}</span>${chipRemoveButtonHtml(i18n)}</span>`;
}

// A remove (×) click never deletes immediately — it swaps to a tiny inline
// "Sure? Yes/No" so a stray click can't wipe out a whole rubric (all its
// values + combo stock), a single variant chip, or a tag. Only one can be
// armed at a time; clicking anywhere else, or Escape, reverts it back to a
// plain ×. Resolved centrally by initRemoveConfirm(), regardless of which
// editor (variants or tags) armed it.
function removeConfirmHtml(kind: 'dim' | 'chip' | 'tag', i18n: Record<string, string>): string {
  return `<span class="remove-confirm" data-remove-confirm data-remove-kind="${kind}" style="display:inline-flex;align-items:center;gap:0.3rem;white-space:nowrap;font-size:0.78rem;flex-shrink:0">
    <span style="color:var(--color-muted)">${esc(i18n.confirmDeleteShort ?? 'Sure?')}</span>
    <button type="button" data-remove-confirm-yes style="color:var(--color-danger,#dc2626);background:none;border:none;cursor:pointer;font-weight:700;padding:0 0.15rem;font-size:0.78rem">${esc(i18n.confirmYes ?? 'Yes')}</button>
    <button type="button" data-remove-confirm-no style="color:var(--color-muted);background:none;border:none;cursor:pointer;padding:0 0.15rem;font-size:0.78rem">${esc(i18n.confirmNo ?? 'No')}</button>
  </span>`;
}

function replaceWithHtml(el: Element, html: string): Element {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const newEl = wrapper.firstElementChild as Element;
  el.replaceWith(newEl);
  return newEl;
}

function cancelArmedRemoveConfirm(i18n: Record<string, string>): void {
  const wrapper = document.querySelector<HTMLElement>('[data-remove-confirm]');
  if (!wrapper) return;
  const kind = wrapper.dataset.removeKind;
  const revertHtml = kind === 'dim' ? dimRemoveButtonHtml(i18n) : kind === 'tag' ? tagChipRemoveButtonHtml(i18n) : chipRemoveButtonHtml(i18n);
  replaceWithHtml(wrapper, revertHtml);
}

// Shared resolution for an armed "Sure? Yes/No" — dim/chip removals also
// need to refresh the combo-stock table, but only when they're actually
// inside a variants editor (a tag removal never is).
function resolveRemoveConfirm(wrapper: HTMLElement, i18n: Record<string, string>): void {
  const kind = wrapper.dataset.removeKind;
  if (kind === 'tag') {
    const field = wrapper.closest<HTMLElement>('[data-tags-field]');
    wrapper.closest('[data-tag-chip]')?.remove();
    if (field) syncTagsHiddenInput(field);
    return;
  }
  if (kind === 'dim') wrapper.closest('[data-variant-dim]')?.remove();
  else if (kind === 'chip') wrapper.closest('[data-variant-chip]')?.remove();
  const editor = wrapper.closest<HTMLElement>('[data-variants-editor]');
  if (editor) { refreshVariantCombos(editor, i18n); revalidateAllDimNames(editor, i18n); }
}

// Centralizes the parts of the remove-confirm lifecycle that don't belong to
// any one editor: canceling the armed state on an outside click or Escape,
// and resolving Yes/No. The arming click (the × itself) stays local to
// whichever editor owns that chip (initVariantEditors / initTagsEditor).
export function initRemoveConfirm(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const i18n = getDashI18n();

    const armed = document.querySelector<HTMLElement>('[data-remove-confirm]');
    if (armed && !armed.contains(target)) cancelArmedRemoveConfirm(i18n);

    const confirmYesBtn = target.closest<HTMLButtonElement>('[data-remove-confirm-yes]');
    if (confirmYesBtn) {
      const wrapper = confirmYesBtn.closest<HTMLElement>('[data-remove-confirm]');
      if (wrapper) resolveRemoveConfirm(wrapper, i18n);
      return;
    }

    if (target.closest('[data-remove-confirm-no]')) { cancelArmedRemoveConfirm(i18n); return; }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('[data-remove-confirm]')) {
      cancelArmedRemoveConfirm(getDashI18n());
    }
  });
}

function dimValueTriggerHtml(i18n: Record<string, string>): string {
  return `<button type="button" class="variant-chip-add-trigger btn btn--ghost btn--sm" data-dim-value-trigger style="border-radius:999px">${esc(i18n.variantValueAddBtn ?? '+ Add')}</button>`;
}

function dimValueInputHtml(i18n: Record<string, string>): string {
  return `<input class="input" data-dim-value-input placeholder="${esc(i18n.variantValueAddPlaceholder ?? '')}" style="width:100px;flex:0 0 auto">`;
}

function createValueAdderElement(i18n: Record<string, string>): HTMLElement {
  const span = document.createElement('span');
  span.setAttribute('data-dim-value-adder', '');
  span.innerHTML = dimValueTriggerHtml(i18n);
  return span;
}

function dimRemoveButtonHtml(i18n: Record<string, string>): string {
  return `<button type="button" class="variant-dim-remove btn btn--ghost btn--sm" aria-label="${esc(i18n.variantRemove ?? 'Remove variant type')}" style="flex-shrink:0">×</button>`;
}

function dimHtml(dim: VariantDimension, i18n: Record<string, string>): string {
  const chipsHtml = dim.options.map(o => chipHtml(dim.name, o, i18n)).join('');
  return `<div class="variant-dim" data-variant-dim style="border:1px solid var(--color-border);border-radius:var(--radius);padding:0.65rem;margin-bottom:0.5rem">
    <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
      <input class="input" data-dim-name value="${esc(dim.name)}" placeholder="${esc(i18n.variantNamePlaceholder ?? '')}" style="width:170px;flex:0 0 auto">
      ${dimRemoveButtonHtml(i18n)}
    </div>
    <div class="variant-chips" data-variant-chips style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center">${chipsHtml}<span data-dim-value-adder>${dimValueTriggerHtml(i18n)}</span></div>
  </div>`;
}

// Two dimensions can't share a title (e.g. two "Color" rubrics) — the combo
// grid keys columns by name, so a duplicate would silently merge/clobber
// columns. Checked live against sibling dims' *current* input values, not a
// snapshot, so renaming one dim to free up a name un-blocks the other.
function siblingDimNames(editor: HTMLElement, exclude: HTMLElement): string[] {
  return [...editor.querySelectorAll<HTMLElement>('[data-variant-dim]')]
    .filter(el => el !== exclude)
    .map(el => canonicalDimName(el.querySelector<HTMLInputElement>('[data-dim-name]')?.value ?? ''))
    .filter(Boolean);
}

function isDimNameDuplicate(editor: HTMLElement, dimEl: HTMLElement, nameInput: HTMLInputElement): boolean {
  const name = canonicalDimName(nameInput.value);
  return !!name && siblingDimNames(editor, dimEl).includes(name);
}

function setDimNameValidity(nameInput: HTMLInputElement, isDupe: boolean, i18n: Record<string, string>): void {
  nameInput.style.borderColor = isDupe ? 'var(--color-danger, #dc2626)' : '';
  nameInput.title = isDupe ? (i18n.variantNameDuplicate ?? 'A variant type with this name already exists') : '';
}

// Re-checks every dimension's name, not just the one being edited — fixing
// dim A's name (so it no longer collides with dim B) should also clear B's
// red border, without B's own input ever having fired an event.
function revalidateAllDimNames(editor: HTMLElement, i18n: Record<string, string>): void {
  editor.querySelectorAll<HTMLElement>('[data-variant-dim]').forEach((dimEl) => {
    const nameInput = dimEl.querySelector<HTMLInputElement>('[data-dim-name]');
    if (!nameInput) return;
    setDimNameValidity(nameInput, isDimNameDuplicate(editor, dimEl, nameInput), i18n);
  });
}

// Splits `total` across `count` rows as evenly as possible (remainder goes to
// the first rows) so seeding legacy combos never silently changes the sum —
// open the editor and save without touching anything, and stock is unchanged.
function evenSplit(count: number, total: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

const SORT_ICON_SVG = '<svg class="combo-sort-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';

// One column per dimension (sortable, header = the dimension's own name) plus
// a Stock column — instead of one flattened "Red · S" text cell, so a seller
// with several rubrics can sort by whichever one they're scanning for.
// Stock is the last column and, if there are enough rubrics to need
// horizontal scroll, the one number a seller can never afford to lose sight
// of — it stays pinned to the trailing edge (sticky on both axes at once:
// top for the header row, inline-end for this one column).
const STOCK_COL_STICKY = 'position:sticky;inset-inline-end:0;background:var(--color-surface)';

const FILTER_ICON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';

// Per-column value filter — a small funnel button next to each dimension's
// sort button. Its dropdown is NOT nested in the header (a scrolling ancestor
// would clip it) — it's a single shared "portal" element appended to <body>,
// filled in and repositioned via getBoundingClientRect() each time it opens,
// so it always renders above everything regardless of the table's own
// scroll. Nothing checked = no filter (all rows shown); checking one or more
// values restricts to rows matching any of them; multiple columns' filters
// combine with AND. Never touches the underlying data, only which rows are
// visible — collectVariantsPayload() always reads every row.
function comboFilterHtml(colIndex: number, colName: string, i18n: Record<string, string>): string {
  return `<span class="combo-filter" data-combo-filter data-filter-col="${colIndex}" style="display:inline-flex">
    <button type="button" class="combo-filter-btn" aria-expanded="false" aria-haspopup="true" aria-label="${esc((i18n.variantFilterAriaPrefix ?? 'Filter by') + ' ' + colName)}" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;background:none;border:none;cursor:pointer;color:var(--color-muted);padding:0">${FILTER_ICON_SVG}</button>
  </span>`;
}

function comboHeaderHtml(dims: VariantDimension[], i18n: Record<string, string>): string {
  const dimHeaders = dims.map((d, i) => `<th style="padding:0.4rem 0.6rem;text-align:start;border-bottom:1px solid var(--color-border);white-space:nowrap">
    <div style="display:flex;align-items:center;gap:0.25rem">
      <button type="button" class="combo-sort-btn" data-combo-sort-col="${i}">${esc(d.name)}${SORT_ICON_SVG}</button>
      ${comboFilterHtml(i, d.name, i18n)}
    </div>
  </th>`).join('');
  return `<tr data-variant-combo-header>${dimHeaders}<th style="padding:0.4rem 0.6rem;text-align:end;border-bottom:1px solid var(--color-border);white-space:nowrap;${STOCK_COL_STICKY};z-index:2">
    <button type="button" class="combo-sort-btn" data-combo-sort-col="stock">${esc(i18n.variantStockColLabel ?? 'Stock')}${SORT_ICON_SVG}</button>
  </th></tr>`;
}

function comboTotalRowHtml(dims: VariantDimension[], i18n: Record<string, string>): string {
  const label = `${i18n.variantComboTotal ?? 'Total'} (${i18n.variantFilterAll ?? 'All'})`;
  return `<tr data-variant-combo-total-row>
    <td colspan="${dims.length}" data-variant-combo-total-label style="padding:0.4rem 0.6rem;font-size:0.82rem;font-weight:600;color:var(--color-text);white-space:nowrap;border-top:1px solid var(--color-border);position:sticky;bottom:0;background:var(--color-surface)">${esc(label)}</td>
    <td data-variant-combo-total-value style="padding:0.4rem 0.6rem;text-align:end;font-weight:600;color:var(--color-text);border-top:1px solid var(--color-border);position:sticky;inset-inline-end:0;bottom:0;background:var(--color-surface);z-index:1">0</td>
  </tr>`;
}

function comboRowHtml(dims: VariantDimension[], combo: Record<string, string>, key: string, value: number): string {
  const cells = dims.map(d => {
    const raw = combo[d.name] ?? '';
    if (!isColorVariant(d.name)) {
      return `<td style="padding:0.4rem 0.6rem;font-size:0.85rem;color:var(--color-text);white-space:nowrap;vertical-align:middle">${esc(raw)}</td>`;
    }
    const { display, hex } = resolveVariantColor(raw);
    const swatch = hex ? `<span aria-hidden="true" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${hex};border:1px solid rgba(0,0,0,0.15);flex-shrink:0"></span>` : '';
    return `<td style="padding:0.4rem 0.6rem;font-size:0.85rem;color:var(--color-text);white-space:nowrap;vertical-align:middle"><span style="display:inline-flex;align-items:center;gap:0.3rem">${swatch}${esc(display)}</span></td>`;
  }).join('');
  return `<tr class="variant-combo-row" data-variant-combo-row data-combo-key="${esc(key)}">${cells}<td style="padding:0.4rem 0.6rem;text-align:end;vertical-align:middle;${STOCK_COL_STICKY};z-index:1"><input type="number" min="0" step="1" class="input" data-combo-stock value="${value}" style="width:80px;text-align:center;padding:0.3rem 0.4rem"></td></tr>`;
}

function comboRowsHtml(dims: VariantDimension[], stockMap: Record<string, number>, fallbackTotal: number, hasAnyStock: boolean): string {
  const combos = generateCombos(dims);
  const splitDefaults = hasAnyStock ? [] : evenSplit(combos.length, fallbackTotal);
  return combos.map((combo, i) => {
    const key = comboKey(combo);
    const value = key in stockMap ? stockMap[key] : (hasAnyStock ? 0 : (splitDefaults[i] ?? 0));
    return comboRowHtml(dims, combo, key, value);
  }).join('');
}

function sortComboTable(editor: HTMLElement, col: string): void {
  const table = editor.querySelector<HTMLElement>('[data-variant-combos]');
  const tbody = editor.querySelector<HTMLTableSectionElement>('[data-variant-combo-rows]');
  if (!table || !tbody) return;

  const prevCol = table.dataset.sortCol;
  const dir = prevCol === col && table.dataset.sortDir === 'asc' ? 'desc' : 'asc';
  table.dataset.sortCol = col;
  table.dataset.sortDir = dir;

  const rows = [...tbody.querySelectorAll<HTMLTableRowElement>('[data-variant-combo-row]')];
  const colIndex = col === 'stock' ? -1 : Number(col);
  rows.sort((a, b) => {
    let va: string | number, vb: string | number;
    if (colIndex === -1) {
      va = Number(a.querySelector<HTMLInputElement>('[data-combo-stock]')?.value ?? 0);
      vb = Number(b.querySelector<HTMLInputElement>('[data-combo-stock]')?.value ?? 0);
    } else {
      va = (a.children[colIndex]?.textContent ?? '').trim().toLowerCase();
      vb = (b.children[colIndex]?.textContent ?? '').trim().toLowerCase();
    }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
  rows.forEach(r => tbody.append(r));

  editor.querySelectorAll<HTMLButtonElement>('.combo-sort-btn').forEach((btn) => {
    if (btn.dataset.comboSortCol === col) { btn.dataset.active = 'true'; btn.dataset.dir = dir; }
    else { delete btn.dataset.active; delete btn.dataset.dir; }
  });
}

function variantsEditorHtml(variants: VariantDimension[], variantStock: Record<string, number>, currentStock: number, i18n: Record<string, string>): string {
  const hasAnyStock = Object.keys(variantStock).length > 0;
  const dimsHtml = variants.map(v => dimHtml(v, i18n)).join('');
  const headerHtml = variants.length ? comboHeaderHtml(variants, i18n) : '';
  const rowsHtml = variants.length ? comboRowsHtml(variants, variantStock, currentStock, hasAnyStock) : '';
  const totalHtml = variants.length ? comboTotalRowHtml(variants, i18n) : '';
  return `<div class="field variants-editor" data-variants-editor>
    <span class="field-label">${esc(i18n.variantsLabel ?? 'Variants & inventory')}</span>
    <div class="variant-dims" data-variant-dims>${dimsHtml}</div>
    <button type="button" class="variants-add-btn btn btn--ghost btn--sm" style="margin-top:0.25rem">${esc(i18n.variantAddBtn ?? '+ Add variant type')}</button>
    <div class="variant-combos" data-variant-combos style="margin-top:0.75rem" ${variants.length ? '' : 'hidden'}>
      <p class="field-label" style="margin:0 0 0.3rem">${esc(i18n.variantComboLabel ?? 'Stock per combination')}</p>
      <p class="muted" data-variant-combo-hint style="font-size:0.78rem;margin:0 0 0.5rem" ${hasAnyStock ? 'hidden' : ''}>${esc(i18n.variantComboHint ?? '')}</p>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--radius)">
        <table style="width:100%;border-collapse:separate;border-spacing:0">
          <thead data-variant-combo-thead>${headerHtml}</thead>
          <tbody data-variant-combo-rows>${rowsHtml}</tbody>
          <tfoot data-variant-combo-tfoot>${totalHtml}</tfoot>
        </table>
      </div>
    </div>
  </div>`;
}

function readVariantDims(editor: HTMLElement): VariantDimension[] {
  const seenNames = new Set<string>();
  return [...editor.querySelectorAll<HTMLElement>('[data-variant-dim]')]
    .map((dimEl) => ({
      name: dimEl.querySelector<HTMLInputElement>('[data-dim-name]')?.value.trim() ?? '',
      options: [...dimEl.querySelectorAll<HTMLElement>('[data-variant-chip]')].map(c => c.dataset.value ?? ''),
    }))
    // Safety net alongside the live UI validation below — never save two
    // dims sharing a name (case-insensitive, synonym-aware) even if the UI
    // check was bypassed.
    .filter(d => {
      if (!d.name || !d.options.length) return false;
      const key = canonicalDimName(d.name);
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
}

function readComboStock(editor: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  editor.querySelectorAll<HTMLElement>('[data-variant-combo-row]').forEach((row) => {
    const key = (row as HTMLElement).dataset.comboKey ?? '';
    const input = row.querySelector<HTMLInputElement>('[data-combo-stock]');
    if (!key || !input) return;
    out[key] = Math.max(0, Math.floor(Number(input.value)) || 0);
  });
  return out;
}

// The overall "stock" field becomes a read-only, live-computed sum of the combo
// rows the moment any variant dimension exists — having it as a second,
// independently-editable number that only syncs on a manual click was
// confusing (two numbers, unclear which one wins). With no dimensions it's a
// normal editable field, unchanged.
function sumComboStock(editor: HTMLElement): number {
  return Object.values(readComboStock(editor)).reduce((s, n) => s + n, 0);
}

function syncTotalStockField(editor: HTMLElement): void {
  const stockInput = editor.closest('form')?.querySelector<HTMLInputElement>('input[name="stock"]');
  if (!stockInput) return;
  const hasDims = editor.querySelectorAll('[data-variant-dim]').length > 0;
  if (!hasDims) {
    stockInput.readOnly = false;
    stockInput.style.background = '';
    return;
  }
  stockInput.value = String(sumComboStock(editor));
  stockInput.readOnly = true;
  stockInput.style.background = 'var(--color-bg)';
}

function updateComboTotal(editor: HTMLElement): void {
  const rowsBody = editor.querySelector<HTMLElement>('[data-variant-combo-rows]');
  const totalCell = editor.querySelector<HTMLElement>('[data-variant-combo-total-value]');
  if (!rowsBody || !totalCell) return;
  const sum = [...rowsBody.querySelectorAll<HTMLTableRowElement>('[data-variant-combo-row]')]
    .filter(row => !row.hidden)
    .reduce((s, row) => s + (Number(row.querySelector<HTMLInputElement>('[data-combo-stock]')?.value) || 0), 0);
  totalCell.textContent = String(sum);
}

// Nothing checked in a column's filter = that column doesn't restrict
// anything; checking values requires a row to match one of them. Filters
// across columns combine with AND. Purely a display concern — hidden rows'
// stock is still read and saved normally.
// Selected filter values persist as JSON on the (never-moved) `.combo-filter`
// wrapper itself — the portal only ever renders whichever one column is
// currently open, so it can't be the source of truth for the others.
function getComboFilterSelection(wrap: HTMLElement): string[] {
  try { return JSON.parse(wrap.dataset.selected ?? '[]') as string[]; } catch { return []; }
}

function setComboFilterSelection(wrap: HTMLElement, values: string[]): void {
  if (values.length) wrap.dataset.selected = JSON.stringify(values);
  else delete wrap.dataset.selected;
  const btn = wrap.querySelector<HTMLButtonElement>('.combo-filter-btn');
  if (btn) btn.dataset.active = values.length ? 'true' : '';
}

function getActiveComboFilters(editor: HTMLElement): Map<number, string[]> {
  const filters = new Map<number, string[]>();
  editor.querySelectorAll<HTMLElement>('[data-combo-filter]').forEach((wrap) => {
    const col = Number(wrap.dataset.filterCol);
    const selected = getComboFilterSelection(wrap);
    if (selected.length) filters.set(col, selected);
  });
  return filters;
}

// The total row's label always spells out what it's summing — "All" when
// nothing's filtered, or the exact values chosen — so a seller who filtered
// to "only large" doesn't mistake that subtotal for the whole product's stock.
function updateComboTotalLabel(editor: HTMLElement, i18n: Record<string, string>): void {
  const labelCell = editor.querySelector<HTMLElement>('[data-variant-combo-total-label]');
  if (!labelCell) return;
  const filters = getActiveComboFilters(editor);
  const content = filters.size ? [...filters.values()].flat().join(', ') : (i18n.variantFilterAll ?? 'All');
  labelCell.textContent = `${i18n.variantComboTotal ?? 'Total'} (${content})`;
}

function applyComboFilters(editor: HTMLElement): void {
  const rowsBody = editor.querySelector<HTMLElement>('[data-variant-combo-rows]');
  if (!rowsBody) return;

  const filters = getActiveComboFilters(editor);
  rowsBody.querySelectorAll<HTMLTableRowElement>('[data-variant-combo-row]').forEach((row) => {
    let visible = true;
    filters.forEach((allowed, col) => {
      const cellText = (row.children[col]?.textContent ?? '').trim();
      if (!allowed.includes(cellText)) visible = false;
    });
    row.hidden = !visible;
  });

  updateComboTotal(editor);
  updateComboTotalLabel(editor, getDashI18n());
}

// A single shared dropdown appended to <body> — reused for whichever column's
// filter is currently open, positioned with getBoundingClientRect() so it's
// never clipped by the combo grid's own scroll container.
let comboFilterOpenWrap: HTMLElement | null = null;
let comboFilterOpenEditor: HTMLElement | null = null;

function getComboFilterPortal(): HTMLElement {
  let portal = document.getElementById('combo-filter-portal');
  if (!portal) {
    portal = document.createElement('div');
    portal.id = 'combo-filter-portal';
    portal.className = 'combo-filter-dropdown';
    portal.setAttribute('role', 'menu');
    portal.hidden = true;
    portal.style.cssText = 'position:fixed;min-width:130px;max-height:220px;overflow:auto;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius);box-shadow:0 4px 20px rgba(0,0,0,0.13);z-index:300;padding:0.3rem;animation:product-menu-open 0.13s cubic-bezier(0.34,1.56,0.64,1)';
    document.body.appendChild(portal);
  }
  return portal;
}

function closeComboFilterPortal(): void {
  const portal = document.getElementById('combo-filter-portal');
  if (portal) portal.hidden = true;
  comboFilterOpenWrap?.querySelector<HTMLButtonElement>('.combo-filter-btn')?.setAttribute('aria-expanded', 'false');
  comboFilterOpenWrap = null;
  comboFilterOpenEditor = null;
}

function openComboFilterPortal(wrap: HTMLElement, editor: HTMLElement, i18n: Record<string, string>): void {
  const btn = wrap.querySelector<HTMLButtonElement>('.combo-filter-btn');
  if (!btn) return;
  const col = Number(wrap.dataset.filterCol);
  const values = readVariantDims(editor)[col]?.options ?? [];
  const selected = new Set(getComboFilterSelection(wrap));

  const portal = getComboFilterPortal();
  const items = values.map(v => `<label class="combo-filter-item" style="display:flex;align-items:center;gap:0.4rem;padding:0.45rem 0.75rem;border-radius:4px;cursor:pointer;font-size:0.82rem;font-weight:400;text-transform:none;letter-spacing:normal;white-space:nowrap"><input type="checkbox" data-combo-filter-value="${esc(v)}" ${selected.has(v) ? 'checked' : ''} style="cursor:pointer;flex-shrink:0">${esc(v)}</label>`).join('');
  portal.innerHTML = `${items}<button type="button" class="combo-filter-clear" data-combo-filter-clear style="display:block;width:100%;text-align:start;padding:0.45rem 0.75rem;border-radius:4px;background:none;border:none;cursor:pointer;font-size:0.8rem;color:var(--color-muted);text-transform:none;letter-spacing:normal">${esc(i18n.variantFilterClear ?? 'Clear')}</button>`;

  const rect = btn.getBoundingClientRect();
  const isRTL = getComputedStyle(document.documentElement).direction === 'rtl';
  portal.style.top = `${rect.bottom + 4}px`;
  if (isRTL) { portal.style.right = `${window.innerWidth - rect.right}px`; portal.style.left = 'auto'; }
  else { portal.style.left = `${rect.left}px`; portal.style.right = 'auto'; }
  portal.hidden = false;
  btn.setAttribute('aria-expanded', 'true');

  comboFilterOpenWrap = wrap;
  comboFilterOpenEditor = editor;
}

function refreshVariantCombos(editor: HTMLElement, i18n: Record<string, string>): void {
  const dims = readVariantDims(editor);
  const existingStock = readComboStock(editor);
  const combosWrap = editor.querySelector<HTMLElement>('[data-variant-combos]');
  const thead = editor.querySelector<HTMLElement>('[data-variant-combo-thead]');
  const rowsBody = editor.querySelector<HTMLElement>('[data-variant-combo-rows]');
  const tfoot = editor.querySelector<HTMLElement>('[data-variant-combo-tfoot]');
  const hint = editor.querySelector<HTMLElement>('[data-variant-combo-hint]');
  if (!combosWrap || !thead || !rowsBody || !tfoot) return;

  if (!dims.length) {
    combosWrap.setAttribute('hidden', '');
    thead.innerHTML = '';
    rowsBody.innerHTML = '';
    tfoot.innerHTML = '';
    delete combosWrap.dataset.sortCol;
    delete combosWrap.dataset.sortDir;
    syncTotalStockField(editor);
    return;
  }

  const form = editor.closest('form');
  const totalStockInput = form?.querySelector<HTMLInputElement>('input[name="stock"]');
  const fallbackTotal = Math.max(0, parseInt(totalStockInput?.value ?? '0', 10) || 0);
  const hasAnyStock = Object.keys(existingStock).length > 0;

  // Column count/order may have just changed (dimension added/removed/renamed) —
  // any previous sort/filter no longer maps to a meaningful column, so reset.
  delete combosWrap.dataset.sortCol;
  delete combosWrap.dataset.sortDir;
  thead.innerHTML = comboHeaderHtml(dims, i18n);
  rowsBody.innerHTML = comboRowsHtml(dims, existingStock, fallbackTotal, hasAnyStock);
  tfoot.innerHTML = comboTotalRowHtml(dims, i18n);
  combosWrap.removeAttribute('hidden');
  if (hint) hint.hidden = hasAnyStock;
  syncTotalStockField(editor);
  updateComboTotal(editor);
}

// The "add value" control stays collapsed to a small trigger button until
// clicked — an always-open text box under every dimension looked cluttered.
// Enter commits and keeps the box open (so adding several sizes in a row
// doesn't need re-clicking); only losing focus or Escape collapses it back.
function expandValueAdder(dimEl: HTMLElement, i18n: Record<string, string>): void {
  const adder = dimEl.querySelector<HTMLElement>('[data-dim-value-adder]');
  if (!adder) return;
  adder.innerHTML = dimValueInputHtml(i18n);
  adder.querySelector<HTMLInputElement>('[data-dim-value-input]')?.focus();
}

function collapseValueAdder(dimEl: HTMLElement, i18n: Record<string, string>): void {
  const adder = dimEl.querySelector<HTMLElement>('[data-dim-value-adder]');
  if (adder) adder.innerHTML = dimValueTriggerHtml(i18n);
}

function commitVariantValue(dimEl: HTMLElement, editor: HTMLElement, i18n: Record<string, string>): void {
  const input = dimEl.querySelector<HTMLInputElement>('[data-dim-value-input]');
  const nameInput = dimEl.querySelector<HTMLInputElement>('[data-dim-name]');
  const adder = dimEl.querySelector<HTMLElement>('[data-dim-value-adder]');
  if (!input || !nameInput || !adder) return;
  // A dim with no title yet would just get silently dropped at save time
  // (readVariantDims/server both require a name) — block adding values under
  // it up front instead, so a seller who forgot to name it isn't left
  // wondering later why their values never made it to the saved product.
  if (!nameInput.value.trim()) {
    input.value = '';
    nameInput.style.borderColor = 'var(--color-danger, #dc2626)';
    nameInput.title = i18n.variantNameRequired ?? 'Name the variant type before adding values';
    nameInput.focus();
    return;
  }
  if (isDimNameDuplicate(editor, dimEl, nameInput)) { input.value = ''; return; }
  const value = input.value.trim();
  if (!value) return;
  const existing = [...dimEl.querySelectorAll<HTMLElement>('[data-variant-chip]')].map(c => (c.dataset.value ?? '').toLowerCase());
  if (existing.includes(value.toLowerCase())) { input.value = ''; return; }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = chipHtml(nameInput.value, value, i18n);
  adder.before(wrapper.firstElementChild as HTMLElement);
  input.value = '';
  refreshVariantCombos(editor, i18n);
}

export function collectVariantsPayload(form: HTMLFormElement): { variants: VariantDimension[]; variantStock: Record<string, number> } {
  const editor = form.querySelector<HTMLElement>('[data-variants-editor]');
  if (!editor) return { variants: [], variantStock: {} };
  return { variants: readVariantDims(editor), variantStock: readComboStock(editor) };
}

export function resetVariantsEditor(form: HTMLFormElement): void {
  const editor = form.querySelector<HTMLElement>('[data-variants-editor]');
  if (!editor) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = variantsEditorHtml([], {}, 0, getDashI18n());
  editor.replaceWith(wrapper.firstElementChild as HTMLElement);
}

export function initVariantEditors(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const i18n = getDashI18n();

    // Click on the trigger that owns the open portal is handled by the toggle
    // logic further down — any other click outside it closes it.
    const portalEl = document.getElementById('combo-filter-portal');
    if (portalEl && !portalEl.hidden && !portalEl.contains(target) && !comboFilterOpenWrap?.contains(target)) {
      closeComboFilterPortal();
    }

    // The portal lives at <body> level, not inside any .variants-editor, so
    // its own clicks (checkboxes are handled on `change`; this is "Clear")
    // must be handled before the editor-scoped early return below.
    const filterClearBtn = target.closest<HTMLButtonElement>('[data-combo-filter-clear]');
    if (filterClearBtn && comboFilterOpenWrap && comboFilterOpenEditor) {
      setComboFilterSelection(comboFilterOpenWrap, []);
      portalEl?.querySelectorAll<HTMLInputElement>('[data-combo-filter-value]').forEach(cb => { cb.checked = false; });
      applyComboFilters(comboFilterOpenEditor);
      return;
    }

    const editor = target.closest<HTMLElement>('[data-variants-editor]');
    if (!editor) return;

    const addDimBtn = target.closest<HTMLButtonElement>('.variants-add-btn');
    if (addDimBtn) {
      const dimsWrap = editor.querySelector<HTMLElement>('[data-variant-dims]');
      if (!dimsWrap) return;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = dimHtml({ name: '', options: [] }, i18n);
      const block = wrapper.firstElementChild as HTMLElement;
      dimsWrap.appendChild(block);
      block.querySelector<HTMLInputElement>('[data-dim-name]')?.focus();
      return;
    }

    const removeDimBtn = target.closest<HTMLButtonElement>('.variant-dim-remove');
    if (removeDimBtn) { replaceWithHtml(removeDimBtn, removeConfirmHtml('dim', i18n)); return; }

    const removeChipBtn = target.closest<HTMLButtonElement>('.variant-chip-remove');
    if (removeChipBtn) { replaceWithHtml(removeChipBtn, removeConfirmHtml('chip', i18n)); return; }

    const triggerBtn = target.closest<HTMLButtonElement>('[data-dim-value-trigger]');
    if (triggerBtn) {
      const dimEl = triggerBtn.closest<HTMLElement>('[data-variant-dim]');
      if (dimEl) expandValueAdder(dimEl, i18n);
      return;
    }

    const sortBtn = target.closest<HTMLButtonElement>('.combo-sort-btn');
    if (sortBtn) {
      if (sortBtn.dataset.comboSortCol) sortComboTable(editor, sortBtn.dataset.comboSortCol);
      return;
    }

    const filterBtn = target.closest<HTMLButtonElement>('.combo-filter-btn');
    if (filterBtn) {
      const wrap = filterBtn.closest<HTMLElement>('[data-combo-filter]');
      if (!wrap) return;
      const isOpen = comboFilterOpenWrap === wrap;
      closeComboFilterPortal();
      if (!isOpen) openComboFilterPortal(wrap, editor, i18n);
      return;
    }

  });

  document.addEventListener('keydown', (e) => {
    const target = e.target as Element;

    if (e.key === 'Escape') closeComboFilterPortal();

    // The dimension-name field gets autofocused right after clicking "+ Add
    // variant type" — pressing Enter there out of habit would otherwise submit
    // the whole product form prematurely (this field has no submit button of
    // its own to intercept it), silently dropping the still-optionless
    // dimension since readVariantDims() filters out any dimension with no
    // values yet.
    if (target.matches('[data-dim-name]') && e.key === 'Enter') {
      e.preventDefault();
      return;
    }

    if (!target.matches('[data-dim-value-input]')) return;
    const editor = target.closest<HTMLElement>('[data-variants-editor]');
    const dimEl = target.closest<HTMLElement>('[data-variant-dim]');
    if (!editor || !dimEl) return;
    const i18n = getDashI18n();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitVariantValue(dimEl, editor, i18n);
      expandValueAdder(dimEl, i18n); // stays open — cleared and refocused, for adding several values in a row
    } else if (e.key === 'Escape') {
      e.preventDefault();
      collapseValueAdder(dimEl, i18n);
    }
  });

  document.addEventListener('focusout', (e) => {
    const target = e.target as Element;
    if (!target.matches('[data-dim-value-input]')) return;
    const editor = target.closest<HTMLElement>('[data-variants-editor]');
    const dimEl = target.closest<HTMLElement>('[data-variant-dim]');
    if (!editor || !dimEl) return;
    const i18n = getDashI18n();
    commitVariantValue(dimEl, editor, i18n);
    collapseValueAdder(dimEl, i18n);
  });

  document.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    const editor = target.closest<HTMLElement>('[data-variants-editor]');
    if (!editor) return;

    if (target.matches('[data-combo-stock]')) {
      syncTotalStockField(editor);
      updateComboTotal(editor);
      return;
    }

    if (!target.matches('[data-dim-name]')) return;
    const dimEl = target.closest<HTMLElement>('[data-variant-dim]');
    if (!dimEl) return;
    const i18n = getDashI18n();
    revalidateAllDimNames(editor, i18n);
    const chipsWrap = dimEl.querySelector<HTMLElement>('[data-variant-chips]');
    if (!chipsWrap) return;
    // Re-uses the actual adder node (appendChild on an already-attached node
    // *moves* it, per DOM spec) instead of re-stringifying it — so whatever
    // state it was in survives, and there's no second place that has to
    // remember to keep re-adding it whenever chips get rebuilt.
    const adderEl = chipsWrap.querySelector<HTMLElement>('[data-dim-value-adder]');
    const options = [...chipsWrap.querySelectorAll<HTMLElement>('[data-variant-chip]')].map(c => c.dataset.value ?? '');
    chipsWrap.innerHTML = options.map(o => chipHtml(target.value, o, i18n)).join('');
    chipsWrap.appendChild(adderEl ?? createValueAdderElement(i18n));
    refreshVariantCombos(editor, i18n);
  });

  document.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;

    // Lives in the shared <body>-level portal, not inside any .variants-editor.
    if (target.matches('[data-combo-filter-value]')) {
      if (!comboFilterOpenWrap || !comboFilterOpenEditor) return;
      const portal = document.getElementById('combo-filter-portal');
      const checked = [...(portal?.querySelectorAll<HTMLInputElement>('[data-combo-filter-value]:checked') ?? [])]
        .map(c => c.dataset.comboFilterValue ?? '');
      setComboFilterSelection(comboFilterOpenWrap, checked);
      applyComboFilters(comboFilterOpenEditor);
      return;
    }

    const editor = target.closest<HTMLElement>('[data-variants-editor]');
    if (!editor) return;

    if (target.matches('.variant-chip-color-input')) {
      const chip = target.closest<HTMLElement>('[data-variant-chip]');
      const nameInput = target.closest<HTMLElement>('[data-variant-dim]')?.querySelector<HTMLInputElement>('[data-dim-name]');
      if (!chip || !nameInput) return;
      const baseName = resolveVariantColor(chip.dataset.value ?? '').display;
      const newValue = `${baseName} ${target.value}`;
      const i18n = getDashI18n();
      const wrapper = document.createElement('div');
      wrapper.innerHTML = chipHtml(nameInput.value, newValue, i18n);
      chip.replaceWith(wrapper.firstElementChild as HTMLElement);
      refreshVariantCombos(editor, i18n);
      return;
    }

    if (target.matches('input[name="stock"]')) refreshVariantCombos(editor, getDashI18n());
  });
}

export function initSpecsEditors(): void {
  document.addEventListener('click', (e) => {
    const addBtn = (e.target as Element).closest<HTMLButtonElement>('.specs-add-row');
    if (addBtn) {
      const container = addBtn.closest('.field')?.querySelector<HTMLElement>('.specs-rows');
      if (!container) return;
      const lp = container.dataset.labelPlaceholder ?? '';
      const vp = container.dataset.valuePlaceholder ?? '';
      const i18n = getDashI18n();
      const row = document.createElement('div');
      row.className = 'specs-row';
      row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem';
      row.innerHTML = `
        <input class="input" name="specs_label" placeholder="${esc(lp)}" style="flex:1">
        <input class="input" name="specs_value" placeholder="${esc(vp)}" style="flex:1">
        <button type="button" class="specs-remove-row btn btn--ghost btn--sm" aria-label="${esc(i18n.specsRemoveRow ?? 'Remove')}">×</button>`;
      container.appendChild(row);
      row.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    const removeBtn = (e.target as Element).closest<HTMLButtonElement>('.specs-remove-row');
    if (removeBtn) removeBtn.closest('.specs-row')?.remove();
  });
}

export function buildRows(p: ProductData, cloud: string, preset: string, storeSlug = '', storeName = ''): [HTMLTableRowElement, HTMLTableRowElement] {
  const i = getDashI18n();
  const g = getGalleryI18n();

  const uploadCfg = document.getElementById('upload-config');
  const resolvedStoreSlug = storeSlug || uploadCfg?.dataset.storeSlug || '';
  const resolvedStoreName = storeName || uploadCfg?.dataset.storeName || '';

  const display = document.createElement('tr');
  display.dataset.productDisplay = p.id;
  display.dataset.storeId = p.storeId;
  display.dataset.images = JSON.stringify(p.images ?? []);
  display.dataset.sortName = p.name.toLowerCase();
  display.dataset.sortPrice = String(p.price);
  display.dataset.sortStock = String(p.stock);
  display.dataset.sortWishlist = '0';
  display.dataset.sortCreatedAt = p.createdAt ?? '';
  display.dataset.category = p.category ?? '';
  display.dataset.productSlug = p.slug ?? '';
  display.dataset.storeSlug = resolvedStoreSlug;
  display.dataset.storeName = resolvedStoreName;
  display.dataset.hasVariants = p.variants?.length ? '1' : '';
  display.innerHTML = `
    <td class="check-col"><input type="checkbox" class="bulk-check" data-bulk-check="${p.id}" aria-label="${esc(p.name)}" style="cursor:pointer;width:15px;height:15px"></td>
    <td class="num row-num"></td>
    <td class="thumb-col">${p.images?.[0] ? `<span class="thumb-wrap"><img src="${esc(thumbUrl(p.images[0]))}" alt="" class="product-thumb" width="42" height="42" loading="lazy"></span>` : ''}</td>
    <td class="name-col">
      <span class="product-name">${esc(p.name)}</span>
      ${p.description ? `<span class="product-desc">${esc(p.description)}</span>` : ''}
      ${p.category ? `<span class="product-cat-chip">${esc(p.category)}</span>` : ''}
    </td>
    <td class="num product-price">${fmtPrice(p.price)}</td>
    <td class="num product-stock"><span style="display:inline-flex;align-items:center;gap:0.3rem">${stockHtml(p.stock, i.outOfStock ?? 'Out of stock')}${stockBreakdownHtml(p.variants, p.variantStock, p.stock, i)}</span></td>
    <td class="num" style="color:var(--color-muted);font-size:0.82rem">—</td>
    <td class="date-col">${esc(fmtDateAdded(p.createdAt))}</td>
    <td class="actions">
      <div class="product-menu">
        <button class="product-menu__btn" type="button" aria-label="${esc(i.menuLabel ?? 'אפשרויות')}" aria-expanded="false" aria-haspopup="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        <ul class="product-menu__dropdown" hidden role="menu">
          <li role="none"><button class="product-menu__item" type="button" data-view-product="${p.id}" role="menuitem"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${esc(i.viewProduct ?? 'צפה במוצר')}</button></li>
          <li role="none"><button class="product-menu__item" type="button" data-edit-toggle="${p.id}" role="menuitem"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${esc(i.edit ?? 'Edit')}</button></li>
          <li role="none"><button class="product-menu__item product-menu__item--danger" type="button" data-delete-product="${p.id}" data-store-id="${esc(p.storeId)}" role="menuitem"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>${esc(i.delete ?? 'Delete')}</button></li>
        </ul>
      </div>
    </td>`;

  const edit = document.createElement('tr');
  edit.className = 'edit-row';
  edit.dataset.productEdit = p.id;
  edit.hidden = true;
  edit.innerHTML = `
    <td class="num row-num"></td>
    <td colspan="7">
      <form method="POST" action="/api/product" class="dash-form inline-edit-form">
        <input type="hidden" name="_action" value="edit-product">
        <input type="hidden" name="productId" value="${p.id}">
        <div class="edit-row-header">
          ${p.images?.[0] ? `<img src="${esc(thumbUrl(p.images[0], 72, 72))}" alt="" width="36" height="36" loading="lazy" style="width:36px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0">` : ''}
          <span class="edit-row-title">${esc(p.name)}</span>
          <div class="form-actions" style="margin-inline-start:auto;margin-top:0">
            <button class="btn btn--sm" type="submit" style="min-width:5rem;text-align:center">${i.save ?? 'Save'}</button>
            <button class="btn btn--ghost btn--sm" type="button" data-cancel-edit="${p.id}">${i.cancel ?? 'Cancel'}</button>
          </div>
        </div>
        <div class="field-row">
          <label class="field"><span>${i.nameReq ?? 'Name *'}</span><input class="input" name="name" value="${esc(p.name)}" required></label>
          <label class="field"><span>${i.priceLabel ?? 'Price'}</span><input class="input" name="price" type="number" min="0" step="0.01" value="${p.price}"></label>
          <label class="field"><span>${i.colStock ?? 'Stock'}</span><input class="input" name="stock" type="number" min="0" step="1" value="${p.stock}"></label>
        </div>
        <label class="field"><span>${i.descLabel ?? 'Description'}</span><textarea class="input" name="description" rows="2">${esc(p.description)}</textarea></label>
        ${categoryFieldHtml(p.category ?? '', i)}
        ${tagsFieldHtml(p.tags ?? [], i)}
        ${variantsEditorHtml(p.variants ?? [], p.variantStock ?? {}, p.stock, i)}
        ${specsEditorHtml(p.specs ?? [], i)}
        <div class="field">
          <span class="field-label">${i.productImages ?? 'Product images'}</span>
          ${galleryWidgetHtml(p.images ?? [], g)}
        </div>
        <div class="form-actions">
          <button class="btn btn--sm" type="submit" style="min-width:5rem;text-align:center">${i.save ?? 'Save'}</button>
          <button class="btn btn--ghost btn--sm" type="button" data-cancel-edit="${p.id}">${i.cancel ?? 'Cancel'}</button>
        </div>
      </form>
    </td>`;

  return [display, edit];
}

async function handleEditSubmit(e: SubmitEvent, cloud: string, preset: string): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const productId = String(new FormData(form).get('productId'));
  // Save/Cancel are duplicated at the top of the form (near the header) and
  // at the bottom, so whichever one was clicked gets the same feedback.
  const submitBtns = [...form.querySelectorAll<HTMLButtonElement>('[type="submit"]')];
  const i18n = getDashI18n();
  const origText = submitBtns[0]?.textContent ?? (i18n.save ?? 'Save');
  const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;

  submitBtns.forEach(btn => { btn.disabled = true; btn.textContent = i18n.saving ?? 'Saving…'; });

  try {
    const gallery = form.querySelector<Element>('.gallery-widget');
    try {
      if (gallery) await resolveGalleryUrls(gallery, cloud, preset);
    } catch {
      submitBtns.forEach(btn => { btn.disabled = false; btn.textContent = origText; });
      showStatus(i18n.uploadFailed ?? 'Image upload failed. Please try again.', true);
      return;
    }

    const fd = new FormData(form);
    fd.set('variants_json', JSON.stringify(collectVariantsPayload(form)));
    const res = await fetch('/api/product', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; images?: string[]; error?: string };
    if (!data.ok) {
      submitBtns.forEach(btn => { btn.disabled = false; btn.textContent = origText; });
      showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true);
      return;
    }

    const savedImages = data.images ?? [];
    const savedImage = savedImages[0] ?? null;

    if (gallery) { finalizeGallery(gallery); closeGalleryPanel(gallery); }

    const displayRow = document.querySelector<HTMLTableRowElement>(`[data-product-display="${productId}"]`);
    const editRow    = document.querySelector<HTMLTableRowElement>(`[data-product-edit="${productId}"]`);

    if (displayRow) {
      const name = String(fd.get('name'));
      const description = String(fd.get('description'));
      const price = parseFloat(String(fd.get('price')));
      const stock = parseInt(String(fd.get('stock')), 10);

      const thumbCol = displayRow.querySelector<HTMLElement>('.thumb-col');
      const gallerySrc = (() => {
        if (!gallery) return null;
        const slot = gallery.querySelector<Element>('.gallery-slot');
        const filled = slot?.querySelector<HTMLElement>('.gallery-slot__filled');
        if (!filled || filled.hasAttribute('hidden')) return null;
        return slot?.querySelector<HTMLImageElement>('.gallery-slot__img')?.getAttribute('src') ?? null;
      })();
      const thumbSrc = gallerySrc || savedImage;
      if (thumbCol) {
        let wrap = thumbCol.querySelector<HTMLElement>('.thumb-wrap');
        let thumb = wrap?.querySelector<HTMLImageElement>('.product-thumb');
        if (thumbSrc) {
          if (!wrap) {
            wrap = document.createElement('span');
            wrap.className = 'thumb-wrap';
            thumb = document.createElement('img');
            thumb.className = 'product-thumb';
            thumb.width = 42; thumb.height = 42; thumb.alt = '';
            wrap.append(thumb);
            thumbCol.append(wrap);
          }
          if (thumb) thumb.src = thumbUrl(thumbSrc);
          wrap.classList.remove('loaded');
          initThumbs(thumbCol);
        } else { wrap?.remove(); }
      }

      const nameEl = displayRow.querySelector('.product-name');
      if (nameEl) nameEl.textContent = name;

      let descEl = displayRow.querySelector('.product-desc');
      if (description) {
        if (!descEl) { descEl = document.createElement('span'); descEl.className = 'product-desc'; nameEl?.after(descEl); }
        descEl.textContent = description;
      } else { descEl?.remove(); }

      const priceCell = displayRow.querySelector<HTMLElement>('.product-price');
      const stockCell = displayRow.querySelector<HTMLElement>('.product-stock');
      if (priceCell) priceCell.textContent = fmtPrice(price);
      if (stockCell) {
        const savedVariants = JSON.parse(String(fd.get('variants_json') || '{}')) as { variants?: VariantDimension[]; variantStock?: Record<string, number> };
        stockCell.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.3rem">${stockHtml(stock, i18n.outOfStock ?? 'Out of stock')}${stockBreakdownHtml(savedVariants.variants, savedVariants.variantStock, stock, i18n)}</span>`;
        displayRow.dataset.hasVariants = savedVariants.variants?.length ? '1' : '';
      }

      displayRow.dataset.sortName = name.toLowerCase();
      displayRow.dataset.sortPrice = String(price);
      displayRow.dataset.sortStock = String(stock);
    }

    // Lock width → swap label → animate → close after delay (same pattern as add-to-cart btn)
    submitBtns.forEach(btn => {
      btn.style.minWidth = `${btn.offsetWidth}px`;
      btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${checkSvg}${i18n.saved ?? 'נשמר'}</span>`;
      btn.disabled = true;
      btn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      );
    });
    setTimeout(() => {
      if (editRow) editRow.hidden = true;
      if (displayRow) displayRow.hidden = false;
      submitBtns.forEach(btn => { btn.disabled = false; btn.style.minWidth = ''; btn.textContent = origText; });
      // The just-saved form state is now the row's new baseline — a later
      // Cancel should revert here, not to the pre-edit snapshot from before
      // this save.
      if (editRow) originalEditHtml.set(editRow, editRow.innerHTML);
    }, 1500);
  } catch {
    submitBtns.forEach(btn => { btn.disabled = false; btn.textContent = origText; });
    showStatus(i18n.errorSaving ?? 'Error saving.', true);
  }
}

// Aligns the now-visible edit-row-header with the sticky offset it'll pin
// to (see .edit-row-header in dashboard.css) — plain scrollIntoView({block:
// 'start'}) targets the viewport's y:0, which the fixed site header would
// then cover; computing the exact target ourselves lands it right where it
// sticks instead, no matter where the row was on the page.
function scrollEditRowIntoView(edit: HTMLElement): void {
  const header = edit.querySelector<HTMLElement>('.edit-row-header');
  if (!header) return;

  const scrollToHeader = () => {
    const offset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--site-header-h')) || 0;
    const top = header.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  };
  scrollToHeader();

  // This is the row's first time visible, so its lazy-loaded gallery images
  // only start fetching now — their real size can land well after this
  // click, growing the row and leaving the one-shot target short of the
  // header. Re-aim for a short window whenever the row resizes, so the
  // scroll keeps chasing the header into place instead of undershooting.
  const ro = new ResizeObserver(scrollToHeader);
  ro.observe(edit);
  setTimeout(() => ro.disconnect(), 1500);
}

// Snapshot of each edit row's last-saved markup — Cancel restores this instead
// of just hiding the row, so an in-progress edit (e.g. a half-added variant
// dimension) is thrown away immediately rather than lingering in the DOM
// until the next full page reload silently reveals it was never saved.
const originalEditHtml = new WeakMap<HTMLTableRowElement, string>();

function bindEditFormInternals(display: HTMLTableRowElement, edit: HTMLTableRowElement, cloud: string, preset: string): void {
  edit.querySelectorAll('[data-cancel-edit]').forEach(btn => btn.addEventListener('click', () => {
    restoreEditRow(display, edit, cloud, preset);
  }));
  (edit.querySelector('form') as HTMLFormElement | null)
    ?.addEventListener('submit', (e) => void handleEditSubmit(e as SubmitEvent, cloud, preset));
  const gallery = edit.querySelector<Element>('.gallery-widget');
  if (gallery) initGalleryWidget(gallery, cloud, preset);
  const variantsEditor = edit.querySelector<HTMLElement>('[data-variants-editor]');
  if (variantsEditor) syncTotalStockField(variantsEditor);
}

function restoreEditRow(display: HTMLTableRowElement, edit: HTMLTableRowElement, cloud: string, preset: string): void {
  const original = originalEditHtml.get(edit);
  if (original !== undefined && edit.innerHTML !== original) {
    edit.innerHTML = original;
    bindEditFormInternals(display, edit, cloud, preset);
  }
  edit.hidden = true;
  display.hidden = false;
}

export function attachListeners(display: HTMLTableRowElement, edit: HTMLTableRowElement, cloud: string, preset: string): void {
  originalEditHtml.set(edit, edit.innerHTML);
  display.querySelector('[data-edit-toggle]')?.addEventListener('click', () => {
    display.hidden = true; edit.hidden = false;
    scrollEditRowIntoView(edit);
  });
  bindEditFormInternals(display, edit, cloud, preset);
}

export function bindExistingRows(cloud: string, preset: string): void {
  document.querySelectorAll<HTMLTableRowElement>('[data-product-display]').forEach((display) => {
    const edit = document.querySelector<HTMLTableRowElement>(`[data-product-edit="${display.dataset.productDisplay}"]`);
    if (edit) attachListeners(display, edit, cloud, preset);
  });
}

export function initAddProduct(cloud: string, preset: string): void {
  const addFormWrap = document.getElementById('add-product-form');
  const addForm = addFormWrap?.querySelector('form') as HTMLFormElement | null;
  const storeIdInput = addForm?.querySelector<HTMLInputElement>('input[name="storeId"]');

  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const i18n = getDashI18n();
    const submitBtn = addForm.querySelector<HTMLButtonElement>('[type="submit"]');
    const origText = submitBtn?.textContent ?? (i18n.addProductBtn ?? 'Add product');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = i18n.saving ?? 'Saving…'; }

    try {
      const gallery = addForm.querySelector<Element>('.gallery-widget');
      try {
        if (gallery) await resolveGalleryUrls(gallery, cloud, preset);
      } catch {
        showStatus(i18n.uploadFailed ?? 'Image upload failed. Please try again.', true);
        return;
      }

      const fd = new FormData(addForm);
      fd.set('variants_json', JSON.stringify(collectVariantsPayload(addForm)));
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; product?: ProductData; error?: string };
      if (!data.ok) { showStatus(data.error ?? (i18n.errorAdding ?? 'Error adding product.'), true); return; }

      const p = { ...data.product!, storeId: storeIdInput?.value ?? '' };
      const tbody = document.getElementById('products-tbody') as HTMLTableSectionElement | null;
      const table = document.getElementById('products-table') as HTMLTableElement | null;
      const emptyMsg = document.getElementById('empty-products');

      if (table) table.hidden = false;
      if (emptyMsg) emptyMsg.hidden = true;

      if (tbody) {
        const [display, edit] = buildRows(p, cloud, preset);
        attachListeners(display, edit, cloud, preset);
        tbody.append(display, edit);
        initThumbs(display);
        refreshCategoryFilter();
        applyPagination();
      }

      addForm.reset();
      resetVariantsEditor(addForm);
      if (gallery) resetGallery(gallery);
      addFormWrap?.setAttribute('hidden', '');
      document.getElementById('toggle-add-form')?.removeAttribute('hidden');
      showStatus(i18n.productAdded ?? 'Product added.');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText; }
    }
  });
}

export function initProductMenus(): void {
  function closeAll(exceptMenu?: HTMLElement) {
    document.querySelectorAll<HTMLButtonElement>('.product-menu__btn[aria-expanded="true"]').forEach(btn => {
      const pm = btn.closest<HTMLElement>('.product-menu');
      if (pm && pm === exceptMenu) return;
      btn.setAttribute('aria-expanded', 'false');
      pm?.querySelector<HTMLElement>('.product-menu__dropdown')?.setAttribute('hidden', '');
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Element;

    const triggerBtn = target.closest<HTMLButtonElement>('.product-menu__btn');
    if (triggerBtn) {
      const pm = triggerBtn.closest<HTMLElement>('.product-menu');
      const dropdown = pm?.querySelector<HTMLElement>('.product-menu__dropdown');
      if (!pm || !dropdown) return;
      const isOpen = triggerBtn.getAttribute('aria-expanded') === 'true';
      closeAll(isOpen ? undefined : pm);
      triggerBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      if (isOpen) { dropdown.setAttribute('hidden', ''); } else {
        dropdown.removeAttribute('hidden');
        (dropdown.querySelector<HTMLButtonElement>('[role="menuitem"]'))?.focus();
      }
      return;
    }

    if (target.closest('.product-menu__item')) { closeAll(); return; }
    if (!target.closest('.product-menu')) closeAll();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openBtn = document.querySelector<HTMLButtonElement>('.product-menu__btn[aria-expanded="true"]');
      if (openBtn) { closeAll(); openBtn.focus(); }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const active = document.activeElement as HTMLElement;
      const dropdown = active.closest<HTMLElement>('.product-menu__dropdown');
      if (!dropdown) return;
      e.preventDefault();
      const items = [...dropdown.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const idx = items.indexOf(active as HTMLButtonElement);
      if (e.key === 'ArrowDown') items[(idx + 1) % items.length]?.focus();
      else items[(idx - 1 + items.length) % items.length]?.focus();
    }
  });
}

export function initDeleteProduct(): void {
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-delete-product]');
    if (!btn) return;
    const productId = btn.dataset.deleteProduct ?? '';
    const storeId   = btn.dataset.storeId ?? '';
    const row = document.querySelector(`[data-product-display="${productId}"]`);
    const productName = row?.querySelector('.product-name')?.textContent ?? '';
    const i18n = getDashI18n();

    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: i18n.deleteProductTitle ?? 'Delete product?',
        message: `"${productName}" ${i18n.deleteProductMsg ?? 'will be permanently deleted.'}`,
        okLabel: i18n.delete ?? 'Delete',
        onConfirm: async () => {
          const fd = new FormData();
          fd.set('_action', 'delete-product');
          fd.set('productId', productId);
          fd.set('storeId', storeId);
          const res = await fetch('/api/product', { method: 'POST', body: fd });
          const data = await res.json() as { ok: boolean; error?: string };
          if (!data.ok) { showStatus(data.error ?? (i18n.errorDeleting ?? 'Error deleting.'), true); return; }

          document.querySelector(`[data-product-display="${productId}"]`)?.remove();
          document.querySelector(`[data-product-edit="${productId}"]`)?.remove();
          refreshCategoryFilter();
          applyPagination();

          const tbody = document.getElementById('products-tbody');
          if (tbody && tbody.querySelectorAll('[data-product-display]').length === 0) {
            document.getElementById('products-table')?.setAttribute('hidden', '');
            document.getElementById('empty-products')?.removeAttribute('hidden');
          }
          showStatus(i18n.productDeleted ?? 'Product deleted.');
        },
      },
    }));
  });
}

export function initThumbs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.thumb-wrap').forEach(wrap => {
    if (wrap.classList.contains('loaded')) return;
    const img = wrap.querySelector<HTMLImageElement>('.product-thumb');
    if (!img) return;
    const markLoaded = () => wrap.classList.add('loaded');
    const decodeAndMark = () => img.decode().then(markLoaded).catch(markLoaded);
    if (img.complete) {
      if (img.naturalWidth > 0) decodeAndMark(); else markLoaded();
    } else {
      img.addEventListener('load', decodeAndMark, { once: true });
      img.addEventListener('error', markLoaded, { once: true });
    }
  });
}

export function renumberRows(): void {
  let n = 0;
  document.querySelectorAll<HTMLElement>('#products-tbody [data-product-display]').forEach((row) => {
    if (!rowMatchesCategoryFilter(row)) return;
    n++;
    const cell = row.querySelector<HTMLElement>('.row-num');
    if (cell) cell.textContent = String(n);
    const productId = row.dataset.productDisplay;
    if (productId) {
      const editNum = document.querySelector<HTMLElement>(`[data-product-edit="${productId}"] .row-num`);
      if (editNum) editNum.textContent = String(n);
    }
  });
}

function renderPaginationControls(totalPages: number): void {
  const nav = document.getElementById('products-pagination') as HTMLElement | null;
  if (!nav) return;
  if (totalPages <= 1) { nav.hidden = true; nav.innerHTML = ''; return; }

  const i = getDashI18n();
  const pageInfo = (i.paginationPageInfo ?? 'עמוד {page} מתוך {total}')
    .replace('{page}', String(productsCurrentPage))
    .replace('{total}', String(totalPages));

  nav.hidden = false;
  nav.innerHTML = `
    <button type="button" class="btn btn--ghost btn--sm" data-page-prev${productsCurrentPage <= 1 ? ' disabled' : ''}>${esc(i.paginationPrev ?? 'הקודם')}</button>
    <span class="products-pagination__info">${esc(pageInfo)}</span>
    <button type="button" class="btn btn--ghost btn--sm" data-page-next${productsCurrentPage >= totalPages ? ' disabled' : ''}>${esc(i.paginationNext ?? 'הבא')}</button>
  `;
}

export function applyPagination(): void {
  const tbody = document.getElementById('products-tbody');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll<HTMLElement>('[data-product-display]'));
  const matchedCount = rows.reduce((n, row) => n + (rowMatchesCategoryFilter(row) ? 1 : 0), 0);
  const totalPages = Math.max(1, Math.ceil(matchedCount / PRODUCTS_PAGE_SIZE));
  productsCurrentPage = Math.min(Math.max(productsCurrentPage, 1), totalPages);

  const start = (productsCurrentPage - 1) * PRODUCTS_PAGE_SIZE;
  const end = start + PRODUCTS_PAGE_SIZE;

  let matchIdx = 0;
  rows.forEach((row) => {
    const editRow = document.querySelector<HTMLElement>(`[data-product-edit="${row.dataset.productDisplay}"]`);
    if (!rowMatchesCategoryFilter(row)) {
      row.hidden = true;
      if (editRow) editRow.hidden = true;
      return;
    }
    const onPage = matchIdx >= start && matchIdx < end;
    row.hidden = !onPage;
    if (editRow && !onPage) editRow.hidden = true;
    matchIdx++;
  });

  renumberRows();
  renderPaginationControls(totalPages);
}

export function initPagination(): void {
  const nav = document.getElementById('products-pagination') as HTMLElement | null;
  if (!nav) return;

  nav.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-page-prev], [data-page-next]');
    if (!btn || btn.disabled) return;
    productsCurrentPage += btn.hasAttribute('data-page-prev') ? -1 : 1;
    applyPagination();
    document.getElementById('products-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  applyPagination();
}

// Measures the real fixed-header + products-toolbar heights so the sticky
// toolbar/table-header sit flush regardless of font-loading/wrap differences.
export function initStickyOffsets(): void {
  const root = document.documentElement;
  const siteHeader = document.querySelector<HTMLElement>('.site-header');
  const toolbar = document.querySelector<HTMLElement>('.products-header');
  if (!siteHeader && !toolbar) return;

  // getBoundingClientRect (fractional) instead of offsetHeight (rounds to the
  // nearest integer px) — the rounding alone was enough to leave a 1-2px seam.
  const updateHeaderH = () => { if (siteHeader) root.style.setProperty('--site-header-h', `${siteHeader.getBoundingClientRect().height}px`); };
  const updateToolbarH = () => { if (toolbar) root.style.setProperty('--products-toolbar-h', `${toolbar.getBoundingClientRect().height}px`); };

  updateHeaderH();
  updateToolbarH();

  if (typeof ResizeObserver !== 'undefined') {
    if (siteHeader) new ResizeObserver(updateHeaderH).observe(siteHeader);
    if (toolbar) new ResizeObserver(updateToolbarH).observe(toolbar);
  } else {
    window.addEventListener('resize', () => { updateHeaderH(); updateToolbarH(); });
  }
}

export function initTableSort(): void {
  let sortCol = '';
  let sortDir = 'asc';

  function sortTable(col: string) {
    const defaultDir = col === 'wishlist' || col === 'createdAt' ? 'desc' : 'asc';
    sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : defaultDir;
    sortCol = col;

    const tbody = document.getElementById('products-tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('[data-product-display]'));
    rows.sort((a, b) => {
      let va: string | number = '';
      let vb: string | number = '';
      if (col === 'name')     { va = a.dataset.sortName     ?? ''; vb = b.dataset.sortName     ?? ''; }
      if (col === 'price')    { va = parseFloat(a.dataset.sortPrice    ?? '0'); vb = parseFloat(b.dataset.sortPrice    ?? '0'); }
      if (col === 'stock')    { va = parseInt(a.dataset.sortStock   ?? '0', 10); vb = parseInt(b.dataset.sortStock   ?? '0', 10); }
      if (col === 'wishlist') { va = parseInt(a.dataset.sortWishlist ?? '0', 10); vb = parseInt(b.dataset.sortWishlist ?? '0', 10); }
      if (col === 'category') { va = (a.dataset.category ?? '').toLowerCase(); vb = (b.dataset.category ?? '').toLowerCase(); }
      if (col === 'createdAt') { va = a.dataset.sortCreatedAt ?? ''; vb = b.dataset.sortCreatedAt ?? ''; }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    for (const display of rows) {
      const edit = tbody.querySelector<HTMLTableRowElement>(`[data-product-edit="${display.dataset.productDisplay}"]`);
      tbody.append(display);
      if (edit) tbody.append(edit);
    }
    productsCurrentPage = 1;
    applyPagination();

    document.querySelectorAll<HTMLButtonElement>('.sort-btn').forEach((btn) => {
      if (btn.dataset.sortCol === col) {
        btn.dataset.active = 'true';
        btn.dataset.dir = sortDir;
      } else {
        delete btn.dataset.active;
        delete btn.dataset.dir;
      }
    });
  }

  document.querySelectorAll<HTMLButtonElement>('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (btn.dataset.sortCol) sortTable(btn.dataset.sortCol); });
  });
}

// ── View product (open PQV modal) ─────────────────────────────────────────────

export function initViewProduct(): void {
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-view-product]');
    if (!btn) return;
    const productId = btn.dataset.viewProduct ?? '';
    const row = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
    if (!row) return;
    const storeSlug   = row.dataset.storeSlug ?? '';
    const productSlug = row.dataset.productSlug ?? '';
    const storeName   = row.dataset.storeName ?? '';
    if (!storeSlug || !productSlug) return;
    window.dispatchEvent(new CustomEvent('pqv:open', {
      detail: { storeSlug, productSlug, storeName, newTab: true },
    }));
  });
}

// ── Inline field editing ──────────────────────────────────────────────────────

function activateInlineEdit(
  trigger: HTMLElement,
  row: HTMLElement,
  productId: string,
  field: 'name' | 'price' | 'stock',
  i: Record<string, string>,
): void {
  if (trigger.dataset.inlineActive) return;
  trigger.dataset.inlineActive = '1';

  const savedInner = trigger.innerHTML;
  const rawValue =
    field === 'name'  ? (trigger.textContent?.trim() ?? '')
    : field === 'price' ? (row.dataset.sortPrice ?? '0')
    : (row.dataset.sortStock ?? '0');

  const input = document.createElement('input');
  input.type = field === 'name' ? 'text' : 'number';
  input.value = rawValue;
  input.className = field === 'name' ? 'inline-input' : 'inline-input inline-input--num';
  if (field !== 'name') {
    input.min = '0';
    input.step = field === 'price' ? '0.01' : '1';
    const setW = () => { input.style.width = `${Math.max(input.value.length + 1, 4)}ch`; };
    setW();
    input.addEventListener('input', setW);
  } else {
    input.style.flex = '1';
  }
  input.setAttribute('aria-label', field === 'name' ? 'שם מוצר' : field === 'price' ? 'מחיר' : 'מלאי');

  const xBtn = document.createElement('button');
  xBtn.type = 'button';
  xBtn.className = 'inline-cancel-btn';
  xBtn.setAttribute('aria-label', 'ביטול');
  xBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  xBtn.addEventListener('mousedown', (e) => e.preventDefault());
  xBtn.addEventListener('click', () => cancel());

  const wrapper = document.createElement('span');
  wrapper.style.cssText = `display:inline-flex;align-items:center;gap:0.25rem${field === 'name' ? ';width:100%' : ''}`;
  wrapper.appendChild(input);
  wrapper.appendChild(xBtn);

  trigger.innerHTML = '';
  trigger.appendChild(wrapper);
  input.focus();
  input.select();

  let done = false;

  function cancel(): void {
    done = true;
    trigger.innerHTML = savedInner;
    delete trigger.dataset.inlineActive;
  }

  async function commit(): Promise<void> {
    if (done) return;
    done = true;

    const val = input.value;
    if (field === 'name' && !val.trim()) { cancel(); return; }

    const fd = new FormData();
    fd.set('_action', 'patch-product-fields');
    fd.set('productId', productId);
    fd.set(field, val);

    try {
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; product?: { name: string; price: number; stock: number }; error?: string };

      if (!data.ok) {
        showStatus(data.error ?? (i.errorSaving ?? 'שגיאה בשמירה.'), true);
        cancel();
        return;
      }

      const p = data.product!;
      delete trigger.dataset.inlineActive;

      if (field === 'name') {
        trigger.textContent = p.name;
        row.dataset.sortName = p.name.toLowerCase();
        row.querySelector<HTMLInputElement>('[data-bulk-check]')?.setAttribute('aria-label', p.name);
        const editRow = row.nextElementSibling;
        const editTitle = editRow?.querySelector<HTMLElement>('.edit-row-title');
        const editInput = editRow?.querySelector<HTMLInputElement>('[name="name"]');
        if (editTitle) editTitle.textContent = p.name;
        if (editInput) editInput.value = p.name;
      } else if (field === 'price') {
        trigger.textContent = fmtPrice(p.price);
        row.dataset.sortPrice = String(p.price);
        const editInput = row.nextElementSibling?.querySelector<HTMLInputElement>('[name="price"]');
        if (editInput) editInput.value = String(p.price);
      } else {
        trigger.innerHTML = stockHtml(p.stock, i.outOfStock ?? 'אזל מהמלאי');
        row.dataset.sortStock = String(p.stock);
        const editInput = row.nextElementSibling?.querySelector<HTMLInputElement>('[name="stock"]');
        if (editInput) editInput.value = String(p.stock);
      }
    } catch {
      showStatus(i.errorSaving ?? 'שגיאה בשמירה.', true);
      cancel();
    }
  }

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => { if (!done) void commit(); });
}

export function initInlineEdit(): void {
  const i = getDashI18n();

  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('.inline-input')) return;
    if (target.closest('[data-stock-breakdown]')) return;

    const nameEl   = target.closest<HTMLElement>('.product-name');
    const priceEl  = !nameEl ? target.closest<HTMLElement>('.product-price') : null;
    const stockEl  = !nameEl && !priceEl ? target.closest<HTMLElement>('.product-stock') : null;
    const trigger  = nameEl ?? priceEl ?? stockEl;
    if (!trigger) return;

    const row = trigger.closest<HTMLElement>('[data-product-display]');
    if (!row) return;

    // Once a product has variants, its total stock is a computed sum — edit it
    // via the full form (with the per-combo breakdown), not as a raw number here.
    if (stockEl && row.dataset.hasVariants) return;

    const productId = row.dataset.productDisplay ?? '';

    // Don't activate while full edit row is open
    const editRow = document.querySelector<HTMLElement>(`[data-product-edit="${productId}"]`);
    if (editRow && !editRow.hidden) return;

    const field = nameEl ? 'name' : priceEl ? 'price' : 'stock';
    activateInlineEdit(trigger, row, productId, field as 'name' | 'price' | 'stock', i);
  });
}

export function initStockBreakdowns(): void {
  function closeAll(except?: HTMLElement): void {
    document.querySelectorAll<HTMLButtonElement>('.stock-breakdown__btn[aria-expanded="true"]').forEach((btn) => {
      const wrap = btn.closest<HTMLElement>('[data-stock-breakdown]');
      if (wrap && wrap === except) return;
      btn.setAttribute('aria-expanded', 'false');
      wrap?.querySelector<HTMLElement>('.stock-breakdown__dropdown')?.setAttribute('hidden', '');
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const btn = target.closest<HTMLButtonElement>('.stock-breakdown__btn');
    if (btn) {
      const wrap = btn.closest<HTMLElement>('[data-stock-breakdown]');
      const dropdown = wrap?.querySelector<HTMLElement>('.stock-breakdown__dropdown');
      if (!wrap || !dropdown) return;
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      closeAll(isOpen ? undefined : wrap);
      btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      dropdown.hidden = isOpen;
      return;
    }
    if (!target.closest('[data-stock-breakdown]')) closeAll();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
}

// ── Category filter ───────────────────────────────────────────────────────────

let _refreshCatFilter: (() => void) | null = null;

export function refreshCategoryFilter(): void {
  _refreshCatFilter?.();
}

export function initCategoryFilter(): void {
  const bar = document.getElementById('cat-filter-bar') as HTMLElement | null;
  if (!bar) return;

  const i = getDashI18n();

  function getCategories(): string[] {
    const cats = new Set<string>();
    document.querySelectorAll<HTMLElement>('[data-product-display]').forEach((r) => {
      const c = r.dataset.category;
      if (c) cats.add(c);
    });
    return [...cats].sort();
  }

  function renderChips(): void {
    const cats = getCategories();
    if (cats.length === 0) { bar!.hidden = true; return; }
    if (!cats.includes(productsActiveCategory)) productsActiveCategory = '';
    bar!.hidden = false;
    bar!.innerHTML = [
      `<button type="button" class="cat-chip${!productsActiveCategory ? ' cat-chip--active' : ''}" data-filter-cat="">${esc(i.filterAll ?? 'הכל')}</button>`,
      ...cats.map((c) => `<button type="button" class="cat-chip${productsActiveCategory === c ? ' cat-chip--active' : ''}" data-filter-cat="${esc(c)}">${esc(c)}</button>`),
    ].join('');
  }

  bar.addEventListener('click', (e) => {
    const chip = (e.target as Element).closest<HTMLButtonElement>('[data-filter-cat]');
    if (!chip) return;
    productsActiveCategory = chip.dataset.filterCat ?? '';
    renderChips();
    productsCurrentPage = 1;
    applyPagination();
  });

  renderChips();
  _refreshCatFilter = renderChips;
}

export function initBulkSelect(cloud: string, preset: string): void {
  const uploadPanel    = document.getElementById('bulk-upload-panel') as HTMLElement | null;
  const header         = document.querySelector<HTMLElement>('.products-header');
  // Two physical checkboxes share the same job: the table-header one (desktop,
  // where the column header row is visible) and a toolbar one that only shows
  // once the mobile breakpoint collapses the table to cards and hides that
  // header row entirely — without it, select-all would be unreachable on
  // mobile. Kept in sync as a pair everywhere below instead of a single el.
  const selectAllChks  = Array.from(document.querySelectorAll<HTMLInputElement>('.bulk-select-all'));
  const bulkCountEl    = document.getElementById('bulk-count') as HTMLElement | null;
  const bulkCountBadge = document.getElementById('bulk-count-badge') as HTMLElement | null;
  const bulkCountParen = document.getElementById('bulk-count-paren') as HTMLElement | null;
  const bulkDeleteBtn  = document.getElementById('bulk-delete-btn') as HTMLButtonElement | null;
  const bulkUploadBtn  = document.getElementById('bulk-upload-btn') as HTMLButtonElement | null;
  const bulkEditBtn    = document.getElementById('bulk-edit-btn') as HTMLButtonElement | null;

  const selected = new Set<string>();
  const i = getDashI18n();

  function getCheckboxes(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>('[data-bulk-check]'));
  }

  const bulkSep = document.getElementById('bulk-sep') as HTMLElement | null;

  function updateBar(): void {
    const count = selected.size;
    const empty = count === 0;
    if (bulkCountEl) bulkCountEl.textContent = String(count);
    if (bulkCountBadge) bulkCountBadge.hidden = empty;
    if (bulkCountParen) bulkCountParen.textContent = empty ? '' : `(${count})`;
    selectAllChks.forEach((chk) => {
      chk.setAttribute('aria-label', empty
        ? (i.bulkSelectAll ?? 'בחר הכל')
        : `${i.bulkSelectAll ?? 'בחר הכל'} — ${count} ${i.bulkSelected ?? 'נבחרו'}`);
    });
    if (bulkDeleteBtn) bulkDeleteBtn.hidden = empty;
    if (bulkUploadBtn) bulkUploadBtn.hidden = empty;
    if (bulkEditBtn) bulkEditBtn.hidden = empty;
    if (bulkSep) bulkSep.hidden = empty;
    header?.classList.toggle('products-header--selecting', !empty);
    if (empty && uploadPanel) uploadPanel.hidden = true;
    if (empty && bulkEditLabel) bulkEditLabel.textContent = i.bulkEdit ?? 'ערוך';
    if (empty && bulkEditBtn) bulkEditBtn.setAttribute('aria-label', i.bulkEdit ?? 'ערוך');
    if (empty) selectAllChks.forEach((chk) => { chk.hidden = false; });

    selectAllChks.forEach((chk) => {
      chk.indeterminate = selected.size > 0;
      chk.checked = false;
    });
  }

  // Checkbox change (delegated)
  document.addEventListener('change', (e) => {
    const chk = (e.target as Element).closest<HTMLInputElement>('[data-bulk-check]');
    if (!chk) return;
    const id = chk.dataset.bulkCheck ?? '';
    if (chk.checked) selected.add(id); else selected.delete(id);
    updateBar();
  });

  // Click on thumbnail or serial number → toggle that row's checkbox too,
  // so selecting more products doesn't require aiming for the small checkbox.
  document.addEventListener('click', (e) => {
    const cell = (e.target as Element).closest<HTMLElement>('.thumb-col, .row-num');
    if (!cell) return;
    const row = cell.closest<HTMLElement>('[data-product-display]');
    const id  = row?.dataset.productDisplay;
    if (!id) return;
    const chk = document.querySelector<HTMLInputElement>(`[data-bulk-check="${id}"]`);
    if (!chk) return;
    chk.checked = !chk.checked;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Select all — if anything is selected, deselect all; else select all
  // Read selected.size BEFORE loop (still reflects pre-click state in change handler)
  selectAllChks.forEach((chk) => chk.addEventListener('change', () => {
    const shouldSelect = selected.size === 0;
    getCheckboxes().forEach((c) => {
      c.checked = shouldSelect;
      const id = c.dataset.bulkCheck ?? '';
      if (shouldSelect) selected.add(id); else selected.delete(id);
    });
    updateBar();
  }));

  // Bulk delete
  bulkDeleteBtn?.addEventListener('click', () => {
    const count = selected.size;
    if (!count) return;
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: i.bulkDeleteTitle ?? `מחיקת ${count} מוצרים`,
        message: `${count} ${i.bulkDeleteMsg ?? 'מוצרים יימחקו לצמיתות.'}`,
        okLabel: `${i.bulkDelete ?? 'מחק'} (${count})`,
        onConfirm: async () => {
          const ids = Array.from(selected);
          await Promise.all(ids.map(async (productId) => {
            const row = document.querySelector<HTMLTableRowElement>(`[data-product-display="${productId}"]`);
            const storeId = row?.dataset.storeId ?? '';
            const fd = new FormData();
            fd.set('_action', 'delete-product');
            fd.set('productId', productId);
            fd.set('storeId', storeId);
            const res = await fetch('/api/product', { method: 'POST', body: fd });
            const data = await res.json() as { ok: boolean };
            if (data.ok) {
              document.querySelector(`[data-product-display="${productId}"]`)?.remove();
              document.querySelector(`[data-product-edit="${productId}"]`)?.remove();
              selected.delete(productId);
            }
          }));
          updateBar();
          const tbody = document.getElementById('products-tbody');
          if (tbody && tbody.querySelectorAll('[data-product-display]').length === 0) {
            document.getElementById('products-table')?.setAttribute('hidden', '');
            document.getElementById('empty-products')?.removeAttribute('hidden');
          }
          refreshCategoryFilter();
          applyPagination();
          showStatus(i.bulkDeleted ?? 'המוצרים נמחקו.');
        },
      },
    }));
  });

  // Bulk image upload — show panel
  bulkUploadBtn?.addEventListener('click', () => {
    if (!uploadPanel || !selected.size) return;
    renderUploadPanel();
    uploadPanel.hidden = false;
    uploadPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // Bulk edit — toggle: if any selected edit row is open → close all; else open all
  const bulkEditLabel = document.getElementById('bulk-edit-label') as HTMLElement | null;
  bulkEditBtn?.addEventListener('click', () => {
    if (!selected.size) return;
    const anyOpen = Array.from(selected).some((productId) =>
      !(document.querySelector<HTMLElement>(`[data-product-edit="${productId}"]`)?.hidden ?? true)
    );
    let firstRow: HTMLElement | undefined;
    selected.forEach((productId) => {
      const displayRow = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
      const editRow    = document.querySelector<HTMLElement>(`[data-product-edit="${productId}"]`);
      if (displayRow && editRow) {
        if (anyOpen) {
          editRow.hidden = true;
          displayRow.hidden = false;
        } else {
          displayRow.hidden = true;
          editRow.hidden = false;
          if (!firstRow) firstRow = editRow;
        }
      }
    });
    if (bulkEditLabel) {
      bulkEditLabel.textContent = anyOpen ? (i.bulkEdit ?? 'ערוך') : (i.bulkEditClose ?? 'סגור עריכה');
    }
    bulkEditBtn?.setAttribute('aria-label', anyOpen ? (i.bulkEdit ?? 'ערוך') : (i.bulkEditClose ?? 'סגור עריכה'));
    selectAllChks.forEach((chk) => { chk.hidden = !anyOpen; });
    if (!anyOpen) firstRow?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function renderUploadPanel(): void {
    if (!uploadPanel) return;
    const g = getGalleryI18n();
    const spinnerSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="animation:spin 0.75s linear infinite"><circle cx="12" cy="12" r="10" opacity="0.2"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
    const checkSvg   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success,#22c55e)" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

    uploadPanel.innerHTML = `
      <div class="bulk-upload-header">
        <span>${i.bulkUploadImages ?? 'העלה תמונות'}</span>
        <button type="button" class="btn btn--ghost btn--sm" id="bulk-upload-close" aria-label="סגור">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="bulk-upload-list">
        ${Array.from(selected).map((productId) => {
          const row = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
          const name = row?.querySelector('.product-name')?.textContent?.trim() ?? '';
          let images: string[] = [];
          try { images = JSON.parse(row?.dataset.images ?? '[]') as string[]; } catch { images = []; }
          return `
            <div class="bulk-upload-item" data-upload-product="${productId}">
              <div class="bulk-upload-item-header">
                <span class="bulk-upload-name">${esc(name)}</span>
                <span class="bulk-img-status" data-status-product="${productId}" aria-live="polite"></span>
              </div>
              <div class="gallery-widget">
                ${galleryWidgetHtml(images, g)}
              </div>
            </div>`;
        }).join('')}
      </div>`;

    document.getElementById('bulk-upload-close')?.addEventListener('click', () => {
      if (uploadPanel) uploadPanel.hidden = true;
    });

    // Init all gallery widgets inside the panel
    uploadPanel.querySelectorAll<Element>('.gallery-widget').forEach((gEl) => {
      initGalleryWidget(gEl, cloud, preset);
    });

    // Auto-save when user clicks "Done" in any gallery panel
    const saving = new Set<string>();

    uploadPanel.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('.gallery-done-btn')) return;
      const item = (e.target as Element).closest<HTMLElement>('.bulk-upload-item');
      if (!item) return;
      const productId = item.dataset.uploadProduct ?? '';
      if (!productId || saving.has(productId)) return;

      const galleryEl = item.querySelector<Element>('.gallery-widget');
      if (!galleryEl) return;
      const statusEl = item.querySelector<HTMLElement>('.bulk-img-status');

      saving.add(productId);
      if (statusEl) statusEl.innerHTML = spinnerSvg;

      resolveGalleryUrls(galleryEl, cloud, preset)
        .then(() => {
          const urls = Array.from(
            galleryEl.querySelectorAll<HTMLInputElement>('.gallery-slot__url')
          ).map((inp) => inp.value).filter(Boolean);

          const fd = new FormData();
          fd.set('_action', 'patch-product-images');
          fd.set('productId', productId);
          urls.forEach((url) => fd.append('images', url));
          return fetch('/api/product', { method: 'POST', body: fd })
            .then((r) => r.json() as Promise<{ ok: boolean; images?: string[] }>)
            .then((data) => ({ data, urls }));
        })
        .then(({ data, urls }) => {
          if (data.ok) {
            const savedImages = data.images ?? urls;
            const row = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
            if (row && savedImages.length) {
              row.dataset.images = JSON.stringify(savedImages);
              const firstUrl = savedImages[0];
              const thumbCol = row.querySelector<HTMLElement>('.thumb-col');
              let wrap = thumbCol?.querySelector<HTMLElement>('.thumb-wrap');
              let rowThumb = wrap?.querySelector<HTMLImageElement>('.product-thumb');
              if (thumbCol) {
                if (!wrap) {
                  wrap = document.createElement('span');
                  wrap.className = 'thumb-wrap';
                  rowThumb = document.createElement('img');
                  rowThumb.className = 'product-thumb';
                  rowThumb.width = 42; rowThumb.height = 42; rowThumb.alt = '';
                  wrap.append(rowThumb);
                  thumbCol.append(wrap);
                }
                if (rowThumb) rowThumb.src = thumbUrl(firstUrl);
                if (wrap) { wrap.classList.remove('loaded'); initThumbs(wrap); }
              }
            }
            if (statusEl) {
              statusEl.innerHTML = checkSvg;
              setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 2000);
            }
          } else {
            if (statusEl) {
              statusEl.innerHTML = `<span style="color:var(--color-danger);font-size:0.78rem">${i.uploadError ?? 'שגיאה'}</span>`;
              setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 2500);
            }
          }
        })
        .catch(() => {
          if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--color-danger);font-size:0.78rem">${i.uploadError ?? 'שגיאה'}</span>`;
            setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 2500);
          }
        })
        .finally(() => { saving.delete(productId); });
    });
  }
}
