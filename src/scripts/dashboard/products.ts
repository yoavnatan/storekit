import { esc } from '../../lib/gallery-widget.js';
import { showActionFailedToast } from '../../lib/toast.js';
import { galleryWidgetHtml, initGalleryWidget, resolveGalleryUrls, resetGallery, finalizeGallery, closeGalleryPanel } from './gallery.js';
import { isUploadRefusal } from './cloudinary.js';
import { showStatus } from './status.js';
import { formatPrice } from '../../config/store.config.js';
import { thumbUrl } from './cloudinary.js';
import { scrollBelowPinnedChrome, scrollRowBackIntoView } from './scroll-utils.js';
import { createFetchGate, initListPager, markListBusy, renderListPagers, type PagerLabels } from './list-pager.js';
import { takePanelIntent } from './panel-intent.js';
import { resolveVariantColor, isColorVariant } from '../../lib/color-variants.js';
import { canonicalDimName, LOW_STOCK_THRESHOLD, comboStockRows, type VariantDimension } from '../../lib/variant-combo.js';
import { createFloatingPortal, toolbarMenuTitle, filterClearButtonHtml } from '../../lib/toolbar-portal.js';
import { lockTableColumns, unlockTableColumns } from '../../lib/table-column-lock.js';
import { initImageSkeletons, SKELETON_ATTR } from '../../lib/img-skeleton.js';
import type { CategoryNode } from '../../lib/store-categories.js';
import { getCategoryTree } from './category-tree-cache.js';
import { NO_CATEGORY_TOKEN } from '../../lib/seller-products-query.js';
import { armSelectAll, clearBulkSelection, disarmSelectAll, isSelectAllArmed, onBulkSelectionChange, selectedRowIds, setBulkSelected, syncBulkSelectionToRows } from './bulk-selection.js';
import { initCategoryPicker } from './category-picker.js';
import { initInfoTooltips } from '../tooltip.js';
import { encodeList, debounce } from '../../lib/admin-nav.js';
import { suggestTags } from '../../lib/tag-suggest.js';
import { discountFieldHtml, discountFieldLabels } from '../../lib/discount-field.js';
import { productSeoPanelHtml, productSeoLabels, productSeoRowGaugeHtml, type ProductSeoPreview } from '../../lib/product-seo-field.js';
import { productSeoInputFrom } from '../../lib/product-seo-hints.js';
import { refreshProductSeoPanels } from './product-seo.js';
import { resolvePrice, type ProductDiscount, type StoreSale } from '../../lib/discounts.js';
import { refreshDiscountFieldsIn } from './discount-field.js';
import { markDashboardStale, conflictMessage, registerPanelRefresh } from './tab-sync.js';

export interface ProductData {
  id: string; storeId: string; slug?: string; name: string;
  description: string; price: number; stock: number; images?: string[];
  categoryId?: string; tags?: string[]; sku?: string;
  /** Empty/absent = the store's own name is published as the brand (store-products.ts). */
  brand?: string;
  specs?: Array<{ label: string; value: string }>;
  sellerNote?: string;
  /** The product's own markdown, so a client-rebuilt edit row shows the same discount block the
   *  server rendered (lib/discount-field.ts). */
  discount?: ProductDiscount;
  variants?: VariantDimension[];
  variantStock?: Record<string, number>;
  variantImages?: Record<string, string>;
  hidden?: boolean;
  /** One of the store card's picks — see `setProductFeatured`. Carried here because this renderer
   *  REBUILDS the row on every sort and filter: a state the click handler wrote straight into the
   *  DOM and nowhere else would vanish the first time the seller sorted the table, which is the
   *  twin-renderer drift this file has been bitten by before. */
  featured?: boolean;
  createdAt?: string;
  /** Revision of the fields the edit form owns, computed server-side (lib/record-rev.ts) — rides back on save so a stale tab can't overwrite a newer one. */
  rev?: string;
  // Only set on rows fetched via /api/seller/products (a brand-new product
  // from the add-product form naturally has 0 of both, buildRows' defaults
  // below already cover that case without these).
  wishlistCount?: number;
  purchasedCount?: number;
}

function fmtPrice(n: number) { return formatPrice(n); }

/** The store's running sale, parsed once — it never changes within a page view. */
export function dashStoreSale(): StoreSale | null {
  try { return JSON.parse(document.getElementById('dash-store-sale')?.textContent ?? 'null'); }
  catch { return null; }
}

/** The Products table's per-row "on sale" chip text — mirrors the SSR helper in dashboard.astro
 *  so a client-rebuilt row shows exactly what the server-rendered one did. Resolves against the
 *  running sale too, so a product discounted only BY the sale is marked as on sale here. */
export function rowSaleLabel(p: { id?: string; price: number; categoryId?: string; discount?: ProductDiscount }): string {
  const view = resolvePrice(p, dashStoreSale());
  return view.isDiscounted ? `-${view.percentOff}%` : '';
}

// Live-updates the Products-tab stock-alert badge from a store-wide count the
// server returns after any stock/visibility mutation (or a list re-fetch). The
// count is store-wide, never page-scoped — the DOM only ever holds one page of
// rows, so it can't be recomputed locally. Skips no-ops when the count is
// undefined (a response that didn't carry it).
function updateStockBadge(count: number | undefined): void {
  if (typeof count !== 'number') return;
  const badge = document.getElementById('products-stock-badge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

const SPINNER_SVG = `<span class="dot-pulse" role="status" aria-label="טוען"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span>`;

// Shared dropdown-trigger/panel chrome for the read-only per-row stock breakdown popover.
const STOCK_BREAKDOWN_BTN = 'inline-flex items-center justify-center w-[1.1rem] h-[1.1rem] bg-transparent border-0 rounded-full cursor-pointer [color:var(--color-muted)] transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--color-muted)_12%,transparent)] hover:[color:var(--color-text)] aria-expanded:bg-[color-mix(in_srgb,var(--color-muted)_12%,transparent)] aria-expanded:[color:var(--color-text)] aria-expanded:rotate-180';
const STOCK_BREAKDOWN_DROPDOWN = 'absolute top-[calc(100%+0.3rem)] end-0 min-w-[140px] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-[var(--radius)] shadow-[0_4px_20px_rgba(0,0,0,0.13)] z-30 m-0 p-[0.3rem] animate-product-menu-open';

// ── Products pagination + toolbar filter (shared state) ───────────────────────
// Search/sort/filter/page-size all resolve server-side now (see applyPagination
// below) — pagination means the toolbar can no longer just show/hide DOM rows
// already on the page, the same reasoning that moved the admin dashboard's own
// list tabs server-side. This module only holds the *current query state*.
let productsCurrentPage = 1;
let productsPageSize = 20;
let productsSearchQuery = '';

// Column → set of selected display values. Empty set (or missing entry) for a
// column means that column doesn't restrict anything; multiple selected values
// within a column combine with OR, different columns combine with AND — same
// semantics as the variant-combo table's per-dimension filter. Values are
// category *display paths*; the "no category" row uses i18n.filterNoCategory
// as its sentinel value (translated to '' when building the server query).
const productsFilters = new Map<string, Set<string>>();

// Category filter's value list can no longer be read off DOM rows (only the
// current page's rows exist in the DOM) — walk the full category tree
// instead, same data source the edit-row's own category picker uses.
function allCategoryPaths(): string[] {
  const paths: string[] = [];
  function walk(nodes: CategoryNode[], prefix: string): void {
    for (const node of nodes) {
      const path = prefix ? `${prefix} › ${node.name}` : node.name;
      paths.push(path);
      walk(node.children, path);
    }
  }
  walk(getCategoryTree(), '');
  return paths;
}

function fmtDateAdded(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}


function warnIcon(label: string): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${esc(label)}" style="color:var(--color-danger,#dc2626);flex-shrink:0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

function stockHtml(stock: number, outOfStockLabel: string, stockLabel: string): string {
  const label = `<span class="product-stock-label">${esc(stockLabel)}: </span>`;
  if (stock <= 0) {
    return `${label}<span style="display:inline-flex;align-items:center;gap:0.3rem"><span style="color:var(--color-danger)">0</span>${warnIcon(outOfStockLabel)}</span>`;
  }
  if (stock <= LOW_STOCK_THRESHOLD) {
    return `${label}<span style="color:var(--color-danger)">${stock}</span>`;
  }
  return `${label}${stock}`;
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

// Quick-glance breakdown next to the products-table stock number — lets a
// seller scan AND edit per-variant stock across the whole table without opening
// each product's full edit form. Each combo's number is click-to-edit inline
// (activateComboStockEdit), the per-combo mirror of the whole `.product-stock`
// cell's inline edit; the total cell + total row update live on save.
function warnIconHtml(value: number, i18n: Record<string, string>): string {
  return value <= 0 ? warnIcon(i18n.outOfStock ?? 'Out of stock') : '';
}

// The clickable stock number on a breakdown row — a plain number that turns
// into an inline input on click, styled to hint it's editable on hover.
// text-end + min-width: the digit hugs the outer (warn) side at a constant
// distance across rows, while the spare min-width sits on the inner side as
// click padding — numbers line up in a column and the warn keeps the same gap
// from the number as in the main products table. No hover color: the number
// mirrors the main table's stock display (red when low/out, plain otherwise).
// Cursor is inherited from the hit area (cursor-text, like the main stock cell).
const COMBO_STOCK_VALUE_CLS = 'py-[0.15rem] min-w-[1.9rem] text-end';

// Compact inline input for the breakdown dropdown — deliberately NOT
// INLINE_INPUT_NUM, whose base carries min-w-10 (2.5rem) and a 3px ring that
// bloat the field inside this narrow popover. Sized to its digits, centered,
// with a slimmer ring.
const COMBO_STOCK_INPUT_CLS = '[font:inherit] [color:var(--color-text)] text-center bg-[color:var(--color-surface)] border-[1.5px] [border-color:var(--color-primary)] rounded-[var(--radius-sm)] px-[0.25rem] py-[0.05rem] outline-none min-w-0 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary)_15%,transparent)] [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:m-0';

// Compact cancel × for the breakdown editor — smaller than INLINE_CANCEL_BTN
// (w-5) and pulled toward the row edge so it tucks to the side, not next to the
// field taking central space. Keeps the round danger-tint hover.
const COMBO_STOCK_CANCEL_BTN = 'inline-flex items-center justify-center w-4 h-4 rounded-full border-none bg-transparent [color:var(--color-muted)] cursor-pointer p-0 shrink-0 transition-colors duration-[120ms] hover:[color:var(--color-danger,#dc2626)] hover:bg-[color-mix(in_srgb,var(--color-danger,#dc2626)_12%,transparent)]';

function stockBreakdownHtml(variants: VariantDimension[] | undefined, variantStock: Record<string, number> | undefined, totalStock: number, i18n: Record<string, string>): string {
  if (!variants?.length) return '';
  const editLabel = i18n.variantStockEditLabel ?? 'Edit stock';
  // `effective`, not a materialised map: a combo with no bucket of its own shows what it can
  // really sell — the shared pool — and says so. It used to show an even split of that pool,
  // which read as a per-combo count and was never one (variant-combo.ts#comboStockRows).
  const rows = comboStockRows(variants, variantStock, totalStock).map(({ key, selection, effective, shared }) => {
    const combo = selection;
    const label = comboLabelHtml(variants, combo);
    const value = effective;
    const lowStyle = value <= LOW_STOCK_THRESHOLD ? ' style="color:var(--color-danger)"' : '';
    const sharedMark = shared
      ? `<span data-combo-shared-mark title="${esc(i18n.comboSharedTitle ?? 'Sells from the shared pool')}" style="font-size:0.72rem;color:var(--color-muted);flex-shrink:0">${esc(i18n.comboSharedShort ?? 'pool')}</span>`
      : '';
    return `<div class="flex items-center justify-between gap-3 px-2 py-[0.4rem] rounded-[var(--radius-sm)] [color:var(--color-text)] text-[0.82rem] whitespace-nowrap" data-combo-stock-row data-combo-key="${esc(key)}"><span style="display:inline-flex;align-items:center;gap:0.35rem">${label}</span><span class="cursor-text" data-combo-stock-hit role="button" tabindex="0" aria-label="${esc(editLabel)}" style="display:inline-flex;align-items:center;gap:0.3rem">${sharedMark}<span data-combo-stock-value class="${COMBO_STOCK_VALUE_CLS}"${lowStyle}>${value}</span><span data-combo-stock-warn style="display:inline-flex;align-items:center;justify-content:center;width:0.9rem;flex-shrink:0">${warnIconHtml(value, i18n)}</span></span></div>`;
  }).join('');
  return `<span class="relative inline-flex" data-stock-breakdown>
    <button type="button" class="${STOCK_BREAKDOWN_BTN}" data-stock-breakdown-btn aria-expanded="false" aria-haspopup="true" aria-label="${esc(i18n.stockBreakdownLabel ?? 'Show stock breakdown by variant')}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="${STOCK_BREAKDOWN_DROPDOWN}" data-stock-breakdown-dropdown role="menu" hidden>${rows}</div>
  </span>`;
}

function getRawI18n() {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}'); } catch { return {}; }
}
function getDashI18n() { return getRawI18n().dashboard ?? {}; }

/** The store-card pick tooltip. `{n}` is `STORE_PREVIEW_SLOTS`, which this bundle cannot import
 *  (it is a server module), so the number rides along on the dashboard i18n payload. A hard-coded
 *  sentence here would be the copy that drifts first — the twin lives in dashboard.astro and both
 *  read the same two keys. */
function featureHintText(i: Record<string, string>): string {
  // Read the already-interpolated sentence off a row the SERVER rendered, rather than re-doing the
  // interpolation here. `STORE_PREVIEW_SLOTS` is a server module this bundle cannot import, and
  // the alternatives were both worse: a literal 4 in this file is a second definition of the cap,
  // and shipping the number as its own i18n key puts a quantity in the dictionary. Every table this
  // renderer rebuilds was server-rendered first, so there is always such a row; the raw string is
  // the fallback, and it is only reachable in a table with no products at all — which has no rows
  // to rebuild.
  const rendered = document.querySelector<HTMLElement>('[data-toggle-featured][data-tooltip]')?.dataset.tooltip;
  return rendered ?? (i.productFeatureHint ?? '');
}
function getGalleryI18n() { return getRawI18n().gallery ?? {}; }

// Re-derives the bulk-edit button's "ערוך"/"סגור עריכה" label from actual row state (which
// selected products currently have their edit row open) rather than trusting whatever it was
// last set to — a row can close via its own save/cancel, not just via this button, and the
// label needs to reflect that too. Reads the ticked checkboxes rather than the shared
// selection, on purpose: only a rendered row can have an edit row open at all.
function refreshBulkEditLabel(): void {
  const bulkEditBtn = document.getElementById('bulk-edit-btn') as HTMLButtonElement | null;
  const bulkEditLabel = document.getElementById('bulk-edit-label') as HTMLElement | null;
  if (!bulkEditBtn || bulkEditBtn.hidden) return;

  const selectedIds = Array.from(document.querySelectorAll<HTMLInputElement>('[data-bulk-check]:checked'))
    .map((chk) => chk.dataset.bulkCheck ?? '')
    .filter(Boolean);
  if (!selectedIds.length) return;

  const anyOpen = selectedIds.some((productId) =>
    !(document.querySelector<HTMLElement>(`[data-product-edit="${productId}"]`)?.hidden ?? true)
  );
  const i = getDashI18n();
  const label = anyOpen ? (i.bulkEditClose ?? 'סגור עריכה') : (i.bulkEdit ?? 'ערוך');
  if (bulkEditLabel) bulkEditLabel.textContent = label;
  bulkEditBtn.setAttribute('aria-label', label);
}

/** Root-first ancestor chain, joined with " › " — resolves a categoryId to a display path for the products table (chip/sort/filter). */
function categoryPathFor(categoryId: string): string {
  function find(nodes: CategoryNode[]): CategoryNode[] | null {
    for (const node of nodes) {
      if (node.id === categoryId) return [node];
      const nested = find(node.children);
      if (nested) return [node, ...nested];
    }
    return null;
  }
  const chain = find(getCategoryTree());
  return chain ? chain.map((n) => n.name).join(' › ') : '';
}

function categoryFieldHtml(selectedCategoryId: string, i18n: Record<string, string>): string {
  const label = selectedCategoryId ? (categoryPathFor(selectedCategoryId) || i18n.categoryNone) : i18n.categoryNone;
  return `<div class="field max-w-[280px]">
    <span>${esc(i18n.categoryLabel ?? 'Category')}</span>
    <div class="category-picker relative" data-category-picker>
      <input type="hidden" name="categoryId" value="${esc(selectedCategoryId)}" />
      <button type="button" class="category-picker__trigger group flex items-center justify-between gap-2 w-full px-[0.7rem] py-2 bg-[color:var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius)] cursor-pointer text-sm text-[color:var(--color-text)] text-start transition-colors duration-[120ms] hover:border-[var(--color-muted)] aria-expanded:border-[var(--color-accent)]" aria-haspopup="true" aria-expanded="false">
        <span class="category-picker__label overflow-hidden text-ellipsis whitespace-nowrap">${esc(label ?? '')}</span>
        <svg class="category-picker__chevron shrink-0 text-[color:var(--color-muted)] transition-transform duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-aria-expanded:rotate-180" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="category-picker__menu absolute start-0 top-[calc(100%+5px)] w-max min-w-full max-w-[20rem] max-h-[18rem] overflow-y-auto bg-[color:var(--color-surface)] border border-[color:var(--color-border)] rounded-[var(--radius)] p-[0.3rem] shadow-[0_4px_20px_rgba(0,0,0,0.12)] z-[60] animate-status-pop" hidden></div>
    </div>
    <p class="muted" style="margin:0.3rem 0 0;font-size:0.76rem">${esc(i18n.categoryEditHint ?? '')}</p>
  </div>`;
}

function skuFieldHtml(sku: string, i18n: Record<string, string>): string {
  return `<label class="field max-w-[280px]">
    <span>${esc(i18n.skuLabel ?? 'SKU')}</span>
    <input class="input" name="sku" value="${esc(sku)}" placeholder="${esc(i18n.skuPlaceholder ?? '')}">
  </label>`;
}

/** Mirrors the server-rendered brand cell in dashboard.astro. It has to exist here too, and not
 *  only because it would look different: this form submits EVERY field, so a rebuilt row that
 *  omitted `brand` would send none and clear the seller's stored value on the next save. The
 *  placeholder is the store's own name — the same "this is what gets published" hint. */
/** Store-level context for the search preview, read from the same `#upload-config` element the
 *  uploader and the store switcher use — one place holding "which store is open". */
function seoPreviewCtx(): ProductSeoPreview {
  const cfg = document.getElementById('upload-config')?.dataset ?? {};
  return { storeName: cfg.storeName ?? '', storeSlug: cfg.storeSlug ?? '', host: cfg.host ?? '' };
}

function brandFieldHtml(brand: string, i18n: Record<string, string>): string {
  const storeName = document.getElementById('upload-config')?.dataset.storeName ?? '';
  return `<label class="field max-w-[280px]">
    <span>${esc(i18n.brandLabel ?? 'Brand')}</span>
    <input class="input" name="brand" maxlength="70" value="${esc(brand)}" placeholder="${esc(storeName)}">
    <p class="muted" style="margin:0.3rem 0 0;font-size:0.76rem">${esc(i18n.brandFallbackNote ?? '')}</p>
  </label>`;
}

// Private seller-only handling note (never shown to buyers). A small eye-off icon
// + hint make the "only you see this" contract explicit right in the form.
function sellerNoteFieldHtml(note: string, i18n: Record<string, string>): string {
  return `<label class="field max-w-none">
    <span class="inline-flex items-center gap-[0.35rem]">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;color:var(--color-muted)"><path d="M4.5 3.5h15v10.5l-5.5 5.5h-9.5z"/><path d="M19.5 14h-5.5v5.5"/><line x1="8" y1="8.5" x2="16" y2="8.5"/><line x1="8" y1="12" x2="13" y2="12"/></svg>
      ${esc(i18n.sellerNoteLabel ?? 'Private note')}
    </span>
    <textarea class="input resize-none" name="sellerNote" rows="2" maxlength="2000" placeholder="${esc(i18n.sellerNotePlaceholder ?? '')}">${esc(note)}</textarea>
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
  return `<input class="input" data-tag-add-input placeholder="${esc(i18n.tagsPlaceholder ?? '')}" style="width:160px;flex:0 0 auto">`;
}

// Tags are added one at a time the same way variant values are (collapsed
// "+ Add" trigger → inline input → Enter commits and reopens for the next
// one) instead of one comma-separated line — the hidden input keeps the
// comma-joined string the server (`parseTags`) already expects, so nothing
// downstream had to change.
function tagsFieldHtml(tags: string[], i18n: Record<string, string>): string {
  const chipsHtml = tags.map(t => tagChipHtml(t, i18n)).join('');
  return `<div class="field max-w-none" data-tags-field>
    <span>${esc(i18n.tagsLabel ?? 'Tags')}</span>
    <div class="variant-chips" data-tag-chips style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center">${chipsHtml}<span data-tag-adder>${tagAddTriggerHtml(i18n)}</span></div>
    <div data-tag-suggestions style="display:none;flex-wrap:wrap;gap:0.4rem;align-items:center;margin-top:0.45rem"></div>
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

// Clear a tags field after the add-product form is reset — form.reset() only
// resets native controls, not the chip spans we appended or the suggestion row.
function resetTagsField(scope: HTMLElement): void {
  const field = scope.querySelector<HTMLElement>('[data-tags-field]');
  if (!field) return;
  field.querySelectorAll('[data-tag-chip]').forEach(c => c.remove());
  syncTagsHiddenInput(field);
  renderTagSuggestions(field, getDashI18n());
}

function syncTagsHiddenInput(field: HTMLElement): void {
  const hidden = field.querySelector<HTMLInputElement>('input[name="tags"]');
  const values = [...field.querySelectorAll<HTMLElement>('[data-tag-chip]')].map(c => c.dataset.value ?? '');
  if (hidden) hidden.value = values.join(',');
}

/** Add one tag chip by value (dedup case-insensitive). Returns whether it was added.
 *  Shared by the manual add-input and the click-to-add suggestion chips. */
function addTagChip(field: HTMLElement, rawValue: string, i18n: Record<string, string>): boolean {
  const value = rawValue.trim();
  const adder = field.querySelector<HTMLElement>('[data-tag-adder]');
  if (!value || !adder) return false;
  const existing = [...field.querySelectorAll<HTMLElement>('[data-tag-chip]')].map(c => (c.dataset.value ?? '').toLowerCase());
  if (existing.includes(value.toLowerCase())) return false;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = tagChipHtml(value, i18n);
  adder.before(wrapper.firstElementChild as HTMLElement);
  syncTagsHiddenInput(field);
  return true;
}

function commitTagValue(field: HTMLElement, i18n: Record<string, string>): void {
  const input = field.querySelector<HTMLInputElement>('[data-tag-add-input]');
  if (!input) return;
  if (addTagChip(field, input.value, i18n)) renderTagSuggestions(field, i18n);
  input.value = '';
}

// A dashed "+ word" chip proposing a tag auto-discovered from the product's own
// text (name / description / category). Clicking it promotes the word into a
// real tag; it's never saved on its own — see suggestTags in lib/tag-suggest.ts.
function tagSuggestChipHtml(value: string, i18n: Record<string, string>): string {
  return `<button type="button" class="variant-chip" data-tag-suggest-chip data-value="${esc(value)}" aria-label="${esc(i18n.tagsSuggestAdd ?? 'Add')}" style="display:inline-flex;align-items:center;gap:0.3rem;border:1px dashed var(--color-border);border-radius:999px;padding:0.22rem 0.55rem;font-size:0.8rem;background:none;color:var(--color-muted);cursor:pointer">
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>${esc(value)}</button>`;
}

// Recompute + paint the suggestion row from the current form state. Category
// and variant values are applied AUTOMATICALLY on save (see /api/product's
// withAutoTags), so the click-to-add row offers only the *optional* extras —
// name/description words — and excludes anything the auto-tagging will add
// anyway. Called on editor open and live as the seller edits those fields.
function renderTagSuggestions(field: HTMLElement, i18n: Record<string, string>): void {
  const container = field.querySelector<HTMLElement>('[data-tag-suggestions]');
  if (!container) return;
  const form = field.closest('form');
  const name = form?.querySelector<HTMLInputElement>('[name="name"]')?.value ?? '';
  const description = form?.querySelector<HTMLTextAreaElement>('[name="description"]')?.value ?? '';
  const categoryId = form?.querySelector<HTMLInputElement>('input[name="categoryId"]')?.value ?? '';
  const categorySegs = categoryId ? categoryPathFor(categoryId).split('›').map(s => s.trim()).filter(Boolean) : [];
  const variantValues = form ? collectVariantsPayload(form).variants.flatMap(d => d.options) : [];
  const currentTags = [...field.querySelectorAll<HTMLElement>('[data-tag-chip]')].map(c => c.dataset.value ?? '');
  // Auto-applied sources go into the exclusion set (not the suggestion sources)
  // so they don't show up as redundant chips for something that saves on its own.
  const suggestions = suggestTags({ name, description, existingTags: [...currentTags, ...categorySegs, ...variantValues] });
  if (!suggestions.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `<span style="font-size:0.76rem;color:var(--color-muted)">${esc(i18n.tagsSuggestLabel ?? '')}</span>${suggestions.map(s => tagSuggestChipHtml(s, i18n)).join('')}`;
  container.style.display = 'flex';
}

export function initTagsEditor(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const field = target.closest<HTMLElement>('[data-tags-field]');
    if (!field) return;
    const i18n = getDashI18n();

    const trigger = target.closest<HTMLButtonElement>('[data-tag-add-trigger]');
    // Refresh the offered set the moment the seller reaches for "+ Add".
    if (trigger) { renderTagSuggestions(field, i18n); expandTagAdder(field, i18n); return; }

    // Click a suggested tag → promote it to a real tag, then refresh the row
    // (so it drops out of the offered set).
    const suggestChip = target.closest<HTMLButtonElement>('[data-tag-suggest-chip]');
    if (suggestChip) {
      if (addTagChip(field, suggestChip.dataset.value ?? '', i18n)) renderTagSuggestions(field, i18n);
      return;
    }

    // Arms the shared "Sure? Yes/No" confirm (see initRemoveConfirm) instead
    // of deleting on the spot — same one-stray-click protection as variant chips.
    const removeBtn = target.closest<HTMLButtonElement>('[data-tag-chip-remove]');
    if (removeBtn) { replaceWithHtml(removeBtn, removeConfirmHtml('tag', i18n)); return; }
  });

  // Suggestions track the product's text live: recompute (debounced) whenever
  // the name/description/category that feed them change. The category picker
  // fires a synthetic 'input' on its hidden field (see category-picker.ts).
  const recompute = debounce((field: HTMLElement) => renderTagSuggestions(field, getDashI18n()), 250);
  document.addEventListener('input', (e) => {
    const target = e.target as Element;
    if (!target.matches('[name="name"], [name="description"], input[name="categoryId"]')) return;
    const field = target.closest('form')?.querySelector<HTMLElement>('[data-tags-field]');
    if (field) recompute(field);
  });

  // Paint suggestions for any tags-field already on the page (e.g. an edit row
  // opened with an existing product's name/category) so they're offered up front.
  const initialI18n = getDashI18n();
  document.querySelectorAll<HTMLElement>('[data-tags-field]').forEach(f => renderTagSuggestions(f, initialI18n));

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
      <input class="input" name="specs_label" value="${esc(s.label)}" placeholder="${lp}" style="width:170px;flex:0 0 auto">
      <input class="input" name="specs_value" value="${esc(s.value)}" placeholder="${vp}" style="width:220px;flex:0 0 auto">
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

const CHIP_IMAGE_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';

// Lets a color chip carry its own product photo — buyer-facing effect is that
// tapping this color on the storefront swaps the main image (see
// AI_INSTRUCTIONS → variant-image linking). Only offered on color dimensions;
// a size/storage/etc chip has nothing meaningful to point a photo at.
function chipImageBtnHtml(hasImage: boolean, i18n: Record<string, string>): string {
  const label = hasImage ? (i18n.variantImageAssigned ?? 'Change linked image') : (i18n.variantImageAssign ?? 'Link an image to this color');
  return `<button type="button" class="variant-chip-image-btn" data-variant-chip-image aria-label="${esc(label)}" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:3px;border:none;background:none;cursor:pointer;padding:0;color:${hasImage ? 'var(--color-accent)' : 'var(--color-muted)'};flex-shrink:0">${CHIP_IMAGE_ICON_SVG}</button>`;
}

function chipHtml(dimName: string, value: string, i18n: Record<string, string>, image = ''): string {
  const isColor = isColorVariant(dimName);
  const display = isColor ? resolveVariantColor(value).display : value;
  const imageBtn = isColor ? chipImageBtnHtml(!!image, i18n) : '';
  return `<span class="variant-chip" data-variant-chip data-value="${esc(value)}" data-image="${esc(image)}" style="display:inline-flex;align-items:center;gap:0.35rem;border:1px solid var(--color-border);border-radius:999px;padding:0.25rem 0.5rem 0.25rem 0.4rem;font-size:0.82rem">${colorChipVisualHtml(dimName, value, i18n)}<span class="variant-chip-label">${esc(display)}</span>${imageBtn}${chipRemoveButtonHtml(i18n)}</span>`;
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
    if (field) { syncTagsHiddenInput(field); renderTagSuggestions(field, i18n); }
    return;
  }
  // Must be captured *before* the dim/chip is removed below — .remove()
  // detaches it from its parent, so a .closest() walk from `wrapper` upward
  // afterward silently fails to reach the editor (the chain is broken at the
  // removed node), which was leaving the combo-stock table showing the
  // deleted dimension/value until the next full save re-rendered it.
  const editor = wrapper.closest<HTMLElement>('[data-variants-editor]');
  if (kind === 'dim') wrapper.closest('[data-variant-dim]')?.remove();
  else if (kind === 'chip') wrapper.closest('[data-variant-chip]')?.remove();
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

function dimHtml(dim: VariantDimension, i18n: Record<string, string>, variantImages: Record<string, string> = {}): string {
  const chipsHtml = dim.options.map(o => chipHtml(dim.name, o, i18n, variantImages[o] ?? '')).join('');
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
  // Every sort button says "sort by <column>" rather than just the column word: that is the
  // accessible name AND, since icon-tooltips.ts reads aria-label, the hover label — and on mobile
  // the column text is hidden, leaving nothing but a chevron.
  const sortBy = i18n.sortByLabel ?? 'Sort by';
  const dimHeaders = dims.map((d, i) => `<th style="padding:0.4rem 0.6rem;text-align:start;border-bottom:1px solid var(--color-border);white-space:nowrap">
    <div style="display:flex;align-items:center;gap:0.25rem">
      <button type="button" class="combo-sort-btn" data-combo-sort-col="${i}" aria-label="${esc(`${sortBy} ${d.name}`)}">${esc(d.name)}${SORT_ICON_SVG}</button>
      ${comboFilterHtml(i, d.name, i18n)}
    </div>
  </th>`).join('');
  return `<tr data-variant-combo-header>${dimHeaders}<th style="padding:0.4rem 0.6rem;text-align:end;border-bottom:1px solid var(--color-border);white-space:nowrap;${STOCK_COL_STICKY};z-index:2">
    <button type="button" class="combo-sort-btn" data-combo-sort-col="stock" aria-label="${esc(`${sortBy} ${i18n.variantStockColLabel ?? 'Stock'}`)}">${esc(i18n.variantStockColLabel ?? 'Stock')}${SORT_ICON_SVG}</button>
  </th></tr>`;
}

function comboTotalRowHtml(dims: VariantDimension[], i18n: Record<string, string>): string {
  const label = `${i18n.variantComboTotal ?? 'Total'} (${i18n.variantFilterAll ?? 'All'})`;
  return `<tr data-variant-combo-total-row>
    <td colspan="${dims.length}" data-variant-combo-total-label style="padding:0.4rem 0.6rem;font-size:0.82rem;font-weight:600;color:var(--color-text);white-space:nowrap;border-top:1px solid var(--color-border);position:sticky;bottom:0;background:var(--color-surface)">${esc(label)}</td>
    <td data-variant-combo-total-value style="padding:0.4rem 0.6rem;text-align:end;font-weight:600;color:var(--color-text);border-top:1px solid var(--color-border);position:sticky;inset-inline-end:0;bottom:0;background:var(--color-surface);z-index:1">0</td>
  </tr>`;
}

function comboRowHtml(dims: VariantDimension[], combo: Record<string, string>, key: string, value: number | undefined, sharedStock: number, i18n: Record<string, string>): string {
  const cells = dims.map(d => {
    const raw = combo[d.name] ?? '';
    if (!isColorVariant(d.name)) {
      return `<td style="padding:0.4rem 0.6rem;font-size:0.85rem;color:var(--color-text);white-space:nowrap;vertical-align:middle">${esc(raw)}</td>`;
    }
    const { display, hex } = resolveVariantColor(raw);
    const swatch = hex ? `<span aria-hidden="true" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${hex};border:1px solid rgba(0,0,0,0.15);flex-shrink:0"></span>` : '';
    return `<td style="padding:0.4rem 0.6rem;font-size:0.85rem;color:var(--color-text);white-space:nowrap;vertical-align:middle"><span style="display:inline-flex;align-items:center;gap:0.3rem">${swatch}${esc(display)}</span></td>`;
  }).join('');
  // An EMPTY input is the meaningful state, not a missing one: it says "this combo has no count of
  // its own", and readComboStock() leaves it out of the map so it keeps selling from the shared
  // pool. The placeholder shows what that pool currently holds, so the row is still answerable at
  // a glance ("how many can I sell?") without asserting a per-combo number nobody entered.
  const shownValue = value === undefined ? '' : String(value);
  const sharedNote = value === undefined
    ? `<span data-combo-shared style="font-size:0.72rem;color:var(--color-muted);white-space:nowrap">${esc((i18n.comboFromPool ?? 'from pool').replace('{n}', String(sharedStock)))}</span>`
    : '';
  return `<tr class="variant-combo-row" data-variant-combo-row data-combo-key="${esc(key)}">${cells}<td style="padding:0.4rem 0.6rem;text-align:end;vertical-align:middle;${STOCK_COL_STICKY};z-index:1"><span style="display:inline-flex;align-items:center;gap:0.4rem;justify-content:flex-end">${sharedNote}<input type="number" min="0" step="1" class="input" data-combo-stock value="${esc(shownValue)}" placeholder="${esc(String(sharedStock))}" style="width:80px;text-align:center;padding:0.3rem 0.4rem"></span></td></tr>`;
}

function comboRowsHtml(dims: VariantDimension[], stockMap: Record<string, number>, sharedStock: number, i18n: Record<string, string>): string {
  // No invented defaults. A combo the seller has not counted arrives blank and stays on the pool
  // — see variant-combo.ts#comboStockRows for why the even split was removed.
  return comboStockRows(dims, stockMap, sharedStock)
    .map((row) => comboRowHtml(dims, row.selection, row.key, row.override, sharedStock, i18n))
    .join('');
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

function variantsEditorHtml(variants: VariantDimension[], variantStock: Record<string, number>, currentStock: number, i18n: Record<string, string>, variantImages: Record<string, string> = {}): string {
  const hasAnyStock = Object.keys(variantStock).length > 0;
  const dimsHtml = variants.map(v => dimHtml(v, i18n, variantImages)).join('');
  const headerHtml = variants.length ? comboHeaderHtml(variants, i18n) : '';
  const rowsHtml = variants.length ? comboRowsHtml(variants, variantStock, currentStock, i18n) : '';
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

function readVariantImages(editor: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  editor.querySelectorAll<HTMLElement>('[data-variant-chip]').forEach((chip) => {
    const value = chip.dataset.value ?? '';
    const image = chip.dataset.image ?? '';
    if (value && image) out[value] = image;
  });
  return out;
}

// One shared floating popover (see toolbar-portal.ts) for picking which of the
// product's own gallery images a color chip should point the storefront's
// main image at. Reads the gallery's *current* slot URLs live off the same
// form at open time, not a stale snapshot — a seller can upload a new photo
// and immediately link it without saving the product first.
const variantImagePortal = createFloatingPortal('variant-image-picker-portal');

function currentGalleryImages(editor: HTMLElement): string[] {
  const form = editor.closest('form');
  if (!form) return [];
  return [...form.querySelectorAll<HTMLInputElement>('.gallery-slot__url')]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function variantImagePickerHtml(images: string[], current: string, i18n: Record<string, string>): string {
  const noneItem = `<button type="button" data-variant-image-pick data-url="" style="display:block;width:100%;text-align:start;padding:0.4rem 0.6rem;border-radius:var(--radius-sm);background:none;border:none;cursor:pointer;font-size:0.8rem;color:var(--color-muted)">${esc(i18n.variantImageNone ?? 'No linked image')}</button>`;
  if (!images.length) {
    return `${noneItem}<p class="muted" style="font-size:0.75rem;padding:0.3rem 0.6rem;margin:0">${esc(i18n.variantImageNoPhotos ?? 'Upload product photos first')}</p>`;
  }
  const thumbs = images.map((url) => `<button type="button" data-variant-image-pick data-url="${esc(url)}" aria-label="${esc(url)}" style="display:block;padding:2px;border-radius:var(--radius-sm);border:2px solid ${url === current ? 'var(--color-accent)' : 'transparent'};background:none;cursor:pointer;line-height:0"><img src="${esc(thumbUrl(url, 64, 64))}" alt="" width="48" height="48" loading="lazy" decoding="async" style="width:48px;height:48px;object-fit:cover;border-radius:2px;display:block"></button>`).join('');
  return `<div style="display:flex;flex-wrap:wrap;gap:0.35rem;padding:0.3rem 0.3rem 0.5rem">${thumbs}</div>${noneItem}`;
}

function updateChipImageBtnState(chip: HTMLElement, i18n: Record<string, string>): void {
  const btn = chip.querySelector<HTMLButtonElement>('[data-variant-chip-image]');
  if (!btn) return;
  const hasImage = !!chip.dataset.image;
  const label = hasImage ? (i18n.variantImageAssigned ?? 'Change linked image') : (i18n.variantImageAssign ?? 'Link an image to this color');
  btn.style.color = hasImage ? 'var(--color-accent)' : 'var(--color-muted)';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/**
 * The per-combo map the form will save — explicit buckets ONLY.
 *
 * A blank input is skipped rather than read as 0. That is the whole point of the change: an empty
 * row means "no count of its own", the key stays out of `variantStock`, and the combo keeps
 * selling from the shared pool. Coercing blank to 0 would take the combo off the shelf, which is
 * the opposite of what a seller who left it alone meant.
 */
function readComboStock(editor: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  editor.querySelectorAll<HTMLElement>('[data-variant-combo-row]').forEach((row) => {
    const key = (row as HTMLElement).dataset.comboKey ?? '';
    const input = row.querySelector<HTMLInputElement>('[data-combo-stock]');
    if (!key || !input) return;
    if (input.value.trim() === '') return;
    out[key] = Math.max(0, Math.floor(Number(input.value)) || 0);
  });
  return out;
}

/** true once every combo row carries a number — the point at which the shared pool sells nothing
 *  and the product's overall stock really is the sum of the rows. */
function allCombosHaveStock(editor: HTMLElement): boolean {
  const rows = [...editor.querySelectorAll<HTMLElement>('[data-variant-combo-row]')];
  return rows.length > 0
    && rows.every((row) => (row.querySelector<HTMLInputElement>('[data-combo-stock]')?.value ?? '').trim() !== '');
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
  const form = editor.closest('form');
  const stockInput = form?.querySelector<HTMLInputElement>('input[name="stock"]');
  if (!stockInput) return;
  // Optional: only the add-product form carries the note. The inline edit row has no room for it
  // and reads its own combo breakdown right beside the field, so a missing element is not a fault.
  const note = form?.querySelector<HTMLElement>('[data-stock-from-variants]');
  const hasDims = editor.querySelectorAll('[data-variant-dim]').length > 0;
  // Taking the field over is only honest once EVERY combo has its own number. While any row is
  // still blank the field is the live shared pool those rows sell from — a real, editable
  // quantity, not a stale duplicate — so locking it there would strand the seller with no way to
  // say how many uncounted units they hold.
  if (!hasDims || !allCombosHaveStock(editor)) {
    stockInput.readOnly = false;
    stockInput.style.background = '';
    if (note) note.hidden = true;
    return;
  }
  stockInput.value = String(sumComboStock(editor));
  stockInput.readOnly = true;
  stockInput.style.background = 'var(--color-bg)';
  // The note stays hidden until the seller actually tries to type here (initLockedStockHint) —
  // a permanent caption under a field that is behaving correctly is chrome, and the question
  // "why can't I type?" only exists at the moment it is asked.
  if (note) note.hidden = true;
}

/**
 * Answer the attempted edit of a locked total-stock field, and only then.
 *
 * Delegated at document level and bound once, because these inputs are created and replaced
 * constantly — the add form's editor is rebuilt on every save, and each edit row builds its own.
 * `focus` rather than `click` so the keyboard route is covered too; `readOnly` is re-read at event
 * time rather than captured, so a field that has since been unlocked says nothing.
 */
export function initLockedStockHint(): void {
  const noteFor = (input: HTMLElement) =>
    input.closest('form')?.querySelector<HTMLElement>('[data-stock-from-variants]') ?? null;

  document.addEventListener('focusin', (e) => {
    const input = (e.target as Element)?.closest<HTMLInputElement>('input[name="stock"]');
    // Hide any note belonging to a field the focus just LEFT, so it never outlives its question.
    document.querySelectorAll<HTMLElement>('[data-stock-from-variants]').forEach((n) => {
      if (!input || noteFor(input) !== n) n.hidden = true;
    });
    if (!input || !input.readOnly) return;
    const note = noteFor(input);
    if (note) note.hidden = false;
  });
}

/**
 * The total this table can actually sell.
 *
 * **A blank row is not a zero.** It has no bucket of its own, so it sells from the shared pool —
 * and that pool is ONE quantity every blank row draws on, not one per row. So the total is the
 * filled buckets added up, plus the pool counted a single time if any visible row is still blank.
 * Adding the pool per row would multiply stock that does not exist; treating a blank as 0 (what
 * this did when the rows stopped being pre-filled) reported a stocked product as empty.
 */
function updateComboTotal(editor: HTMLElement): void {
  const rowsBody = editor.querySelector<HTMLElement>('[data-variant-combo-rows]');
  const totalCell = editor.querySelector<HTMLElement>('[data-variant-combo-total-value]');
  if (!rowsBody || !totalCell) return;

  const visible = [...rowsBody.querySelectorAll<HTMLTableRowElement>('[data-variant-combo-row]')]
    .filter(row => !row.hidden);
  let sum = 0;
  let anyPooled = false;
  for (const row of visible) {
    const raw = row.querySelector<HTMLInputElement>('[data-combo-stock]')?.value.trim() ?? '';
    if (raw === '') { anyPooled = true; continue; }
    sum += Math.max(0, Number(raw) || 0);
  }
  if (anyPooled) {
    // While any row is pooled the overall field is that pool, not a derived sum
    // (syncTotalStockField only locks it once every row is filled), so it is safe to read here.
    const pool = editor.closest('form')?.querySelector<HTMLInputElement>('input[name="stock"]');
    sum += Math.max(0, Number(pool?.value) || 0);
  }
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
  // Same reasoning as the products table (see applyPagination): pin the
  // widths while the pre-change rows are still on screen, release once
  // nothing is filtered.
  if (filters.size) lockTableColumns(comboTable(editor));
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
  if (!filters.size) unlockTableColumns(comboTable(editor));
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
    portal.style.cssText = 'position:fixed;min-width:130px;max-height:220px;overflow:auto;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius);box-shadow:0 4px 20px rgba(0,0,0,0.13);z-index:300;padding:0.3rem;animation:var(--animate-product-menu-open)';
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

function comboTable(editor: HTMLElement): HTMLTableElement | null {
  return editor.querySelector<HTMLElement>('[data-variant-combo-thead]')?.closest('table') ?? null;
}

function openComboFilterPortal(wrap: HTMLElement, editor: HTMLElement, i18n: Record<string, string>): void {
  const btn = wrap.querySelector<HTMLButtonElement>('.combo-filter-btn');
  if (!btn) return;
  const col = Number(wrap.dataset.filterCol);
  const values = readVariantDims(editor)[col]?.options ?? [];
  const selected = new Set(getComboFilterSelection(wrap));

  comboFilterOpenWrap = wrap;
  comboFilterOpenEditor = editor;

  const portal = getComboFilterPortal();
  const items = values.map(v => `<label class="combo-filter-item" style="display:flex;align-items:center;gap:0.4rem;padding:0.45rem 0.75rem;border-radius:var(--radius-sm);cursor:pointer;font-size:0.82rem;font-weight:400;text-transform:none;letter-spacing:normal;white-space:nowrap"><input type="checkbox" data-combo-filter-value="${esc(v)}" ${selected.has(v) ? 'checked' : ''} style="cursor:pointer;flex-shrink:0">${esc(v)}</label>`).join('');
  // Disabled while nothing in this column is ticked — see filterClearButtonHtml().
  const clearState = selected.size
    ? 'cursor:pointer;color:var(--color-muted)'
    : 'cursor:default;color:var(--color-muted);opacity:0.4';
  portal.innerHTML = `${items}<button type="button" class="combo-filter-clear" data-combo-filter-clear ${selected.size ? '' : 'disabled aria-disabled="true"'} style="display:block;width:100%;text-align:start;padding:0.45rem 0.75rem;border-radius:var(--radius-sm);background:none;border:none;font-size:0.8rem;text-transform:none;letter-spacing:normal;${clearState}">${esc(i18n.variantFilterClear ?? 'Clear')}</button>`;

  const rect = btn.getBoundingClientRect();
  const isRTL = getComputedStyle(document.documentElement).direction === 'rtl';
  portal.style.top = `${rect.bottom + 4}px`;
  if (isRTL) { portal.style.right = `${window.innerWidth - rect.right}px`; portal.style.left = 'auto'; }
  else { portal.style.left = `${rect.left}px`; portal.style.right = 'auto'; }
  portal.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
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
  // The width lock goes with them: it's keyed to the header cells about to be
  // replaced, and leaving table-layout:fixed behind without them would flatten
  // the new columns to equal widths.
  unlockTableColumns(comboTable(editor));
  delete combosWrap.dataset.sortCol;
  delete combosWrap.dataset.sortDir;
  thead.innerHTML = comboHeaderHtml(dims, i18n);
  rowsBody.innerHTML = comboRowsHtml(dims, existingStock, fallbackTotal, i18n);
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
  // If a value-input is already sitting there (the "stays open for the next
  // value" case, called right after commitVariantValue on Enter) just refocus
  // it instead of tearing it down and rebuilding — replacing a *currently
  // focused* element's own innerHTML fires a synchronous blur as part of its
  // removal, which reentrantly runs the `focusout` listener below (also
  // commit+collapse) *while this same innerHTML assignment is still being
  // processed by the browser* — corrupts the DOM (a real "node to be removed
  // is no longer a child of this node" exception) and can silently drop the
  // value that was just committed. Only rebuild from scratch when there's
  // truly nothing there yet (opening from the collapsed trigger button).
  const existing = adder.querySelector<HTMLInputElement>('[data-dim-value-input]');
  if (existing) { existing.focus(); return; }
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

export function collectVariantsPayload(form: HTMLFormElement): { variants: VariantDimension[]; variantStock: Record<string, number>; variantImages: Record<string, string> } {
  const editor = form.querySelector<HTMLElement>('[data-variants-editor]');
  if (!editor) return { variants: [], variantStock: {}, variantImages: {} };
  return { variants: readVariantDims(editor), variantStock: readComboStock(editor), variantImages: readVariantImages(editor) };
}

export function resetVariantsEditor(form: HTMLFormElement): void {
  const editor = form.querySelector<HTMLElement>('[data-variants-editor]');
  if (!editor) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = variantsEditorHtml([], {}, 0, getDashI18n());
  editor.replaceWith(wrapper.firstElementChild as HTMLElement);
}

/**
 * Re-render a form's variants editor from the payload that was actually saved.
 *
 * **The editor can hold more than it sends.** `readVariantDims` drops a dimension whose name
 * repeats an earlier one (the combo grid keys its columns by name, so two "צבע" rubrics cannot
 * both exist), and the edit row's markup deliberately survives a save rather than being re-fetched.
 * Together those meant a duplicate the seller typed stayed on screen after saving, looking stored,
 * and only vanished on the next full page load — the row said one thing and the record another.
 * Rendering the sent payload back makes the form agree with what it just sent, and it runs before
 * the Cancel baseline is retaken so reverting lands on the same truth.
 */
export function applyVariantsPayload(
  form: HTMLFormElement,
  payload: { variants: VariantDimension[]; variantStock: Record<string, number>; variantImages: Record<string, string> },
  currentStock: number,
): void {
  const editor = form.querySelector<HTMLElement>('[data-variants-editor]');
  if (!editor) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = variantsEditorHtml(payload.variants, payload.variantStock, currentStock, getDashI18n(), payload.variantImages);
  const next = wrapper.firstElementChild as HTMLElement;
  editor.replaceWith(next);
  // Both, and in this order. `comboTotalRowHtml` renders a literal 0 as its starting cell — it is
  // filled in by updateComboTotal, which every other path that builds this table already calls
  // (refreshVariantCombos). Rebuilding without it left "total 0" sitting under a table of real
  // numbers right after a save. syncTotalStockField runs first because updateComboTotal reads the
  // overall field when any row is still pooled.
  syncTotalStockField(next);
  updateComboTotal(next);
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
      if (!getComboFilterSelection(comboFilterOpenWrap).length) return;
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

    const chipImageBtn = target.closest<HTMLButtonElement>('[data-variant-chip-image]');
    if (chipImageBtn) {
      const chip = chipImageBtn.closest<HTMLElement>('[data-variant-chip]');
      if (!chip) return;
      if (variantImagePortal.currentTrigger() === chipImageBtn) { variantImagePortal.close(); return; }
      const gallery = currentGalleryImages(editor);
      const current = chip.dataset.image ?? '';
      variantImagePortal.open(chipImageBtn, '150px', () => variantImagePickerHtml(gallery, current, i18n), (portal) => {
        portal.querySelectorAll<HTMLButtonElement>('[data-variant-image-pick]').forEach((pickBtn) => {
          pickBtn.addEventListener('click', () => {
            chip.dataset.image = pickBtn.dataset.url ?? '';
            updateChipImageBtnState(chip, i18n);
            variantImagePortal.close();
          });
        });
      });
      return;
    }

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
    // variant type". Enter there must never fall through to a real form
    // submit (this field has no submit button of its own to intercept it,
    // which would silently drop the still-optionless dimension since
    // readVariantDims() filters out any dimension with no values yet) — instead
    // it opens the value-adder input, same as clicking "+ Add", so naming the
    // type and adding its first value is one continuous Enter/Enter/Enter flow
    // instead of a name-then-click-then-type break in rhythm.
    if (target.matches('[data-dim-name]') && e.key === 'Enter') {
      e.preventDefault();
      const dimEl = target.closest<HTMLElement>('[data-variant-dim]');
      if (dimEl) expandValueAdder(dimEl, getDashI18n());
      return;
    }

    // Enter in a per-combo stock cell was implicit form submission — the browser's default for a
    // lone Enter in a text input — so filling the table one row at a time saved the product and
    // closed the card on the first row. These cells are a grid to be typed through, exactly like
    // the dimension name and value inputs above, both of which already claim Enter. Advance to the
    // next row instead; the last one just commits and stays put.
    if (target.matches('[data-combo-stock]') && e.key === 'Enter') {
      e.preventDefault();
      const editorEl = target.closest<HTMLElement>('[data-variants-editor]');
      const rows = [...(editorEl?.querySelectorAll<HTMLInputElement>('[data-variant-combo-row]:not([hidden]) [data-combo-stock]') ?? [])];
      const next = rows[rows.indexOf(target as HTMLInputElement) + 1];
      if (next) { next.focus(); next.select(); } else { (target as HTMLInputElement).blur(); }
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
    const existingChips = [...chipsWrap.querySelectorAll<HTMLElement>('[data-variant-chip]')];
    const options = existingChips.map(c => c.dataset.value ?? '');
    const images = existingChips.map(c => c.dataset.image ?? '');
    chipsWrap.innerHTML = options.map((o, idx) => chipHtml(target.value, o, i18n, images[idx])).join('');
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
      wrapper.innerHTML = chipHtml(nameInput.value, newValue, i18n, chip.dataset.image ?? '');
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
        <input class="input" name="specs_label" placeholder="${esc(lp)}" style="width:170px;flex:0 0 auto">
        <input class="input" name="specs_value" placeholder="${esc(vp)}" style="width:220px;flex:0 0 auto">
        <button type="button" class="specs-remove-row btn btn--ghost btn--sm" aria-label="${esc(i18n.specsRemoveRow ?? 'Remove')}">×</button>`;
      container.appendChild(row);
      row.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    const removeBtn = (e.target as Element).closest<HTMLButtonElement>('.specs-remove-row');
    if (removeBtn) removeBtn.closest('.specs-row')?.remove();
  });
}

export function buildRows(p: ProductData, storeSlug = '', storeName = ''): [HTMLTableRowElement, HTMLTableRowElement] {
  const i = getDashI18n();

  const uploadCfg = document.getElementById('upload-config');
  const resolvedStoreSlug = storeSlug || uploadCfg?.dataset.storeSlug || '';
  const resolvedStoreName = storeName || uploadCfg?.dataset.storeName || '';

  const display = document.createElement('tr');
  display.dataset.productDisplay = p.id;
  // The bulk "מבצע" panel reads this to prefill from the selection instead of opening blank.
  display.dataset.discount = p.discount ? JSON.stringify(p.discount) : '';
  display.dataset.storeId = p.storeId;
  display.dataset.images = JSON.stringify(p.images ?? []);
  display.dataset.sortName = p.name.toLowerCase();
  display.dataset.sortPrice = String(p.price);
  display.dataset.sortStock = String(p.stock);
  display.dataset.sortWishlist = String(p.wishlistCount ?? 0);
  display.dataset.sortCreatedAt = p.createdAt ?? '';
  display.dataset.category = p.categoryId ? categoryPathFor(p.categoryId) : '';
  display.dataset.categoryId = p.categoryId ?? '';
  display.dataset.productSlug = p.slug ?? '';
  display.dataset.storeSlug = resolvedStoreSlug;
  display.dataset.storeName = resolvedStoreName;
  display.dataset.hasVariants = p.variants?.length ? '1' : '';
  display.dataset.hidden = p.hidden ? '1' : '';
  display.dataset.featured = p.featured ? '1' : '';
  if (p.hidden) display.classList.add('is-product-hidden');
  display.innerHTML = `
    <td class="check-col w-8 text-center align-middle px-[0.15rem]"><input type="checkbox" class="bulk-check" data-bulk-check="${p.id}" aria-label="${esc(p.name)}" style="cursor:pointer;width:15px;height:15px"></td>
    <td class="num row-num pe-[0.2rem]"></td>
    <td class="thumb-col">${p.images?.[0] ? `<span class="thumb-wrap" data-skeleton><img src="${esc(thumbUrl(p.images[0]))}" alt="" class="product-thumb" width="42" height="42" loading="lazy" decoding="async"></span>` : ''}</td>
    <td class="name-col">
      <span class="product-name cursor-text">${esc(p.name)}</span>
      <span class="sale-chip ms-1.5 align-middle" data-row-sale="${esc(p.id)}" dir="ltr"${rowSaleLabel(p) ? '' : ' hidden'}>${rowSaleLabel(p)}</span>
      <span class="product-note-chip inline-flex items-center align-middle ms-1 [color:var(--color-muted)]"${p.sellerNote ? ` title="${esc(p.sellerNote)}"` : ' hidden'} aria-label="${esc(i.sellerNoteLabel ?? 'Private note')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3.5h15v10.5l-5.5 5.5h-9.5z"/><path d="M19.5 14h-5.5v5.5"/><line x1="8" y1="8.5" x2="16" y2="8.5"/><line x1="8" y1="12" x2="13" y2="12"/></svg></span>
      <span class="product-hidden-chip inline-flex items-center gap-1 text-[.66rem] font-semibold [color:var(--color-muted)] [background:color-mix(in_srgb,var(--color-muted)_14%,transparent)] py-[.08rem] px-[.4rem] rounded-full align-middle ms-1"${p.hidden ? '' : ' hidden'}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>${esc(i.productHiddenChip ?? 'מוסתר')}</span>
      <span class="product-featured-chip inline-flex items-center gap-1 text-[.66rem] font-semibold [color:var(--color-accent)] [background:color-mix(in_srgb,var(--color-accent)_14%,transparent)] py-[.08rem] px-[.4rem] rounded-full align-middle ms-1"${p.featured ? '' : ' hidden'}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>${esc(i.productFeaturedChip ?? 'בכרטיסייה')}</span>
      ${p.description ? `<span class="product-desc">${esc(p.description)}</span>` : ''}
    </td>
    <td class="sku-col"><span class="sku-col-label">${esc(i.skuLabel ?? 'SKU')}: </span>${p.sku ? esc(p.sku) : `<span style="color:var(--color-border)">—</span>`}</td>
    <td class="cat-col"><span class="cat-col-label">${esc(i.categoryLabel ?? 'Category')}: </span>${p.categoryId && categoryPathFor(p.categoryId) ? `<span class="product-cat-chip inline-block text-[.68rem] font-medium [color:var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] py-[.1rem] px-[.4rem] rounded-full mt-[.2rem] tracking-[.01em]">${esc(categoryPathFor(p.categoryId))}</span>` : `<span style="color:var(--color-border)">—</span>`}</td>
    <td class="num product-price price-col group cursor-text">${fmtPrice(p.price)}</td>
    <td class="num product-stock stock-col group cursor-text"><span style="display:inline-flex;align-items:center;gap:0.3rem"><span data-stock-total>${stockHtml(p.stock, i.outOfStock ?? 'Out of stock', i.colStock ?? 'Stock')}</span>${stockBreakdownHtml(p.variants, p.variantStock, p.stock, i)}</span></td>
    <td class="num wishlist-col" style="color:var(--color-muted);font-size:0.82rem">${(p.wishlistCount ?? 0) > 0
      ? `<span style="display:inline-flex;align-items:center;gap:0.25rem;color:var(--color-accent)"><svg class="shrink-0 max-w-none" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${p.wishlistCount}</span>`
      : `<span style="color:var(--color-border)">—</span>`}</td>
    <td class="num purchased-col" style="color:var(--color-muted);font-size:0.82rem"><span class="purchased-col-label">${esc(i.colPurchased ?? 'Purchased')}: </span>${(p.purchasedCount ?? 0) > 0 ? String(p.purchasedCount) : `<span style="color:var(--color-border)">—</span>`}</td>
    <td class="date-col"><span class="date-col-label">${esc(i.colDateAddedShort ?? 'Added')}: </span>${esc(fmtDateAdded(p.createdAt))}</td>
    <td class="seo-col">${productSeoRowGaugeHtml(productSeoInputFrom(p), productSeoLabels(i))}</td>
    <td class="actions actions-col">
      <div class="product-menu relative inline-block">
        <button class="product-menu__btn inline-flex items-center justify-center w-7 h-7 bg-transparent border-0 rounded-full cursor-pointer [color:var(--color-muted)] opacity-50 transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--color-muted)_12%,transparent)] hover:[color:var(--color-text)] hover:opacity-100 aria-expanded:bg-[color-mix(in_srgb,var(--color-muted)_12%,transparent)] aria-expanded:[color:var(--color-text)] aria-expanded:opacity-100 active:scale-90" type="button" aria-label="${esc(i.menuLabel ?? 'אפשרויות')}" aria-expanded="false" aria-haspopup="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        <ul class="product-menu__dropdown absolute top-[calc(100%+0.3rem)] end-0 min-w-[130px] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-[var(--radius)] shadow-[0_4px_20px_rgba(0,0,0,0.13)] z-30 list-none m-0 p-[0.3rem] animate-product-menu-open" hidden role="menu">
          <li role="none"><button class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" type="button" data-view-product="${p.id}" role="menuitem"><svg class="shrink-0 max-w-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>${esc(i.viewProduct ?? 'צפה במוצר')}</button></li>
          <li role="none"><button class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" type="button" data-edit-toggle="${p.id}" role="menuitem"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${esc(i.edit ?? 'Edit')}</button></li>
          <li role="none"><button class="product-menu__item product-menu__item--visibility flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" type="button" data-toggle-visibility="${p.id}" data-hidden="${p.hidden ? '1' : ''}" role="menuitem"><svg class="menu-icon-hide shrink-0 max-w-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg><svg class="menu-icon-show shrink-0 max-w-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span class="menu-visibility-label">${esc(p.hidden ? (i.productShow ?? 'הצג בחנות') : (i.productHide ?? 'הסתר מהחנות'))}</span></button></li>
          <li role="none"><button class="product-menu__item product-menu__item--feature flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" type="button" data-toggle-featured="${p.id}" data-featured="${p.featured ? '1' : ''}" data-tooltip="${esc(featureHintText(i))}" role="menuitem"><svg class="shrink-0 max-w-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg><span class="menu-feature-label">${esc(p.featured ? (i.productUnfeature ?? 'הסר מכרטיסיית החנות') : (i.productFeature ?? 'הצג בכרטיסיית החנות'))}</span></button></li>
          <li role="none"><button class="product-menu__item product-menu__item--danger flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-danger)] text-start transition-colors duration-100 hover:bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)]" type="button" data-delete-product="${p.id}" data-store-id="${esc(p.storeId)}" role="menuitem"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>${esc(i.delete ?? 'Delete')}</button></li>
        </ul>
      </div>
    </td>`;

  return [display, buildEditRow(p)];
}

/**
 * The inline edit form for one product — the WHOLE form, which is why it is built here and not
 * server-rendered any more.
 *
 * Measured 2026-08-11: 43KB of HTML per row, and the Products tab shipped one for every product on
 * the page whether or not the seller opened any of them — 58% of that tab's response, for forms
 * that were unreachable without JavaScript anyway (the "ערוך" control is a `<button>` inside a
 * scripted menu, so without JS nothing could open them). They are built on the click that opens
 * one now, from the page's product island, and this became the ONE definition of the form rather
 * than the client half of a twin the .astro had to be kept in step with.
 */
export function buildEditRow(p: ProductData): HTMLTableRowElement {
  const i = getDashI18n();
  const g = getGalleryI18n();

  const edit = document.createElement('tr');
  edit.className = 'edit-row';
  edit.dataset.productEdit = p.id;
  edit.hidden = true;
  edit.innerHTML = `
    <td class="num row-num pe-[0.2rem]"></td>
    <td colspan="20">
      <form method="POST" action="/api/product" class="mt-4 inline-edit-form" data-unsaved-guard data-base-rev="${esc(p.rev ?? '')}">
        <input type="hidden" name="_action" value="edit-product">
        <input type="hidden" name="productId" value="${p.id}">
        <div class="edit-row-header">
          ${p.images?.[0] ? `<span class="dash-img-skel block w-9 h-9 shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-[color:var(--color-surface)]" data-skeleton><img src="${esc(thumbUrl(p.images[0], 72, 72))}" alt="" width="36" height="36" loading="lazy" decoding="async" class="block w-full h-full object-cover"></span>` : ''}
          <span class="edit-row-title">${esc(p.name)}</span>
          <div class="flex gap-2 mt-2" style="margin-inline-start:auto;margin-top:0">
            <button class="btn btn--sm" type="submit" style="min-width:5rem;text-align:center">${i.save ?? 'Save'}</button>
            <button class="btn btn--ghost btn--sm" type="button" data-cancel-edit="${p.id}">${i.cancel ?? 'Cancel'}</button>
          </div>
        </div>
        <div class="grid grid-cols-[2fr_1fr_1fr] gap-4">
          <label class="field"><span>${i.nameReq ?? 'Name *'}</span><input class="input" name="name" value="${esc(p.name)}" required></label>
          <label class="field"><span>${i.priceLabel ?? 'Price'}</span><input class="input" name="price" type="number" min="0" step="0.01" value="${p.price}"></label>
          <label class="field"><span>${i.colStock ?? 'Stock'}</span><input class="input" name="stock" type="number" min="0" step="1" value="${p.stock}"></label>
        </div>
        ${discountFieldHtml(p.discount, discountFieldLabels(i))}
        <label class="field"><span>${i.descLabel ?? 'Description'}</span><textarea class="input" name="description" rows="2">${esc(p.description)}</textarea></label>
        <div class="grid grid-cols-[2fr_1fr_1fr] gap-4">${categoryFieldHtml(p.categoryId ?? '', i)}${skuFieldHtml(p.sku ?? '', i)}${brandFieldHtml(p.brand ?? '', i)}</div>
        ${tagsFieldHtml(p.tags ?? [], i)}
        ${variantsEditorHtml(p.variants ?? [], p.variantStock ?? {}, p.stock, i, p.variantImages ?? {})}
        ${specsEditorHtml(p.specs ?? [], i)}
        ${sellerNoteFieldHtml(p.sellerNote ?? '', i)}
        <div class="field">
          <span class="field-label">${i.productImages ?? 'Product images'}</span>
          ${galleryWidgetHtml(p.images ?? [], g)}
        </div>
        ${productSeoPanelHtml(productSeoInputFrom(p), { ...seoPreviewCtx(), productSlug: p.slug }, productSeoLabels(i))}
        <div class="flex gap-2 mt-2">
          <button class="btn btn--sm" type="submit" style="min-width:5rem;text-align:center">${i.save ?? 'Save'}</button>
          <button class="btn btn--ghost btn--sm" type="button" data-cancel-edit="${p.id}">${i.cancel ?? 'Cancel'}</button>
        </div>
      </form>
    </td>`;

  // The block's readout is painted from live values, so a freshly built row starts correct
  // instead of showing an empty "price after discount" until the seller touches something.
  refreshDiscountFieldsIn(edit);

  return edit;
}

/**
 * Carries a partial save's new revision onto the product's still-rendered edit row.
 *
 * The inline cell edits and the bulk image save already patch that row's fields so it
 * doesn't hold a stale value — its revision has to follow for the same reason. Without
 * this, the seller's OWN inline edit would make his next save from that row look like
 * someone else's conflict, and a warning he caused himself is exactly what teaches him
 * to click straight through the real one.
 */
function syncEditRowRev(displayRow: Element | null | undefined, rev: string | undefined): void {
  if (!rev) return;
  const form = displayRow?.nextElementSibling?.querySelector<HTMLFormElement>('form.inline-edit-form');
  if (form) form.dataset.baseRev = rev;
  // …and the same, for a row whose form does not exist yet. A pending row is built later from the
  // page's product island, which is a snapshot taken when the document was served — so a change
  // made here and not written back would come out of that island as the OLD value the next time the
  // seller opens the form, and their next save would put it back. See `syncPageProductFromRow`.
  syncPageProductFromRow(displayRow, rev);
}

/**
 * Put what the table now shows back into the product island, for a row nobody has opened yet.
 *
 * The island (`#dash-products-page`) is what `buildEditRow` reads, and it is a snapshot: it does
 * not move when an inline cell edit, a visibility toggle or a per-combo stock change patches a row
 * in place. A row the seller has ALREADY opened is immune — it is built once and then patched like
 * any other, which is what the caller above does — so this covers exactly the rows still pending.
 *
 * It re-reads the DISPLAY ROW rather than taking a patch object, because that row is what every one
 * of those edits already updates (they must: the client-side sort and filter run off these
 * attributes). One reader here cannot fall out of step with four writers there.
 *
 * The name comes from the cell rather than `data-sort-name`, which is lower-cased for sorting and
 * would quietly rewrite the seller's capitalisation.
 */
function syncPageProductFromRow(displayRow: Element | null | undefined, rev?: string): void {
  if (!(displayRow instanceof HTMLElement)) return;
  const id = displayRow.dataset.productDisplay ?? '';
  pageProductCache ??= pageProducts();
  const p = pageProductCache[id];
  if (!p) return;
  const name = displayRow.querySelector<HTMLElement>('.product-name')?.textContent?.trim();
  if (name) p.name = name;
  const price = Number(displayRow.dataset.sortPrice);
  if (Number.isFinite(price)) p.price = price;
  const stock = Number(displayRow.dataset.sortStock);
  if (Number.isFinite(stock)) p.stock = stock;
  p.hidden = displayRow.dataset.hidden === '1';
  p.featured = displayRow.dataset.featured === '1';
  try { p.discount = displayRow.dataset.discount ? JSON.parse(displayRow.dataset.discount) : undefined; }
  catch { /* an unparseable attribute is not a reason to drop the rest of the patch */ }
  if (rev) p.rev = rev;
}

/** The discount roll-up's seam (promotions.ts#syncProductRow). It writes the row's `data-discount`
 *  and nothing else, so it does not go through `syncEditRowRev` — but the island still has to
 *  follow, or a product whose discount was changed from the Promotions tab would open its edit form
 *  holding the old one, and saving would put it back. */
export function syncPageProduct(displayRow: Element | null | undefined): void {
  syncPageProductFromRow(displayRow);
}

/**
 * The label a save button wears while it is uploading photos rather than saving.
 *
 * Reported 2026-08-03: a seller who picks an image and presses Save without closing the image
 * editor first pays for the whole Cloudinary upload inside that click. The button said "שומר..."
 * for all of it — naming the fast half and denying the slow one — so a save that was working
 * looked like a save that had hung. `.btn--busy` is the site's existing in-flight treatment
 * (components/buttons.css: busy takes cursor:progress, disabled alone does not).
 *
 * The count is only shown when there is more than one photo: "מעלה תמונה 1/1" reads like a
 * progress bar that learned nothing.
 */
function uploadProgressLabel(i18n: Record<string, string>, done: number, total: number): string {
  const base = i18n.uploadingImage ?? 'Uploading image';
  return total > 1 ? `${base} ${Math.min(done + 1, total)}/${total}…` : `${base}…`;
}

function setBusy(btns: HTMLButtonElement[], text: string): void {
  btns.forEach((b) => { b.textContent = text; b.classList.add('btn--busy'); });
}

function clearBusy(btns: HTMLButtonElement[]): void {
  btns.forEach((b) => b.classList.remove('btn--busy'));
}

/**
 * The upload failure the seller actually reads.
 *
 * Both call sites used to catch and discard, showing "Image upload failed. Please try again." for
 * every cause — so a photo that was 12MB, or a HEIC the provider will never accept, produced a
 * message whose only advice was to do the identical thing again. `cloudinaryUpload` now throws
 * Cloudinary's own sentence (or its own pre-flight one); this puts it in front of the person who
 * can act on it, and keeps the generic line only for a thrown value that carries no message.
 */
function uploadErrorText(err: unknown, i18n: Record<string, string>): string {
  const reason = err instanceof Error ? err.message : '';
  // A REFUSAL is shown on its own, because the generic wording ends in "try again" and that is the
  // wrong instruction for every one of them: the same file will be refused the same way. The
  // refusal already says what to do — pick another photo, convert the HEIC, use a smaller one —
  // and prefixing it with "failed, try again" buries the only actionable sentence in a parenthesis
  // (cloudinary.ts#UPLOAD_REFUSED). Anything else — a dropped connection, a provider 500 — really
  // is worth repeating, and keeps the retry wording.
  if (isUploadRefusal(err)) return reason;
  const generic = i18n.uploadFailed ?? 'Image upload failed. Please try again.';
  return reason ? `${generic} (${reason})` : generic;
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
      if (gallery) {
        await resolveGalleryUrls(gallery, cloud, preset,
          (done, total) => setBusy(submitBtns, uploadProgressLabel(i18n, done, total)));
      }
      // Back to plain "saving" for the part that really is saving.
      clearBusy(submitBtns);
      submitBtns.forEach(btn => { btn.textContent = i18n.saving ?? 'Saving…'; });
    } catch (err) {
      clearBusy(submitBtns);
      submitBtns.forEach(btn => { btn.disabled = false; btn.textContent = origText; });
      showStatus(uploadErrorText(err, i18n), true);
      return;
    }

    const fd = new FormData(form);
    const sentVariants = collectVariantsPayload(form);
    fd.set('variants_json', JSON.stringify(sentVariants));
    // The revisions this row was built from — they are what lets the server merge this
    // save into whatever the record holds now instead of overwriting it. `force` is kept
    // ALONGSIDE them (never instead of): it only settles the fields two tabs edited to
    // different values, so everything else still merges rather than reverting.
    if (form.dataset.baseRev) fd.set('baseRev', form.dataset.baseRev);
    if (form.dataset.forceSave === '1') fd.set('force', '1');
    delete form.dataset.forceSave;

    const res = await fetch('/api/product', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; conflict?: boolean; conflictFields?: string[]; rev?: string; images?: string[]; categoryId?: string; categoryPath?: string; stockAlerts?: number; error?: string };

    if (data.conflict) {
      // Nothing was written, and only the listed fields are actually in dispute — the
      // rest of this form merges either way, so the question is just whose value those
      // fields end up with.
      submitBtns.forEach(btn => { btn.disabled = false; btn.textContent = origText; });
      markDashboardStale();
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: i18n.conflictTitle ?? 'Changed somewhere else',
          message: conflictMessage(data.conflictFields, i18n),
          okLabel: i18n.conflictOverwrite ?? 'Use my value',
          onConfirm: () => { form.dataset.forceSave = '1'; form.requestSubmit(); },
        },
      }));
      return;
    }
    if (!data.ok) {
      submitBtns.forEach(btn => { btn.disabled = false; btn.textContent = origText; });
      showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true);
      return;
    }
    // The row's markup survives the save (it closes but is reopened without a
    // re-fetch, and its Cancel snapshot is retaken from it below), so it takes the
    // revision it now holds — otherwise a second edit of the same row would report a
    // conflict against the seller's own previous save.
    if (data.rev) form.dataset.baseRev = data.rev;
    // Show back exactly what was sent — a dimension dropped for a duplicate name must leave the
    // form too, not linger until the next page load. Runs before the 1.5s timeout that retakes
    // the Cancel baseline, so Cancel reverts to this state and not to the rejected one.
    applyVariantsPayload(form, sentVariants, parseInt(String(fd.get('stock')), 10) || 0);
    updateStockBadge(data.stockAlerts);

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
          armThumbSkeleton(wrap);
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

      // Keep the private-note chip in sync — it only patches cells, never rebuilds
      // the row, so a note added/edited/cleared must be reflected here too.
      const noteChip = displayRow.querySelector<HTMLElement>('.product-note-chip');
      const noteVal = String(fd.get('sellerNote') ?? '').trim();
      if (noteChip) {
        if (noteVal) { noteChip.hidden = false; noteChip.title = noteVal; }
        else { noteChip.hidden = true; noteChip.removeAttribute('title'); }
      }

      const priceCell = displayRow.querySelector<HTMLElement>('.product-price');
      const stockCell = displayRow.querySelector<HTMLElement>('.product-stock');
      if (priceCell) priceCell.textContent = fmtPrice(price);
      if (stockCell) {
        const savedVariants = JSON.parse(String(fd.get('variants_json') || '{}')) as { variants?: VariantDimension[]; variantStock?: Record<string, number> };
        stockCell.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.3rem"><span data-stock-total>${stockHtml(stock, i18n.outOfStock ?? 'Out of stock', i18n.colStock ?? 'Stock')}</span>${stockBreakdownHtml(savedVariants.variants, savedVariants.variantStock, stock, i18n)}</span>`;
        displayRow.dataset.hasVariants = savedVariants.variants?.length ? '1' : '';
      }

      const category = String(fd.get('category') ?? '').trim();
      const catCell = displayRow.querySelector<HTMLElement>('.cat-col');
      if (catCell) catCell.innerHTML = `<span class="cat-col-label">${esc(i18n.categoryLabel ?? 'Category')}: </span>` + (category ? `<span class="product-cat-chip inline-block text-[.68rem] font-medium [color:var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] py-[.1rem] px-[.4rem] rounded-full mt-[.2rem] tracking-[.01em]">${esc(category)}</span>` : `<span style="color:var(--color-border)">—</span>`);
      displayRow.dataset.category = category;

      const sku = String(fd.get('sku') ?? '').trim();
      const skuCell = displayRow.querySelector<HTMLElement>('.sku-col');
      if (skuCell) skuCell.innerHTML = `<span class="sku-col-label">${esc(i18n.skuLabel ?? 'SKU')}: </span>` + (sku ? esc(sku) : `<span style="color:var(--color-border)">—</span>`);

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
      // Both hides above have landed, so the row's rect is its collapsed one — the tall form is
      // already out of the flow and everything below it has moved up.
      if (displayRow) scrollRowBackIntoView(displayRow);
      submitBtns.forEach(btn => { btn.disabled = false; btn.style.minWidth = ''; btn.textContent = origText; });
      // The just-saved form state is now the row's new baseline — a later
      // Cancel should revert here, not to the pre-edit snapshot from before
      // this save.
      if (editRow) originalEditHtml.set(editRow, editRow.innerHTML);
      refreshBulkEditLabel();
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
// The offset used to come from `--site-header-h`, which NOTHING in this codebase defines — the read
// returned '' , parseFloat gave NaN, `|| 0` made it 0, and the row landed at y:0 under the header:
// exactly the bug this function was written to avoid. scroll-utils measures the live bars instead.
function scrollStickyHeaderIntoView(container: HTMLElement, headerSelector: string): void {
  const header = container.querySelector<HTMLElement>(headerSelector);
  if (!header) return;

  // margin 0: land it flush against the bottom of whatever is pinned above it. (The edit-row
  // header used to be sticky itself and this read "at its own pinned offset" — it is not anymore,
  // see .edit-row-header in dashboard.css, but flush is still exactly where it belongs.)
  const scrollToHeader = () => scrollBelowPinnedChrome(header, 0);
  scrollToHeader();

  // This is the container's first time visible, so its lazy-loaded gallery images (or, for the
  // bulk-upload panel, several products' worth of them) only start fetching now — their real
  // size can land well after this click, growing the container and leaving the one-shot target
  // short of the header. Re-aim for a short window whenever it resizes, so the scroll keeps
  // chasing the header into place instead of undershooting.
  const ro = new ResizeObserver(scrollToHeader);
  ro.observe(container);
  setTimeout(() => ro.disconnect(), 1500);
}

function scrollEditRowIntoView(edit: HTMLElement): void {
  scrollStickyHeaderIntoView(edit, '.edit-row-header');
}

function scrollBulkUploadPanelIntoView(panel: HTMLElement): void {
  scrollStickyHeaderIntoView(panel, '.bulk-upload-header');
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
  if (gallery) initGalleryWidget(gallery);
  const variantsEditor = edit.querySelector<HTMLElement>('[data-variants-editor]');
  // Both, for the same reason as applyVariantsPayload: this row's markup can come from the server
  // render OR from a restored Cancel snapshot, and the total in either is only as fresh as the
  // moment it was captured. Recomputing costs nothing and removes the question.
  if (variantsEditor) { syncTotalStockField(variantsEditor); updateComboTotal(variantsEditor); }
  const categoryPicker = edit.querySelector<HTMLElement>('.category-picker');
  if (categoryPicker) initCategoryPicker(categoryPicker);
}

function restoreEditRow(display: HTMLTableRowElement, edit: HTMLTableRowElement, cloud: string, preset: string): void {
  // "בטל" is the seller SAYING he does not want this work — so the draft goes with it. Without
  // this, editing a product, pressing cancel and reloading offered the cancelled change back
  // (owner, 2026-08-15), which is the one case where the offer is not protection but noise: he
  // already answered the question. `dash:discarded` is the site's existing word for exactly this
  // ("thrown away on purpose", unsaved-guard.ts) and FormFallbackGuard deletes the stored draft on
  // it; announced BEFORE the markup is replaced, or the form the event needs is already gone.
  const form = edit.querySelector('form');
  if (form) form.dispatchEvent(new CustomEvent('dash:discarded', { bubbles: true }));

  const original = originalEditHtml.get(edit);
  if (original !== undefined && edit.innerHTML !== original) {
    edit.innerHTML = original;
    bindEditFormInternals(display, edit, cloud, preset);
  }
  edit.hidden = true;
  display.hidden = false;
  // Cancel collapses the same tall form and strands the same row above the viewport — the seller
  // who backs out of an edit needs to land on the product they backed out of just as much as the
  // one who saved it.
  scrollRowBackIntoView(display);
  refreshBulkEditLabel();
}

/**
 * The products the SERVER put on this page, for the edit rows it deliberately did not render.
 *
 * Same objects `/api/seller/products` returns — one mapper answers both (lib/seller-product-row.ts)
 * — so a row opened on the first paint and a row opened after a filter change are the same form.
 * Absent (an older cached document, a store with no products) simply means nothing to build from,
 * and `materialiseEditRow` says what happens then.
 */
function pageProducts(): Record<string, ProductData> {
  try {
    const raw = JSON.parse(document.getElementById('dash-products-page')?.textContent ?? '[]');
    const byId: Record<string, ProductData> = {};
    for (const p of Array.isArray(raw) ? raw : []) if (p?.id) byId[p.id] = p;
    return byId;
  } catch { return {}; }
}
let pageProductCache: Record<string, ProductData> | null = null;

/**
 * Build the edit form the server left out, for the row belonging to `productId`.
 *
 * Every path that OPENS an edit row goes through this — the row menu's "ערוך" and the toolbar's
 * bulk-edit toggle, which opens one per selected product. It is module-level and re-queries the row
 * by id rather than living in `attachListeners`' closure, and that is the point: the build REPLACES
 * the element, so a second opener holding a reference to the old empty node would show the seller an
 * empty form and nothing would say why.
 *
 * Returns the row either way. A pending row whose product is not in the island (a document left open
 * across a deploy, a product deleted in another tab) simply stays empty rather than throwing — an
 * edit row with nothing in it, which a reload fixes, is a far better failure than a menu item that
 * does nothing and says nothing.
 */
export function ensureEditRow(productId: string, cloud: string, preset: string): HTMLTableRowElement | null {
  const row = document.querySelector<HTMLTableRowElement>(`[data-product-edit="${CSS.escape(productId)}"]`);
  if (!row) return null;
  // `hasAttribute`, never `dataset.editPending` — the server writes it as a bare `data-edit-pending`
  // with no value, so `dataset` hands back `''`, which is FALSY. Read as a truthiness test this
  // silently never built a single row: the form simply opened empty, with no error anywhere.
  if (!row.hasAttribute('data-edit-pending')) return row;
  row.removeAttribute('data-edit-pending');
  pageProductCache ??= pageProducts();
  const p = pageProductCache[productId];
  if (!p) return row;
  const built = buildEditRow(p);
  row.replaceWith(built);
  // Both of these belong to the row that now exists: the snapshot "cancel" restores, and the
  // per-field wiring (images, variants, specs, category, the save handler).
  originalEditHtml.set(built, built.innerHTML);
  const display = document.querySelector<HTMLTableRowElement>(`[data-product-display="${CSS.escape(productId)}"]`);
  if (display) bindEditFormInternals(display, built, cloud, preset);
  // The inline draft guard scans for forms when the DOCUMENT loads, and this one did not exist
  // then. Without this the seller's typing in a product edit form would stop being kept — a crash
  // or a closed tab would lose it, silently, and only for the tab's own most-used form.
  // (components/dashboard/FormFallbackGuard.astro publishes this; it is deliberately inline, so it
  // is absent exactly on the loads it is insurance against — hence the optional call.)
  window.__dashScanDrafts?.(built);
  return built;
}

export function attachListeners(display: HTMLTableRowElement, edit: HTMLTableRowElement, cloud: string, preset: string): void {
  originalEditHtml.set(edit, edit.innerHTML);
  display.querySelector('[data-edit-toggle]')?.addEventListener('click', () => {
    // Re-resolved through `ensureEditRow`, never through the `edit` captured above: on a first open
    // that reference is the placeholder this call is about to replace.
    const row = ensureEditRow(display.dataset.productDisplay ?? '', cloud, preset) ?? edit;
    display.hidden = true; row.hidden = false;
    // Paint tag suggestions now the row is populated + visible (covers rows
    // built after page load, e.g. via pagination, which the init paint missed).
    const tagsField = row.querySelector<HTMLElement>('[data-tags-field]');
    if (tagsField) renderTagSuggestions(tagsField, getDashI18n());
    scrollEditRowIntoView(row);
    refreshBulkEditLabel();
  });
  // A row the client built (pagination, a filter, a fresh product) is full already and is wired
  // now, as it always was. A pending one is wired by `materialiseEditRow`, because there is nothing
  // inside it to wire until then.
  if (!edit.hasAttribute('data-edit-pending')) bindEditFormInternals(display, edit, cloud, preset);
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

  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const i18n = getDashI18n();
    const submitBtn = addForm.querySelector<HTMLButtonElement>('[type="submit"]');
    const origText = submitBtn?.textContent ?? (i18n.addProductBtn ?? 'Add product');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = i18n.saving ?? 'Saving…'; }
    // Declared out here so `finally` can reach it — the busy class has to come off on every exit.
    const btns = submitBtn ? [submitBtn] : [];

    try {
      const gallery = addForm.querySelector<Element>('.gallery-widget');
      try {
        if (gallery) {
          await resolveGalleryUrls(gallery, cloud, preset,
            (done, total) => setBusy(btns, uploadProgressLabel(i18n, done, total)));
        }
        clearBusy(btns);
        if (submitBtn) submitBtn.textContent = i18n.saving ?? 'Saving…';
      } catch (err) {
        clearBusy(btns);
        showStatus(uploadErrorText(err, i18n), true);
        return;
      }

      const fd = new FormData(addForm);
      fd.set('variants_json', JSON.stringify(collectVariantsPayload(addForm)));
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; product?: ProductData; error?: string };
      if (!data.ok) {
        const msg = res.status === 401
          ? (i18n.sessionExpired ?? 'Your session has expired. Please log in again and retry.')
          : (data.error ?? (i18n.errorAdding ?? 'Error adding product.'));
        showStatus(msg, true);
        return;
      }

      // Re-fetch page 1 from the server rather than prepending a DOM row —
      // with server pagination the new product's real position (and whether
      // it's even on the current filter/search/sort view at all) can only be
      // known by asking the server, the same reasoning applyPagination()
      // itself is built on.
      productsCurrentPage = 1;
      applyPagination();

      addForm.reset();
      resetVariantsEditor(addForm);
      resetTagsField(addForm);
      if (gallery) resetGallery(gallery);
      // Same reason as the three resets above: `form.reset()` fires no `input`/`change`, so the
      // panel would go on describing the product that was just saved while the form behind it is
      // blank — advice about a listing that no longer exists in it.
      refreshProductSeoPanels(addForm);
      addFormWrap?.setAttribute('hidden', '');
      document.getElementById('toggle-add-form')?.removeAttribute('hidden');
      showStatus(i18n.productAdded ?? 'Product added.');
    } finally {
      // The class too, not just the label — a button left `.btn--busy` keeps cursor:progress
      // forever and reads as still working on something that finished.
      clearBusy(btns);
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
        workingLabel: i18n.deleting ?? 'Deleting…',
        onConfirm: async () => {
          const fd = new FormData();
          fd.set('_action', 'delete-product');
          fd.set('productId', productId);
          fd.set('storeId', storeId);
          const res = await fetch('/api/product', { method: 'POST', body: fd });
          const data = await res.json() as { ok: boolean; error?: string };
          if (!data.ok) { showStatus(data.error ?? (i18n.errorDeleting ?? 'Error deleting.'), true); return; }

          // applyPagination() re-fetches the current page from the server,
          // which both drops the deleted row and clamps the page back down
          // if it was the last item on a trailing page — no manual DOM
          // removal or empty-state toggling needed here anymore.
          applyPagination();
          showStatus(i18n.productDeleted ?? 'Product deleted.');
        },
      },
    }));
  });
}

// Reflects a product's new hidden state across its row: the "מוסתר" chip, the
// dimmed-row class, the row's data-hidden flag, and the menu toggle's own
// label/icons (so re-opening the menu offers the opposite action). One place so
// SSR rows and AJAX-built rows behave identically after a toggle.
function applyProductHiddenState(productId: string, hidden: boolean, i18n: Record<string, string>): void {
  const row = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
  if (row) {
    row.dataset.hidden = hidden ? '1' : '';
    row.classList.toggle('is-product-hidden', hidden);
    const chip = row.querySelector<HTMLElement>('.product-hidden-chip');
    if (chip) chip.hidden = !hidden;
    const btn = row.querySelector<HTMLElement>('[data-toggle-visibility]');
    if (btn) {
      // The icon swap is pure CSS off this data-hidden (see dashboard.astro).
      btn.dataset.hidden = hidden ? '1' : '';
      const label = btn.querySelector<HTMLElement>('.menu-visibility-label');
      if (label) label.textContent = hidden ? (i18n.productShow ?? 'הצג בחנות') : (i18n.productHide ?? 'הסתר מהחנות');
    }
  }
}

export function initProductVisibilityToggle(): void {
  document.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-toggle-visibility]');
    if (!btn) return;
    const productId = btn.dataset.toggleVisibility ?? '';
    const i18n = getDashI18n();
    // Currently visible (data-hidden !== '1') → this click hides it, and vice versa.
    const nextHidden = btn.dataset.hidden !== '1';
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.set('_action', 'set-product-visibility');
      fd.set('productId', productId);
      fd.set('hidden', nextHidden ? '1' : '0');
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; hidden?: boolean; stockAlerts?: number; error?: string };
      if (!data.ok) { showStatus(data.error ?? (i18n.errorSaving ?? 'שגיאה בשמירה.'), true); return; }
      applyProductHiddenState(productId, data.hidden === true, i18n);
      updateStockBadge(data.stockAlerts);
      showStatus(data.hidden ? (i18n.productHiddenToast ?? 'המוצר הוסתר מהחנות.') : (i18n.productShownToast ?? 'המוצר חזר לחנות.'));
    } finally { btn.disabled = false; }
  });
}

/**
 * Reflect a product's store-card pick onto its row — the chip, the row marker and the menu label.
 *
 * Its own function for the same reason `applyProductHiddenState` is one: the row is rebuilt from
 * `ProductData` by the client renderer on sort/filter, so a state written only into the DOM by the
 * click handler would silently vanish the next time the table re-rendered.
 */
function applyProductFeaturedState(productId: string, featured: boolean, i18n: Record<string, string>): void {
  const row = document.querySelector<HTMLElement>(`[data-product-display="${CSS.escape(productId)}"]`);
  if (!row) return;
  row.dataset.featured = featured ? '1' : '';
  const chip = row.querySelector<HTMLElement>('.product-featured-chip');
  if (chip) chip.hidden = !featured;
  const btn = row.querySelector<HTMLElement>('[data-toggle-featured]');
  if (btn) {
    btn.dataset.featured = featured ? '1' : '';
    const label = btn.querySelector<HTMLElement>('.menu-feature-label');
    if (label) label.textContent = featured ? (i18n.productUnfeature ?? 'הסר מכרטיסיית החנות') : (i18n.productFeature ?? 'הצג בכרטיסיית החנות');
  }
}

export function initProductFeatureToggle(): void {
  document.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-toggle-featured]');
    if (!btn) return;
    const productId = btn.dataset.toggleFeatured ?? '';
    const i18n = getDashI18n();
    const next = btn.dataset.featured !== '1';
    btn.disabled = true;
    try {
      const res = await fetch('/api/store-product/featured', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, featured: next }),
      });
      const data = await res.json() as { featured?: boolean; count?: number; limit?: number; error?: string };
      // 409 is the CAP, and it gets its own sentence with the number in it — "שגיאה בשמירה" would
      // send a seller looking for a bug in something that is working exactly as designed.
      if (res.status === 409) {
        showStatus((i18n.productFeatureLimit ?? 'אפשר לבחור עד {n} מוצרים. הסר אחד כדי לבחור אחר.')
          .replace('{n}', String(data.limit ?? 4)), true);
        return;
      }
      if (!res.ok || typeof data.featured !== 'boolean') { showStatus(data.error ?? (i18n.errorSaving ?? 'שגיאה בשמירה.'), true); return; }
      applyProductFeaturedState(productId, data.featured, i18n);
      showStatus(data.featured
        ? (i18n.productFeaturedToast ?? 'המוצר יופיע בכרטיסיית החנות בעמוד הבית.')
        : (i18n.productUnfeaturedToast ?? 'המוצר הוסר מכרטיסיית החנות.'));
    } finally { btn.disabled = false; }
  });
}

/** The thumbnail a `.thumb-wrap` shows, for deciding whether a decoded one can be reused. */
function thumbSrcOf(wrap: HTMLElement): string {
  return wrap.querySelector<HTMLImageElement>('.product-thumb')?.getAttribute('src') ?? '';
}

/** Kept as a name because five call sites (including dashboard.astro) use it; the mechanism
 *  underneath is the shared one now. It used to decode-then-reveal, which meant every
 *  thumbnail — including one already in cache and already decoded — sat at opacity 0 until
 *  this bundle ran, under a shimmer that had been animating since the first paint. See
 *  dashboard.css for what that cost and lib/img-skeleton.ts for why it is the module's job.
 *  Re-arm a wrap with `armThumbSkeleton()` before calling this again for it. */
/**
 * Give a category chip the site's tooltip — but ONLY when its text is actually cut off.
 *
 * The chip is one line with an ellipsis (`.product-cat-chip`), and a real category path is
 * routinely longer than the column: "בית וגן › ריהוט › כיסאות" arrives as "בית וגן › ריה…", which
 * is a label that has stopped labelling (owner, 2026-08-15). A `title` would have been the
 * browser's own grey box, which this dashboard spent a session removing, so it is `data-tooltip` —
 * the explicit opt-in that `tooltip.ts` binds — and `initInfoTooltips` is called on the same rows.
 *
 * Measured rather than assumed: a chip that FITS gets no tooltip at all, because a hover label
 * repeating a word already on screen is noise (it is the same rule icon-tooltips.ts applies to
 * every icon control). `+1` absorbs the sub-pixel difference a fractional layout leaves behind.
 */
export function initCategoryChipTips(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.product-cat-chip').forEach((chip) => {
    const clipped = chip.scrollWidth > chip.clientWidth + 1;
    if (!clipped) { delete chip.dataset.tooltip; return; }
    if (chip.dataset.tooltip === chip.textContent) return;
    chip.dataset.tooltip = chip.textContent ?? '';
    // The binder marks what it has bound; a re-measured chip needs it dropped or it is skipped.
    delete chip.dataset.tooltipBound;
  });
  initInfoTooltips(root);
}

export function initThumbs(root: ParentNode = document): void {
  initImageSkeletons('.thumb-wrap', root);
  // The rest of this panel's image boxes wear the shared marker instead of a class of their own
  // (dashboard.css → .dash-img-skel): today the open edit row's header thumb, and the gallery
  // slots when a rebuilt row brings its own. Same sweep, so a new one is covered by existing.
  initImageSkeletons('.dash-img-skel', root);
}

/** Hand a thumbnail back to the skeleton module after its `src` changed (an inline edit, a
 *  newly uploaded image). The module consumes the marker as it takes each wrap, so re-arming
 *  is what makes it look again — the old code cleared a `.loaded` class for the same reason. */
export function armThumbSkeleton(wrap: HTMLElement): void {
  wrap.classList.remove('is-loading');
  wrap.setAttribute(SKELETON_ATTR, '');
}

/** Has this thumbnail's photo already arrived? Replaces the old `.thumb-wrap.loaded` check —
 *  the class is a statement about a fetch in flight now, not a permanent "done" mark, so the
 *  image itself is the thing to ask. */
function thumbIsResolved(wrap: HTMLElement): boolean {
  const img = wrap.querySelector<HTMLImageElement>('.product-thumb');
  return !!img?.complete && img.naturalWidth > 0;
}

// Number of <th>s in the products table — the empty-state row spans all of them.
const PRODUCTS_TABLE_COLS = 13;

/** The "nothing matches" row. Lives INSIDE the table on purpose: the table header carries
 *  the very filter funnels the seller needs to undo the filter, so hiding the table strands
 *  them with a stray dropdown and the "add your first product" copy — which is plainly wrong
 *  for a store that is full of products. Mirrors #products-empty-row in dashboard.astro. */
function emptyFilterRow(): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.id = 'products-empty-row';
  const td = document.createElement('td');
  td.colSpan = PRODUCTS_TABLE_COLS;
  td.className = 'py-6 text-center text-[0.95rem] [color:var(--color-muted)]';
  td.textContent = getDashI18n().noProductsMatch ?? 'אין מוצרים שתואמים לחיפוש/סינון.';
  tr.append(td);
  return tr;
}

/** The strings the shared pager renders with — read fresh each time, like every other
 *  dictionary read in this file, so a dashboard rendered in English never falls back. */
function pagerLabels(): PagerLabels {
  const i = getDashI18n();
  return {
    prev: i.paginationPrev ?? 'הקודם',
    next: i.paginationNext ?? 'הבא',
    pageInfo: i.paginationPageInfo ?? 'עמוד {page} מתוך {total}',
  };
}

function renderPaginationControls(totalPages: number): void {
  renderListPagers('products', productsCurrentPage, totalPages, pagerLabels());
}

/** This tab's in-flight request — see createFetchGate for the fast-paging bug it closes. */
const productsFetchGate = createFetchGate();

// Fetches the current page/search/sort/filter state from /api/seller/products
// and rebuilds the tbody from the response — the AJAX counterpart of the
// admin dashboard's server-paginated list tabs, except via fetch+DOM patch
// (not a full navigation) so the page never visibly reloads. Every toolbar
// control (sort, filter, search, page-size, prev/next) funnels through this
// one function so they can't drift into inconsistent DOM state.
export async function applyPagination(): Promise<void> {
  const tbody = document.getElementById('products-tbody') as HTMLTableSectionElement | null;
  const table = document.getElementById('products-table') as HTMLTableElement | null;
  const emptyMsg = document.getElementById('empty-products');
  const uploadCfg = document.getElementById('upload-config') as HTMLElement | null;
  const storeId = uploadCfg?.dataset.storeId ?? '';
  if (!tbody || !storeId) return;

  // Filters are already in productsFilters by the time a filter change lands
  // here, and the rows on screen are still the pre-change ones — so this is
  // the moment to capture the column widths that must survive the re-render.
  if (productsFilters.size) lockTableColumns(table);

  const params = new URLSearchParams();
  params.set('storeId', storeId);
  params.set('ppage', String(productsCurrentPage));
  params.set('psize', String(productsPageSize));
  if (productsSearchQuery) params.set('pq', productsSearchQuery);
  params.set('psort', `${productsSortCol}:${productsSortDir}`);
  const catValues = productsFilters.get('category');
  if (catValues?.size) {
    const noCatLabel = getDashI18n().filterNoCategory ?? 'ללא קטגוריה';
    params.set('pcat', encodeList([...catValues].map((v) => (v === noCatLabel ? NO_CATEGORY_TOKEN : v))));
  }
  const stockValues = productsFilters.get('stock');
  if (stockValues?.size) {
    const i = getDashI18n();
    params.set('pstock', [...stockValues].map((v) => stockKeyFromLabel(v, i)).join(','));
  }
  const seoValues = productsFilters.get('seo');
  if (seoValues?.size) {
    const i = getDashI18n();
    params.set('pseo', [...seoValues].map((v) => seoKeyFromLabel(v, i)).join(','));
  }

  let data: { ok: boolean; items?: ProductData[]; page?: number; totalPages?: number; total?: number; stockAlerts?: number };
  // The rows about to be replaced, dimmed if the replacements are slow enough to be worth saying
  // so (list-pager.ts#markListBusy — the site's one threshold, so an ordinary page change draws
  // nothing at all). What made a page change read as a failed click was the scroll, not the wait,
  // and that is fixed where it happened; this covers the genuinely slow connection.
  const endBusy = markListBusy(tbody);
  // Claims the list for THIS request and aborts any older one still running — paging fast used to
  // let a slow answer for the page you left overwrite the page you are on (list-pager.ts#createFetchGate).
  const { isCurrent, signal } = productsFetchGate.begin();
  try {
  // A failed load leaves the PREVIOUS page on screen. That is the right thing to keep — blanking
  // the list would claim the filter matched nothing — but it is silent unless it says so, and
  // "nothing moved" is indistinguishable from "the filter matched what was already here".
    const res = await fetch(`/api/seller/products?${params.toString()}`, { signal });
    data = await res.json() as typeof data;
  } catch {
    // A request WE aborted is not a failure, and saying so would put an error toast on screen
    // every time the seller pressed "next" twice quickly.
    if (isCurrent()) showActionFailedToast();
    return;
  } finally {
    // Cleared here and not after the rebuild: everything from here to `replaceChildren` is
    // synchronous, so the browser never gets a frame in which the OLD rows are back at full
    // opacity — and the dim can't outlive a failed fetch either. Calling it from a superseded
    // request is a no-op by construction (markListBusy), so this needs no guard of its own.
    endBusy();
  }
  // Answered, but a newer press has already claimed the list — writing anything here is exactly
  // the 2 → 3 → 2 the gate exists to stop.
  if (!isCurrent()) return;
  if (!data.ok) { showActionFailedToast(); return; }

  productsCurrentPage = data.page ?? 1;
  updateStockBadge(data.stockAlerts);

  const cloud = uploadCfg?.dataset.cloud ?? '';
  const preset = uploadCfg?.dataset.preset ?? '';
  const storeSlug = uploadCfg?.dataset.storeSlug ?? '';
  const storeName = uploadCfg?.dataset.storeName ?? '';

  // A rebuilt row gets a brand-new <img>, which replays the skeleton→load→decode
  // cycle even for a picture the browser already has — that is what made every
  // filter/sort/page change flash the whole table's thumbnails. Carry the decoded
  // ones over instead; nothing is bound inside .thumb-wrap (the thumb's click is
  // delegated on document), so the node moves without dragging listeners along.
  const decodedThumbs = new Map<string, HTMLElement>();
  tbody.querySelectorAll<HTMLElement>('[data-product-display]').forEach((row) => {
    const id = row.dataset.productDisplay ?? '';
    const wrap = row.querySelector<HTMLElement>('.thumb-wrap');
    if (id && wrap && thumbIsResolved(wrap)) decodedThumbs.set(id, wrap);
  });

  // One fragment, one insertion: building straight into the live tbody reflows
  // the table once per row.
  const rows = document.createDocumentFragment();
  (data.items ?? []).forEach((p, idx) => {
    const [display, edit] = buildRows(p, storeSlug, storeName);
    const numCell = display.querySelector<HTMLElement>('.row-num');
    if (numCell) numCell.textContent = String((productsCurrentPage - 1) * productsPageSize + idx + 1);
    attachListeners(display, edit, cloud, preset);
    const kept = decodedThumbs.get(p.id);
    const fresh = display.querySelector<HTMLElement>('.thumb-wrap');
    if (kept && fresh && thumbSrcOf(kept) === thumbSrcOf(fresh)) fresh.replaceWith(kept);
    rows.append(display, edit);
    initThumbs(display);
  });
  tbody.replaceChildren(rows);
  // Chips can only be measured once they are in the document — see initCategoryChipTips.
  initCategoryChipTips(tbody);
  // Every row above is brand new and therefore unticked — re-apply the live
  // selection so filtering or paging can't silently empty a selection, and so
  // an armed "select all" takes in the rows this view just brought up.
  syncBulkSelectionToRows(tbody);

  const total = data.total ?? 0;
  // Any column's filter counts, not just the category one — a stock filter that
  // matched nothing used to fall through to "add your first product".
  const hasActiveQuery = !!productsSearchQuery || productsFilters.size > 0;
  if (total === 0 && hasActiveQuery) tbody.append(emptyFilterRow());
  // The table only disappears when the store itself is empty; a filter that
  // matched nothing keeps it, with the row above explaining why.
  if (table) table.hidden = total === 0 && !hasActiveQuery;
  if (emptyMsg) emptyMsg.hidden = total !== 0 || hasActiveQuery;

  renderPaginationControls(data.totalPages ?? 1);
}

export function initPagination(): void {
  // Registered before the early return: a store small enough to have no pager still has
  // a table another tab can change under it (tab-sync.ts).
  if (document.getElementById('products-tbody')) registerPanelRefresh('dash-panel-products', applyPagination);

  const nav = document.getElementById('products-pagination') as HTMLElement | null;
  if (!nav) return;

  productsCurrentPage = parseInt(nav.dataset.page ?? '1', 10) || 1;
  const sizeSelect = document.getElementById('products-page-size') as HTMLSelectElement | null;
  productsPageSize = parseInt(sizeSelect?.value ?? '20', 10) || 20;
  renderPaginationControls(parseInt(nav.dataset.totalPages ?? '1', 10) || 1);

  // Arrived from the overview's "stock needs attention" tile? Apply it, once. The tile is bound by
  // the overview's own module and records an intent rather than reaching in here (panel-intent.ts).
  if (takePanelIntent('products')?.stockAttention) applyStockAttentionFilter();

  initListPager({
    name: 'products',
    labels: pagerLabels,
    getPage: () => productsCurrentPage,
    setPage: (page) => { productsCurrentPage = page; },
    apply: applyPagination,
    scrollTarget: () => document.getElementById('products-table'),
  });

  sizeSelect?.addEventListener('change', () => {
    productsPageSize = parseInt(sizeSelect.value, 10) || 20;
    productsCurrentPage = 1;
    applyPagination();
  });

  const searchInput = document.getElementById('products-search-input') as HTMLInputElement | null;
  const debouncedSearch = debounce(() => {
    productsSearchQuery = searchInput?.value.trim() ?? '';
    productsCurrentPage = 1;
    applyPagination();
  }, 300);
  searchInput?.addEventListener('input', debouncedSearch);
}

// Measures the real fixed-header + dash-tabs + products-toolbar heights so
// the sticky tab bar/panel headers/table-header sit flush regardless of
// font-loading/wrap differences.
export function initStickyOffsets(): void {
  const root = document.documentElement;
  const siteHeader = document.querySelector<HTMLElement>('.site-header');
  const tabs = document.querySelector<HTMLElement>('.dash-tabs');
  const toolbar = document.querySelector<HTMLElement>('.products-header');
  if (!siteHeader && !tabs && !toolbar) return;

  // getBoundingClientRect (fractional) instead of offsetHeight (rounds to the
  // nearest integer px) — the rounding alone was enough to leave a 1-2px seam.
  const updateHeaderH = () => { if (siteHeader) root.style.setProperty('--site-header-h', `${siteHeader.getBoundingClientRect().height}px`); };
  const updateTabsH = () => { if (tabs) root.style.setProperty('--dash-tabs-h', `${tabs.getBoundingClientRect().height}px`); };
  const updateToolbarH = () => { if (toolbar) root.style.setProperty('--products-toolbar-h', `${toolbar.getBoundingClientRect().height}px`); };

  updateHeaderH();
  updateTabsH();
  updateToolbarH();

  if (typeof ResizeObserver !== 'undefined') {
    if (siteHeader) new ResizeObserver(updateHeaderH).observe(siteHeader);
    if (tabs) new ResizeObserver(updateTabsH).observe(tabs);
    if (toolbar) new ResizeObserver(updateToolbarH).observe(toolbar);
  } else {
    window.addEventListener('resize', () => { updateHeaderH(); updateTabsH(); updateToolbarH(); });
  }
}


// Columns offered in the "filter by" control. Only columns with naturally
// low-cardinality, repeatable values are listed here — same judgment call the
// variant-combo table already makes (its dimension columns get a filter
// funnel, its continuous stock column only gets sort). Add more column keys
// here (and a matching case in getDistinctFilterValues + filterAndSortSellerProducts
// in seller-products-query.ts) if a future column turns out to warrant it.
const PRODUCT_FILTER_COLUMNS = ['category', 'stock', 'seo'] as const;

// Stock-status filter (CURRENT_TASK.md item 3): three synthetic buckets over the
// numeric stock column so a seller can isolate just the problem inventory.
// Values are stored/displayed as labels (like every other filter column) and
// mapped to stable keys ('out'/'low'/'ok') for the query string; the server
// (seller-products-query.ts#stockBucket) applies the matching thresholds.
const STOCK_FILTER_KEYS = ['out', 'low', 'ok'] as const;
function stockFilterLabel(key: string, i: Record<string, string>): string {
  return key === 'out' ? (i.filterStockOut ?? 'אזל מהמלאי')
    : key === 'low' ? (i.filterStockLow ?? 'מלאי נמוך')
    : (i.filterStockOk ?? 'מלאי תקין');
}
function stockKeyFromLabel(label: string, i: Record<string, string>): string {
  if (label === stockFilterLabel('out', i)) return 'out';
  if (label === stockFilterLabel('low', i)) return 'low';
  return 'ok';
}

// Search-visibility filter — the discovery half of the row gauge: the gauge marks a thin listing,
// this finds all of them across every page. Values are the meter's OWN band words (seoLevelWeak/
// Partial/Strong), not a second vocabulary, so "בסיסי" means the same thing in the filter, on the
// gauge and in the product panel.
const SEO_FILTER_KEYS = ['weak', 'partial', 'strong'] as const;
function seoFilterLabel(key: string, i: Record<string, string>): string {
  return key === 'weak' ? (i.seoLevelWeak ?? 'בסיסי')
    : key === 'partial' ? (i.seoLevelPartial ?? 'טוב')
    : (i.seoLevelStrong ?? 'מצוין');
}
function seoKeyFromLabel(label: string, i: Record<string, string>): string {
  if (label === seoFilterLabel('weak', i)) return 'weak';
  if (label === seoFilterLabel('partial', i)) return 'partial';
  return 'strong';
}

function productFilterColumnLabel(col: string, i: Record<string, string>): string {
  if (col === 'category') return i.categoryLabel ?? 'קטגוריה';
  if (col === 'stock') return i.colStock ?? 'מלאי';
  if (col === 'seo') return i.filterColSeo ?? 'נראות בחיפוש';
  return col;
}

const PRODUCT_SORT_OPTIONS: { col: string; dir: 'asc' | 'desc'; labelKey: string }[] = [
  { col: 'createdAt', dir: 'desc',    labelKey: 'sortOptDateDesc' },
  { col: 'createdAt', dir: 'asc',     labelKey: 'sortOptDateAsc' },
  { col: 'name',       dir: 'asc',    labelKey: 'sortOptNameAsc' },
  { col: 'name',       dir: 'desc',   labelKey: 'sortOptNameDesc' },
  { col: 'price',      dir: 'asc',    labelKey: 'sortOptPriceAsc' },
  { col: 'price',      dir: 'desc',   labelKey: 'sortOptPriceDesc' },
  { col: 'stock',      dir: 'asc',    labelKey: 'sortOptStockAsc' },
  { col: 'stock',      dir: 'desc',   labelKey: 'sortOptStockDesc' },
  { col: 'wishlist',   dir: 'desc',   labelKey: 'sortOptWishlistDesc' },
  { col: 'purchased',  dir: 'desc',   labelKey: 'sortOptPurchasedDesc' },
  { col: 'category',   dir: 'asc',    labelKey: 'sortOptCategoryAsc' },
];

let productsSortCol = 'createdAt';
let productsSortDir: 'asc' | 'desc' = 'desc';

// ── Shared floating portal ──────────────────────────────────────────────────
// One body-anchored element reused by every toolbar/header dropdown (mobile
// sort menu, mobile filter drill-down, desktop per-column funnels). Content
// is swapped via innerHTML per open, and position is computed fresh each time
// from the trigger's real getBoundingClientRect() and clamped to the
// viewport — this is what actually fixes off-screen dropdowns; a plain
// position:absolute + inset-inline-end:0 (the kebab-menu's own approach)
// only works when the trigger is guaranteed to sit near that edge, which a
// toolbar button in a wrapping flex row is not. Mirrors the variant-combo
// table's own getComboFilterPortal()/openComboFilterPortal().
let toolbarPortalTrigger: HTMLElement | null = null;

function getToolbarPortal(): HTMLElement {
  let portal = document.getElementById('products-toolbar-portal');
  if (!portal) {
    portal = document.createElement('div');
    portal.id = 'products-toolbar-portal';
    portal.className = 'toolbar-portal fixed bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-[var(--radius)] shadow-[0_4px_20px_rgba(0,0,0,0.13)] p-[.3rem] z-[300] animate-product-menu-open';
    portal.setAttribute('role', 'menu');
    portal.hidden = true;
    document.body.appendChild(portal);
  }
  return portal;
}

function positionToolbarPortal(portal: HTMLElement, trigger: HTMLElement): void {
  const isRTL = getComputedStyle(document.documentElement).direction === 'rtl';
  const margin = 8;
  const triggerRect = trigger.getBoundingClientRect();
  const portalRect = portal.getBoundingClientRect();
  let left = isRTL ? triggerRect.right - portalRect.width : triggerRect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - portalRect.width - margin));
  let top = triggerRect.bottom + 4;
  top = Math.min(top, Math.max(margin, window.innerHeight - portalRect.height - margin));
  portal.style.left = `${left}px`;
  portal.style.top = `${top}px`;
}

function closeToolbarPortal(): void {
  const portal = document.getElementById('products-toolbar-portal');
  if (portal) portal.hidden = true;
  toolbarPortalTrigger?.setAttribute('aria-expanded', 'false');
  toolbarPortalTrigger = null;
}

// Column widths are pinned for exactly as long as a filter is active — the
// stretch where re-rendering the rows would otherwise resize the columns and
// slide the header out from under an open dropdown. Merely opening or
// closing a menu changes nothing: taking the lock is meant to be invisible,
// but "meant to be" isn't a reason to do it when there's no filtering going
// on. Released as soon as the last filter is gone, so an ordinary full table
// sizes itself to its content again.
function productsTableEl(): HTMLTableElement | null {
  return document.getElementById('products-table') as HTMLTableElement | null;
}

function openToolbarPortal(
  trigger: HTMLElement,
  minWidth: string,
  buildHtml: () => string,
  wire: (portal: HTMLElement) => void,
): void {
  const portal = getToolbarPortal();
  toolbarPortalTrigger = trigger;
  portal.style.minWidth = minWidth;
  portal.style.maxHeight = '320px';
  portal.style.overflow = 'auto';
  portal.innerHTML = buildHtml();
  portal.hidden = false;
  positionToolbarPortal(portal, trigger);
  trigger.setAttribute('aria-expanded', 'true');
  wire(portal);
}

document.addEventListener('click', (e) => {
  const portal = document.getElementById('products-toolbar-portal');
  if (!portal || portal.hidden) return;
  // composedPath(), not target.contains() — a portal click that swaps
  // portal.innerHTML (e.g. drilling into a filter column) detaches the
  // original e.target from the document mid-bubble, so a containment check
  // done here (after that swap already ran) wrongly reads as "outside" and
  // closes the portal the instant it opens its next level.
  const path = e.composedPath();
  if (path.includes(portal)) return;
  if (toolbarPortalTrigger && path.includes(toolbarPortalTrigger)) return;
  closeToolbarPortal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeToolbarPortal(); });

// ── Sort — keeps desktop header buttons and the mobile "sort by" dropdown in
// sync, since both call the same applySort() and both get refreshed by it. ──

function refreshSortUI(): void {
  document.querySelectorAll<HTMLButtonElement>('#products-table thead .sort-btn').forEach((btn) => {
    // The SEO column's heading wears .sort-btn for the shared heading look but is a FILTER trigger,
    // not a sort control — and `data-active` is the flag refreshFilterUI uses to light it when a
    // filter is on. Without this guard, sorting any other column cleared that light, because this
    // pass deletes the attribute on every heading whose sort column isn't the current one.
    if (!btn.dataset.sortCol) return;
    if (btn.dataset.sortCol === productsSortCol) { btn.dataset.active = 'true'; btn.dataset.dir = productsSortDir; }
    else { delete btn.dataset.active; delete btn.dataset.dir; }
  });
  const label = document.getElementById('products-sort-label');
  if (label) {
    const opt = PRODUCT_SORT_OPTIONS.find((o) => o.col === productsSortCol && o.dir === productsSortDir) ?? PRODUCT_SORT_OPTIONS[0]!;
    label.textContent = getDashI18n()[opt.labelKey] ?? opt.labelKey;
  }
}

function applySort(col: string, dir: 'asc' | 'desc'): void {
  productsSortCol = col;
  productsSortDir = dir;
  productsCurrentPage = 1;
  applyPagination();
  refreshSortUI();
}

function headerSortClick(col: string): void {
  const defaultDir = col === 'wishlist' || col === 'purchased' || col === 'createdAt' ? 'desc' : 'asc';
  const dir: 'asc' | 'desc' = productsSortCol === col ? (productsSortDir === 'asc' ? 'desc' : 'asc') : defaultDir;
  applySort(col, dir);
}

function openMobileSortMenu(trigger: HTMLElement): void {
  openToolbarPortal(trigger, '13rem', () => {
    const i = getDashI18n();
    return toolbarMenuTitle(i.sortByLabel ?? 'מיין לפי') + PRODUCT_SORT_OPTIONS.map((opt) => {
      const selected = opt.col === productsSortCol && opt.dir === productsSortDir;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-sort-col="${opt.col}" data-sort-dir="${opt.dir}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${esc(i[opt.labelKey] ?? opt.labelKey)}</button>`;
    }).join('');
  }, (portal) => {
    portal.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applySort(btn.dataset.sortCol ?? 'createdAt', (btn.dataset.sortDir as 'asc' | 'desc') ?? 'desc');
        closeToolbarPortal();
      });
    });
  });
}

// ── Filter — desktop gets one funnel button per filterable column (each
// scoped to exactly that column, like the variant-combo table); mobile gets a
// single "filter by" entry point that drills down: column list (each row
// shows a checkbox reflecting whether that column currently has an active
// filter) → that column's own value checkboxes. Both paths converge on the
// same productsFilters state + refreshFilterUI(). ──

function refreshFilterUI(): void {
  document.querySelectorAll<HTMLButtonElement>('#products-table thead [data-filter-funnel-col]').forEach((btn) => {
    const col = btn.dataset.filterFunnelCol ?? '';
    if ((productsFilters.get(col)?.size ?? 0) > 0) btn.dataset.active = 'true'; else delete btn.dataset.active;
  });
  const badge = document.getElementById('products-filter-count');
  if (badge) {
    const activeCols = [...productsFilters.values()].filter((s) => s.size > 0).length;
    badge.hidden = activeCols === 0;
    badge.textContent = String(activeCols);
  }
  if (!productsFilters.size) unlockTableColumns(productsTableEl());
}

// The overview tab's "stock needs attention" card lands here — through an INTENT it records rather
// than by calling this directly, so the tile works on a load where this module has not run yet
// (panel-intent.ts). Also called by the stock badge's own shortcut.
// Isolate the products list to the out-of-stock + low-stock buckets and reflect
// the active funnel, exactly as if the seller had ticked those two boxes in the
// stock filter themselves. Clears any other active filter so the jump lands on a
// clean "only what needs attention" view.
export function applyStockAttentionFilter(): void {
  const i = getDashI18n();
  productsFilters.clear();
  productsFilters.set('stock', new Set([stockFilterLabel('out', i), stockFilterLabel('low', i)]));
  productsCurrentPage = 1;
  applyPagination();
  refreshFilterUI();
}

function getDistinctFilterValues(col: string): string[] {
  const i = getDashI18n();
  if (col === 'category') return [...allCategoryPaths().sort(), i.filterNoCategory ?? 'ללא קטגוריה'];
  if (col === 'stock') return STOCK_FILTER_KEYS.map((k) => stockFilterLabel(k, i));
  if (col === 'seo') return SEO_FILTER_KEYS.map((k) => seoFilterLabel(k, i));
  return [];
}

function filterValuesHtml(col: string, showBack: boolean): string {
  const i = getDashI18n();
  const label = productFilterColumnLabel(col, i);
  const values = getDistinctFilterValues(col);
  const selected = productsFilters.get(col) ?? new Set<string>();
  const backRotate = document.documentElement.dir === 'rtl' ? -90 : 90;
  const backHtml = showBack
    ? `<button type="button" class="product-menu__back flex items-center gap-[.35rem] w-full text-start py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] font-semibold [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-back><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0;transform:rotate(${backRotate}deg)"><polyline points="6 9 12 15 18 9"/></svg>${esc(label)}</button><div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`
    : '';
  return [
    backHtml,
    ...values.map((v) => `<label class="product-menu__checkbox-item flex items-center gap-[.4rem] py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer text-[.82rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]"><input type="checkbox" class="cursor-pointer shrink-0" data-filter-value="${esc(v)}" ${selected.has(v) ? 'checked' : ''}>${esc(v)}</label>`),
    `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
    filterClearButtonHtml('data-filter-clear-col', i.filterClearColumn ?? 'נקה סינון בעמודה זו', selected.size > 0),
  ].join('');
}

function wireFilterValues(portal: HTMLElement, col: string, reopen: () => void, onBack?: () => void): void {
  portal.querySelectorAll<HTMLInputElement>('[data-filter-value]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const set = productsFilters.get(col) ?? new Set<string>();
      if (cb.checked) set.add(cb.dataset.filterValue ?? ''); else set.delete(cb.dataset.filterValue ?? '');
      if (set.size) productsFilters.set(col, set); else productsFilters.delete(col);
      productsCurrentPage = 1;
      applyPagination();
      refreshFilterUI();
    });
  });
  portal.querySelector('[data-filter-clear-col]')?.addEventListener('click', () => {
    if (!productsFilters.has(col)) return;
    productsFilters.delete(col);
    productsCurrentPage = 1;
    applyPagination();
    refreshFilterUI();
    reopen();
  });
  if (onBack) portal.querySelector('[data-filter-back]')?.addEventListener('click', onBack);
}

function openDesktopFunnel(btn: HTMLButtonElement, col: string): void {
  openToolbarPortal(btn, '11rem', () => filterValuesHtml(col, false), (portal) => {
    wireFilterValues(portal, col, () => openDesktopFunnel(btn, col));
  });
}

// The checkbox here is real (not decorative) — unchecking it clears that
// column's filter directly, without forcing a drill-down into its values
// first. Clicking the checkbox while it's off has nothing meaningful to do
// yet (no values chosen), so it opens the values view instead of actually
// checking itself. A plain <div> row (not <label>) on purpose: a <label>
// wrapping a checkbox forwards any click on the row — including the
// "navigate to values" click on the chevron/text — into a second, native
// toggle of the checkbox, double-handling the same click.
function filterColumnsHtml(): string {
  const i = getDashI18n();
  const chevronRotate = document.documentElement.dir === 'rtl' ? 90 : -90;
  return [
    toolbarMenuTitle(i.filterByLabel ?? 'סנן לפי'),
    ...PRODUCT_FILTER_COLUMNS.map((col) => {
      const active = (productsFilters.get(col)?.size ?? 0) > 0;
      return `<div class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-filter-col="${col}">
        <input type="checkbox" class="cursor-pointer shrink-0" data-filter-col-toggle="${col}" ${active ? 'checked' : ''}>
        <span style="flex:1">${esc(productFilterColumnLabel(col, i))}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" style="flex-shrink:0;transform:rotate(${chevronRotate}deg)"><polyline points="6 9 12 15 18 9"/></svg>
      </div>`;
    }).join(''),
    `<div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`,
    filterClearButtonHtml('data-filter-clear-all', i.filterClearAll ?? 'נקה הכל', productsFilters.size > 0),
  ].join('');
}

function openMobileFilterColumns(trigger: HTMLElement): void {
  openToolbarPortal(trigger, '12rem', filterColumnsHtml, (portal) => {
    portal.querySelectorAll<HTMLElement>('[data-filter-col]').forEach((row) => {
      const col = row.dataset.filterCol ?? '';
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-filter-col-toggle]')) return;
        openMobileFilterValues(trigger, col);
      });
      const cb = row.querySelector<HTMLInputElement>('[data-filter-col-toggle]');
      cb?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cb.checked) {
          cb.checked = false;
          openMobileFilterValues(trigger, col);
          return;
        }
        productsFilters.delete(col);
        productsCurrentPage = 1;
        applyPagination();
        refreshFilterUI();
        openMobileFilterColumns(trigger);
      });
    });
    portal.querySelector('[data-filter-clear-all]')?.addEventListener('click', () => {
      if (!productsFilters.size) return;
      productsFilters.clear();
      productsCurrentPage = 1;
      applyPagination();
      refreshFilterUI();
      openMobileFilterColumns(trigger);
    });
  });
}

function openMobileFilterValues(trigger: HTMLElement, col: string): void {
  openToolbarPortal(trigger, '12rem', () => filterValuesHtml(col, true), (portal) => {
    wireFilterValues(portal, col, () => openMobileFilterValues(trigger, col), () => openMobileFilterColumns(trigger));
  });
}

export function initProductsToolbar(): void {
  refreshSortUI();
  refreshFilterUI();

  document.querySelectorAll<HTMLButtonElement>('#products-table thead .sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (btn.dataset.sortCol) headerSortClick(btn.dataset.sortCol); });
  });
  document.querySelectorAll<HTMLButtonElement>('#products-table thead [data-filter-funnel-col]').forEach((btn) => {
    const col = btn.dataset.filterFunnelCol ?? '';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (toolbarPortalTrigger === btn) { closeToolbarPortal(); return; }
      openDesktopFunnel(btn, col);
    });
  });

  const sortTrigger = document.getElementById('products-sort-trigger') as HTMLButtonElement | null;
  sortTrigger?.addEventListener('click', () => {
    if (toolbarPortalTrigger === sortTrigger) { closeToolbarPortal(); return; }
    openMobileSortMenu(sortTrigger);
  });

  const filterTrigger = document.getElementById('products-filter-trigger') as HTMLButtonElement | null;
  filterTrigger?.addEventListener('click', () => {
    if (toolbarPortalTrigger === filterTrigger) { closeToolbarPortal(); return; }
    openMobileFilterColumns(filterTrigger);
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

const INLINE_INPUT_BASE = '[font:inherit] [color:var(--color-text)] bg-[color:var(--color-surface)] border-[1.5px] [border-color:var(--color-primary)] rounded-[var(--radius-sm)] px-[0.3rem] py-[0.1rem] outline-none block min-w-10 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_15%,transparent)]';
const INLINE_INPUT_NUM = `${INLINE_INPUT_BASE} w-auto group-hover:[color:var(--color-primary)] [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:m-0`;
const INLINE_CANCEL_BTN = 'inline-flex items-center justify-center w-5 h-5 rounded-full border-none bg-transparent [color:var(--color-muted)] cursor-pointer p-0 shrink-0 transition-colors duration-[120ms] hover:[color:var(--color-danger,#dc2626)] hover:bg-[color-mix(in_srgb,var(--color-danger,#dc2626)_10%,transparent)]';

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
  input.dataset.inlineInput = '1';
  input.className = field === 'name' ? `${INLINE_INPUT_BASE} w-full` : INLINE_INPUT_NUM;
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
  xBtn.className = INLINE_CANCEL_BTN;
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

    input.disabled = true;
    xBtn.disabled = true;
    xBtn.innerHTML = SPINNER_SVG;
    wrapper.style.opacity = '0.6';

    const fd = new FormData();
    fd.set('_action', 'patch-product-fields');
    fd.set('productId', productId);
    fd.set(field, val);
    // Stock is the one inline field whose number the SERVER also changes: every sale decrements it.
    // The seller typed his over what this cell displayed, so that displayed figure travels with the
    // save as a compare-and-set — if a purchase moved stock meanwhile, the write is refused instead
    // of putting a sold unit back on the shelf. Name/price have no such second writer.
    if (field === 'stock') fd.set('prevStock', rawValue);

    try {
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; product?: { name: string; price: number; stock: number }; rev?: string; stockAlerts?: number; error?: string; conflict?: true; currentStock?: number };

      if (!data.ok) {
        showStatus(data.error ?? (i.errorSaving ?? 'שגיאה בשמירה.'), true);
        // A stock conflict is the one refusal that also corrects the screen: show what the number
        // really is now, so the seller re-decides against the truth rather than retyping the stale
        // value into the same refusal.
        if (data.conflict && typeof data.currentStock === 'number') {
          trigger.innerHTML = stockHtml(data.currentStock, i.outOfStock ?? 'אזל מהמלאי', i.colStock ?? 'מלאי');
          row.dataset.sortStock = String(data.currentStock);
          const editInput = row.nextElementSibling?.querySelector<HTMLInputElement>('[name="stock"]');
          if (editInput) editInput.value = String(data.currentStock);
          delete trigger.dataset.inlineActive;
          return;
        }
        cancel();
        return;
      }

      const p = data.product!;
      updateStockBadge(data.stockAlerts);
      syncEditRowRev(row, data.rev);
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
        trigger.innerHTML = stockHtml(p.stock, i.outOfStock ?? 'אזל מהמלאי', i.colStock ?? 'מלאי');
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
    if (target.closest('[data-inline-input]')) return;
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

// Click-to-edit for one variant combo's stock inside the breakdown dropdown —
// the same interaction as the whole `.product-stock` cell's inline edit (number
// becomes an input + cancel ×; Enter/blur commit, Escape/× cancel), scoped to a
// single combo. The × cancels WITHOUT closing the dropdown: its click stops
// propagating so the popover's own outside-click close never fires (a plain
// cancel detaches the × mid-event, which used to read as an outside click and
// shut the whole dropdown). Persists via the server's patch-variant-stock
// (which rebuilds the full per-combo map + total), then updates the total cell,
// this row's warn icon, sort key, alert badge, and the still-in-DOM full-edit
// form so the two views never drift apart.
function activateComboStockEdit(valueEl: HTMLElement, i: Record<string, string>): void {
  if (valueEl.dataset.inlineActive) return;
  const row = valueEl.closest<HTMLElement>('[data-combo-stock-row]');
  const cell = valueEl.closest<HTMLElement>('.product-stock');
  const productRow = valueEl.closest<HTMLElement>('[data-product-display]');
  const key = row?.dataset.comboKey ?? '';
  const productId = productRow?.dataset.productDisplay ?? '';
  if (!row || !cell || !productRow || !key || !productId) return;
  valueEl.dataset.inlineActive = '1';

  const savedInner = valueEl.innerHTML;

  const input = document.createElement('input');
  input.type = 'number';
  // Captured BEFORE the cell becomes an input: the number the seller is typing over, which the
  // save sends back as its compare-and-set baseline.
  const prevStock = valueEl.textContent?.trim() ?? '0';
  input.value = prevStock;
  input.min = '0';
  input.step = '1';
  input.dataset.inlineInput = '1';
  input.className = COMBO_STOCK_INPUT_CLS;
  input.setAttribute('aria-label', i.colStock ?? 'מלאי');
  const setW = () => { input.style.width = `${Math.max(input.value.length, 2) + 2.4}ch`; };
  setW();
  input.addEventListener('input', setW);

  const xBtn = document.createElement('button');
  xBtn.type = 'button';
  xBtn.className = COMBO_STOCK_CANCEL_BTN;
  xBtn.setAttribute('aria-label', 'ביטול');
  xBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  xBtn.addEventListener('mousedown', (e) => e.preventDefault());
  xBtn.addEventListener('click', (e) => { e.stopPropagation(); cancel(); });

  // While editing there's no out-of-stock warning to show, so the × takes the
  // warn icon's slot (the outer side) and the input takes the number's place.
  const warnEl = row.querySelector<HTMLElement>('[data-combo-stock-warn]');
  const savedWarn = warnEl?.innerHTML ?? '';

  valueEl.innerHTML = '';
  valueEl.appendChild(input);
  if (warnEl) { warnEl.innerHTML = ''; warnEl.appendChild(xBtn); }
  input.focus();
  input.select();

  let done = false;

  function cancel(): void {
    done = true;
    valueEl.innerHTML = savedInner;
    delete valueEl.dataset.inlineActive;
    if (warnEl) warnEl.innerHTML = savedWarn;
  }

  async function commit(): Promise<void> {
    if (done) return;
    done = true;
    const value = Math.max(0, Math.floor(Number(input.value)) || 0);

    input.disabled = true;
    xBtn.disabled = true;
    input.style.opacity = '0.6';

    const fd = new FormData();
    fd.set('_action', 'patch-variant-stock');
    fd.set('productId', productId);
    fd.set('comboKey', key);
    fd.set('stock', String(value));
    // The figure this cell displayed, as a compare-and-set — a sale of this combo between render
    // and save must not be undone by the absolute number typed over it (see /api/product).
    fd.set('prevStock', prevStock);

    try {
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; comboStock?: number; stock?: number; rev?: string; stockAlerts?: number; error?: string; conflict?: true; currentStock?: number };
      if (!data.ok) {
        showStatus(data.error ?? (i.errorSaving ?? 'שגיאה בשמירה.'), true);
        // Correct the cell to what stock really is now, so the seller re-decides against the truth.
        if (data.conflict && typeof data.currentStock === 'number') {
          delete valueEl.dataset.inlineActive;
          valueEl.textContent = String(data.currentStock);
          valueEl.style.color = data.currentStock <= LOW_STOCK_THRESHOLD ? 'var(--color-danger)' : '';
          if (warnEl) warnEl.innerHTML = warnIconHtml(data.currentStock, i);
          return;
        }
        cancel();
        return;
      }

      const combo = data.comboStock ?? value;
      const total = data.stock ?? 0;
      delete valueEl.dataset.inlineActive;
      valueEl.textContent = String(combo);
      // Match the main table: red when low/out of stock, plain otherwise.
      valueEl.style.color = combo <= LOW_STOCK_THRESHOLD ? 'var(--color-danger)' : '';
      if (warnEl) warnEl.innerHTML = warnIconHtml(combo, i);

      const totalEl = cell!.querySelector<HTMLElement>('[data-stock-total]');
      if (totalEl) totalEl.innerHTML = stockHtml(total, i.outOfStock ?? 'אזל מהמלאי', i.colStock ?? 'מלאי');
      productRow!.dataset.sortStock = String(total);
      updateStockBadge(data.stockAlerts);
      syncEditRowRev(productRow, data.rev);

      // Keep the (still-rendered) full edit form in sync: its read-only total,
      // the matching combo grid input, and the combo table's live total cell.
      const editRow = productRow!.nextElementSibling;
      const formStock = editRow?.querySelector<HTMLInputElement>('input[name="stock"]');
      if (formStock) formStock.value = String(total);
      const gridRow = [...(editRow?.querySelectorAll<HTMLElement>('[data-variant-combo-row]') ?? [])]
        .find((r) => r.dataset.comboKey === key);
      const gridInput = gridRow?.querySelector<HTMLInputElement>('[data-combo-stock]');
      if (gridInput) gridInput.value = String(combo);
      const editor = editRow?.querySelector<HTMLElement>('[data-variants-editor]');
      if (editor) updateComboTotal(editor);
    } catch {
      showStatus(i.errorSaving ?? 'שגיאה בשמירה.', true);
      cancel();
    }
  }

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    // Stop these from bubbling to the dropdown's own Enter/Escape handling
    // (which would otherwise close the whole popover mid-edit).
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void commit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  });
  input.addEventListener('blur', () => { if (!done) void commit(); });
}

export function initStockBreakdowns(): void {
  const i = getDashI18n();

  function closeAll(except?: HTMLElement): void {
    document.querySelectorAll<HTMLButtonElement>('[data-stock-breakdown-btn][aria-expanded="true"]').forEach((btn) => {
      const wrap = btn.closest<HTMLElement>('[data-stock-breakdown]');
      if (wrap && wrap === except) return;
      btn.setAttribute('aria-expanded', 'false');
      wrap?.querySelector<HTMLElement>('[data-stock-breakdown-dropdown]')?.setAttribute('hidden', '');
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const btn = target.closest<HTMLButtonElement>('[data-stock-breakdown-btn]');
    if (btn) {
      const wrap = btn.closest<HTMLElement>('[data-stock-breakdown]');
      const dropdown = wrap?.querySelector<HTMLElement>('[data-stock-breakdown-dropdown]');
      if (!wrap || !dropdown) return;
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      closeAll(isOpen ? undefined : wrap);
      btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      dropdown.hidden = isOpen;
      return;
    }
    // Click anywhere on a combo's stock area (number OR warn slot) → edit it.
    // The whole [data-combo-stock-hit] span is the target so the alert icon is
    // clickable too; the × opts out via stopPropagation, an active input via the
    // [data-inline-input] guard.
    if (!target.closest('[data-inline-input]')) {
      const hit = target.closest<HTMLElement>('[data-combo-stock-hit]');
      const valueEl = hit?.querySelector<HTMLElement>('[data-combo-stock-value]');
      if (valueEl) { activateComboStockEdit(valueEl, i); return; }
    }
    // A click inside the dropdown must not close it.
    if (!target.closest('[data-stock-breakdown]')) closeAll();
  });

  // Keyboard-activate the stock area (role="button") with Enter/Space.
  document.addEventListener('keydown', (e) => {
    const target = e.target as Element;
    const hit = target.closest<HTMLElement>('[data-combo-stock-hit]');
    const valueEl = hit?.querySelector<HTMLElement>('[data-combo-stock-value]');
    if (valueEl && !valueEl.dataset.inlineActive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      activateComboStockEdit(valueEl, i);
      return;
    }
    if (e.key === 'Escape') closeAll();
  });
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
  const bulkUploadLabel = document.getElementById('bulk-upload-label') as HTMLElement | null;
  const bulkEditBtn    = document.getElementById('bulk-edit-btn') as HTMLButtonElement | null;
  const bulkEditLabel  = document.getElementById('bulk-edit-label') as HTMLElement | null;
  // Owned by promotions.ts (it runs the apply/clear request); this module only shows/hides it
  // with the rest of the selection toolbar and closes its panel when the selection empties.
  const bulkDiscountBtn = document.getElementById('bulk-discount-btn') as HTMLButtonElement | null;
  const discountPanel   = document.getElementById('bulk-discount-panel') as HTMLDialogElement | null;

  const i = getDashI18n();

  function getCheckboxes(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>('[data-bulk-check]'));
  }

  const bulkSep = document.getElementById('bulk-sep') as HTMLElement | null;

  function updateBar(): void {
    const count = selectedRowIds().length;
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
    if (bulkDiscountBtn) bulkDiscountBtn.hidden = empty;
    if (bulkSep) bulkSep.hidden = empty;
    header?.classList.toggle('products-header--selecting', !empty);
    if (empty && uploadPanel) uploadPanel.hidden = true;
    // Clearing the selection leaves the discount dialog with nothing to act on — close it.
    if (empty && discountPanel?.open) discountPanel.close();
    if (empty && bulkEditLabel) bulkEditLabel.textContent = i.bulkEdit ?? 'ערוך';
    if (empty && bulkEditBtn) bulkEditBtn.setAttribute('aria-label', i.bulkEdit ?? 'ערוך');
    if (empty && bulkUploadLabel) bulkUploadLabel.textContent = i.bulkUploadImages ?? 'העלה תמונות';
    if (empty && bulkUploadBtn) bulkUploadBtn.setAttribute('aria-label', i.bulkUploadImages ?? 'העלה תמונות');
    if (empty) selectAllChks.forEach((chk) => { chk.hidden = false; });

    // Ticked while "select all" is armed (it keeps selecting whatever the table
    // renders next), half-ticked for a hand-picked subset.
    const armed = isSelectAllArmed();
    selectAllChks.forEach((chk) => {
      chk.checked = armed;
      chk.indeterminate = !armed && count > 0;
    });
  }

  // A re-render of the table (filter/sort/search/page) re-ticks the rows from
  // the shared selection — the count and action buttons here have to follow.
  onBulkSelectionChange(updateBar);

  // Checkbox change (delegated)
  document.addEventListener('change', (e) => {
    const chk = (e.target as Element).closest<HTMLInputElement>('[data-bulk-check]');
    if (!chk) return;
    setBulkSelected(chk.dataset.bulkCheck ?? '', chk.checked);
    // One row off means the selection is no longer "everything" — stop pulling
    // in rows the seller hasn't seen yet.
    if (!chk.checked) disarmSelectAll();
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

  // Select all — a mode, not a one-off: while it stays ticked every row the
  // table renders next (after a filter, a sort, the next page) is selected too.
  // Unticking it drops the whole selection, including rows currently filtered out.
  selectAllChks.forEach((chk) => chk.addEventListener('change', () => {
    // A click on an indeterminate box lands on checked=true, which is the
    // reading the seller expects: "select everything", not "clear my few".
    if (chk.checked) {
      armSelectAll();
      getCheckboxes().forEach((c) => {
        c.checked = true;
        setBulkSelected(c.dataset.bulkCheck ?? '', true);
      });
    } else {
      clearBulkSelection();
      getCheckboxes().forEach((c) => { c.checked = false; });
    }
    updateBar();
  }));

  // Bulk delete
  bulkDeleteBtn?.addEventListener('click', () => {
    const count = selectedRowIds().length;
    if (!count) return;
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: i.bulkDeleteTitle ?? `מחיקת ${count} מוצרים`,
        message: `${count} ${i.bulkDeleteMsg ?? 'מוצרים יימחקו לצמיתות.'}`,
        okLabel: `${i.bulkDelete ?? 'מחק'} (${count})`,
        workingLabel: `${i.deleting ?? 'מוחק...'} (${count})`,
        /**
         * N independent deletes, and until 2026-08-10 the report at the end was a flat
         * "המוצרים נמחקו" regardless of how many of them had actually happened. A failure inside
         * the loop was dropped on the floor — `if (data.ok)` with no else — so a seller could
         * select twenty, have three refused, and be told all twenty were gone. `applyPagination()`
         * re-fetches, so the three were still on the page; but a seller who has just been told the
         * job is done does not re-count the list, which is the whole reason that sentence is
         * dangerous.
         *
         * Each delete is also wrapped on its own now. One dropped connection used to reject the
         * whole `Promise.all`, which skipped `clearBulkSelection`, `updateBar`, `applyPagination`
         * AND the message — leaving the table showing rows that were already deleted, with the
         * selection bar still armed over them.
         */
        onConfirm: async () => {
          const ids = selectedRowIds();
          const results = await Promise.all(ids.map(async (productId) => {
            const row = document.querySelector<HTMLTableRowElement>(`[data-product-display="${productId}"]`);
            const storeId = row?.dataset.storeId ?? '';
            const fd = new FormData();
            fd.set('_action', 'delete-product');
            fd.set('productId', productId);
            fd.set('storeId', storeId);
            try {
              const res = await fetch('/api/product', { method: 'POST', body: fd });
              const data = await res.json() as { ok: boolean };
              if (data.ok) setBulkSelected(productId, false);
              return data.ok;
            } catch {
              // silent: counted, not announced per item — the tally below is the one message, and
              // twenty toasts for twenty failures is not a report.
              return false;
            }
          }));
          const failed = results.filter((ok) => !ok).length;
          // Only the ones that survived are deselected above, so what stays selected IS the retry
          // set: pressing delete again re-attempts exactly the products that did not go.
          if (failed === 0) clearBulkSelection();
          updateBar();
          // Re-fetches the current page from the server (drops deleted rows,
          // clamps the page if it ran off the end) — same as single-delete.
          applyPagination();
          if (failed === 0) {
            showStatus(i.bulkDeleted ?? 'המוצרים נמחקו.');
          } else {
            // Says how many, because "some failed" leaves the seller counting rows by hand.
            showStatus((i.bulkDeleteFailed ?? '{n} מוצרים לא נמחקו. נסו שוב.').replace('{n}', String(failed)), true);
          }
        },
      },
    }));
  });

  // Bulk image upload — toggle: open (render + scroll its sticky header into view, same
  // pattern as opening a single product's edit row) or close if already open.
  bulkUploadBtn?.addEventListener('click', () => {
    if (!uploadPanel || !selectedRowIds().length) return;
    const isOpen = !uploadPanel.hidden;
    if (isOpen) {
      uploadPanel.hidden = true;
      if (bulkUploadLabel) bulkUploadLabel.textContent = i.bulkUploadImages ?? 'העלה תמונות';
      bulkUploadBtn.setAttribute('aria-label', i.bulkUploadImages ?? 'העלה תמונות');
      return;
    }
    renderUploadPanel();
    uploadPanel.hidden = false;
    if (bulkUploadLabel) bulkUploadLabel.textContent = i.bulkUploadClose ?? 'סגור העלאת תמונות';
    bulkUploadBtn.setAttribute('aria-label', i.bulkUploadClose ?? 'סגור העלאת תמונות');
    scrollBulkUploadPanelIntoView(uploadPanel);
  });

  // Bulk edit — toggle: if any selected edit row is open → close all; else open all
  bulkEditBtn?.addEventListener('click', () => {
    const ids = selectedRowIds();
    if (!ids.length) return;
    const anyOpen = ids.some((productId) =>
      !(document.querySelector<HTMLElement>(`[data-product-edit="${productId}"]`)?.hidden ?? true)
    );
    let firstRow: HTMLElement | undefined;
    ids.forEach((productId) => {
      const displayRow = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
      // Through `ensureEditRow`, like the row menu's own "ערוך": the server does not render these
      // forms any more, so opening one straight off the DOM would show an empty row.
      const editRow    = ensureEditRow(productId, cloud, preset);
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
    refreshBulkEditLabel();
    selectAllChks.forEach((chk) => { chk.hidden = !anyOpen; });
    // The SAME landing as the row menu's own "ערוך" — the form's header, flush under the pinned
    // chrome. This was `scrollIntoView({block:'nearest'})`, and `nearest` is wrong for a target
    // TALLER than the viewport: with the row below the fold it aligns the row's BOTTOM to the
    // viewport's bottom, so a seller pressing "ערוך" landed somewhere in the middle of the form
    // with its heading and Save button far above (reported 2026-08-12). It was also a native
    // smooth scroll, which this RTL site bans for a JS-computed target (scroll-utils.ts).
    if (!anyOpen && firstRow) scrollEditRowIntoView(firstRow);
  });

  function renderUploadPanel(): void {
    if (!uploadPanel) return;
    const g = getGalleryI18n();
    const spinnerSvg = SPINNER_SVG;
    const checkSvg   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success,#22c55e)" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

    uploadPanel.innerHTML = `
      <div class="bulk-upload-header flex items-center justify-between text-[0.85rem] font-semibold [color:var(--color-muted)] uppercase tracking-[0.04em] mb-3 sticky [top:var(--site-header-h,3.3rem)] z-[6] bg-[color:var(--color-bg)] py-[0.4rem] -mx-[0.8rem] px-[0.8rem] border-b [border-color:var(--color-border)]">
        <span>${i.bulkUploadImages ?? 'העלה תמונות'}</span>
        <span class="bulk-upload-header__actions flex items-center gap-2 normal-case tracking-normal">
          <button type="button" class="btn btn--sm" id="bulk-upload-save-all">${i.bulkUploadSaveAll ?? 'שמור הכל'}</button>
          <button type="button" class="btn btn--ghost btn--sm" id="bulk-upload-close" aria-label="סגור">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>
      </div>
      <div class="bulk-upload-list flex flex-col gap-4">
        ${selectedRowIds().map((productId) => {
          const row = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
          const name = row?.querySelector('.product-name')?.textContent?.trim() ?? '';
          let images: string[] = [];
          try { images = JSON.parse(row?.dataset.images ?? '[]') as string[]; } catch { images = []; }
          return `
            <div class="bulk-upload-item border [border-color:var(--color-border)] rounded-[var(--radius-sm)] p-3 bg-[color:var(--color-surface)]" data-upload-product="${productId}">
              <div class="bulk-upload-item-header flex items-center justify-between gap-2 mb-[0.65rem]">
                <span class="bulk-upload-name text-[0.88rem] font-semibold [color:var(--color-text)] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">${esc(name)}</span>
                <span class="bulk-img-status" data-status-product="${productId}" aria-live="polite"></span>
              </div>
              ${galleryWidgetHtml(images, g)}
            </div>`;
        }).join('')}
      </div>`;

    document.getElementById('bulk-upload-close')?.addEventListener('click', () => {
      if (uploadPanel) uploadPanel.hidden = true;
      if (bulkUploadLabel) bulkUploadLabel.textContent = i.bulkUploadImages ?? 'העלה תמונות';
      bulkUploadBtn?.setAttribute('aria-label', i.bulkUploadImages ?? 'העלה תמונות');
    });

    // Init all gallery widgets inside the panel
    uploadPanel.querySelectorAll<Element>('.gallery-widget').forEach((gEl) => {
      initGalleryWidget(gEl);
    });

    // Auto-save when user clicks "Done" in any single gallery panel, or "Save all" for the batch.
    const saving = new Set<string>();

    function saveProductImages(item: HTMLElement, productId: string): Promise<boolean> {
      if (!productId || saving.has(productId)) return Promise.resolve(false);
      const galleryEl = item.querySelector<Element>('.gallery-widget');
      const statusEl = item.querySelector<HTMLElement>('.bulk-img-status');
      if (!galleryEl) return Promise.resolve(false);

      saving.add(productId);
      if (statusEl) statusEl.innerHTML = spinnerSvg;

      return resolveGalleryUrls(galleryEl, cloud, preset)
        .then(() => {
          const urls = Array.from(
            galleryEl.querySelectorAll<HTMLInputElement>('.gallery-slot__url')
          ).map((inp) => inp.value).filter(Boolean);

          const fd = new FormData();
          fd.set('_action', 'patch-product-images');
          fd.set('productId', productId);
          urls.forEach((url) => fd.append('images', url));
          return fetch('/api/product', { method: 'POST', body: fd })
            .then((r) => r.json() as Promise<{ ok: boolean; images?: string[]; rev?: string }>)
            .then((data) => ({ data, urls }));
        })
        .then(({ data, urls }) => {
          if (data.ok) {
            const savedImages = data.images ?? urls;
            const row = document.querySelector<HTMLElement>(`[data-product-display="${productId}"]`);
            syncEditRowRev(row, data.rev);
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
                // initThumbs needs an ANCESTOR of .thumb-wrap (it does root.querySelectorAll,
                // which never matches root itself) — passing wrap directly here was a no-op
                // that left the shimmer stuck forever over an image that had loaded fine.
                if (wrap) { armThumbSkeleton(wrap); initThumbs(thumbCol); }
              }
            }
            if (statusEl) {
              statusEl.innerHTML = checkSvg;
              setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 2000);
            }
            return true;
          }
          if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--color-danger);font-size:0.78rem">${i.uploadError ?? 'שגיאה'}</span>`;
            setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 2500);
          }
          return false;
        })
        .catch(() => {
          if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--color-danger);font-size:0.78rem">${i.uploadError ?? 'שגיאה'}</span>`;
            setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 2500);
          }
          return false;
        })
        .finally(() => { saving.delete(productId); });
    }

    uploadPanel.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('.gallery-done-btn')) return;
      const item = (e.target as Element).closest<HTMLElement>('.bulk-upload-item');
      if (!item) return;
      void saveProductImages(item, item.dataset.uploadProduct ?? '');
    });

    const saveAllBtn = document.getElementById('bulk-upload-save-all') as HTMLButtonElement | null;
    saveAllBtn?.addEventListener('click', () => {
      const items = Array.from(uploadPanel.querySelectorAll<HTMLElement>('.bulk-upload-item'));
      if (!items.length) return;
      saveAllBtn.disabled = true;
      const origLabel = saveAllBtn.textContent;
      saveAllBtn.textContent = i.saving ?? 'שומר…';

      // resolveGalleryUrls is a no-op for a product nobody touched (skips slots with no new
      // blob), so it's safe to call for every item in the panel unconditionally — no need to
      // track which galleries actually changed.
      Promise.all(items.map((item) => saveProductImages(item, item.dataset.uploadProduct ?? '')))
        .then((results) => {
          const savedCount = results.filter(Boolean).length;
          showStatus(`${i.bulkUploadSaved ?? 'נשמרו תמונות עבור'} ${savedCount}/${items.length}`);
        })
        .finally(() => {
          saveAllBtn.disabled = false;
          saveAllBtn.textContent = origLabel;
        });
    });
  }
}
