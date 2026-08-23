// Seller dashboard → "מבצעים" tab (components/dashboard/PromotionsPanel.astro).
//
// Three jobs: save the store-wide sale over AJAX (no page reload, like every other dashboard
// mutation), keep the live banner preview honest as the seller types, and let a row in the
// "products on sale" roll-up end that product's own discount in place.
//
// The preview is deliberately the SAME markup/classes the storefront banner uses, so what the
// seller sees here is the thing shoppers get — not an approximation of it.

import { escapeHtml as esc } from '../../lib/html-escape.js';
import { showToast, showErrorToast } from '../../lib/toast.js';
import { showFieldError, clearFieldError } from '../../lib/field-validity.js';
import { resolvePrice, type ProductDiscount } from '../../lib/discounts.js';
import { isolateLatinRunsHtml } from '../../lib/bidi-isolate.js';
import { refreshDiscountFieldsIn } from './discount-field.js';
import { dashStoreSale, syncPageProduct } from './products.js';
import { selectedRowIds } from './bulk-selection.js';
import { initSelectDropdown } from './select-dropdown.js';
import { initProductMultiPicker, readProductOptions } from './product-multi-picker.js';
import { bindCategoryPickersIn } from './category-picker.js';

interface SaleResponse { ok: boolean; error?: string }

const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>';

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

interface BulkDiscountResponse extends SaleResponse {
  applied?: Array<{ id: string; discount: ProductDiscount | null }>;
}

/** Products tab → the "מבצע" button in the selection toolbar. The button's show/hide rides with
 *  the rest of the toolbar in products.ts (it owns the selection); everything below is only the
 *  apply/clear/add-to-sale requests. Each affected row's chip is patched from the response
 *  instead of reloading the page — a reload here threw away the seller's search, sort, page and
 *  scroll position just to redraw a handful of chips. */
function initBulkDiscount(i: Record<string, string>): void {
  const btn = el<HTMLButtonElement>('bulk-discount-btn');
  const panel = el<HTMLDialogElement>('bulk-discount-panel');
  const closeBtn = el<HTMLButtonElement>('bulk-discount-close');
  const applyBtn = el<HTMLButtonElement>('bulk-discount-apply');
  const addSaleBtn = el<HTMLButtonElement>('bulk-discount-add-sale');
  const countEl = el('bulk-discount-count');
  if (!btn || !panel) return;

  // The shared selection — ticked AND on screen, so a discount never lands on a product
  // the current filter hides (see bulk-selection.ts).
  const selectedIds = (): string[] => selectedRowIds();

  const field = (): HTMLElement | null => panel.querySelector<HTMLElement>('[data-discount-field]');
  const fieldInput = (name: string): HTMLInputElement | HTMLSelectElement | null =>
    field()?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`) ?? null;

  /** The discount every selected row currently carries, when they all carry the SAME one
   *  (a single selected product is just the n=1 case). `null` when they differ — there is no
   *  one value to show, and inventing one would be a silent edit. */
  const sharedDiscount = (ids: string[]): ProductDiscount | null | undefined => {
    const raw = ids.map((id) =>
      document.querySelector<HTMLElement>(`[data-product-display="${CSS.escape(id)}"]`)?.dataset.discount ?? '');
    if (!raw.length) return undefined;
    if (!raw.every((v) => v === raw[0])) return undefined;
    if (!raw[0]) return null;
    try { return JSON.parse(raw[0]) as ProductDiscount; } catch { return undefined; }
  };

  /** Open the panel showing what the selection ALREADY has, rather than a blank form that reads
   *  as "no discount" for a product that plainly has one. */
  const prefill = (): void => {
    const shared = sharedDiscount(selectedIds());
    if (shared === undefined) return;                    // mixed selection — leave as the seller left it
    const set = (name: string, value: string): void => {
      const input = fieldInput(name);
      if (input) input.value = value;
    };
    set('discount_type', shared?.type ?? '');
    set('discount_value', shared ? String(shared.value) : '');
    set('discount_starts', shared?.startsAt ?? '');
    set('discount_ends', shared?.endsAt ?? '');
    const badge = fieldInput('discount_badge') as HTMLInputElement | null;
    if (badge) badge.checked = shared?.showBadge !== false;
    // Re-syncs the portal dropdown's visible label + the "price after discount" readout.
    refreshDiscountFieldsIn(panel);
  };

  btn.addEventListener('click', () => {
    if (panel.open) { panel.close(); return; }
    prefill();
    if (countEl) countEl.textContent = `(${selectedIds().length})`;
    // showModal (not show) is what gives the focus trap, the backdrop and Escape-to-close.
    panel.showModal();
  });
  closeBtn?.addEventListener('click', () => panel.close());
  // Click on the backdrop = outside the dialog's own box.
  panel.addEventListener('click', (e) => {
    if (e.target === panel) panel.close();
  });

  const send = async (mode: 'apply' | 'add-to-sale', button: HTMLButtonElement): Promise<void> => {
    const ids = selectedIds();
    if (!ids.length) return;
    const get = (name: string): string => fieldInput(name)?.value ?? '';
    // Removing a discount is "ללא הנחה" + Apply, not its own button: the seller asked that
    // nothing be written until Apply is pressed, and an immediate delete button contradicted
    // that — it saved the moment it was clicked, with the rest of the dialog still unsaved.
    const clear = mode === 'apply' && !get('discount_type');
    const body = new FormData();
    body.set('_action', mode === 'add-to-sale' ? 'add-to-store-sale' : 'bulk-discount');
    body.set('storeId', panel.dataset.storeId ?? '');
    body.set('productIds', ids.join(','));
    if (clear) body.set('clear', '1');
    else if (mode === 'apply') {
      // Under the field, never a toast — the site's one validation shape (`field-validity.ts`).
      // A toast for a missing field floats away and leaves the form looking exactly as it did.
      const valueField = panel.querySelector<HTMLInputElement>('[name="discount_value"]');
      if (!(Number(get('discount_value')) > 0)) {
        if (valueField) { showFieldError(valueField, i.discountValueRequired ?? 'הזינו גובה הנחה'); valueField.focus(); }
        return;
      }
      if (valueField) clearFieldError(valueField);
      body.set('discount_type', get('discount_type'));
      body.set('discount_value', get('discount_value'));
      body.set('discount_starts', get('discount_starts'));
      body.set('discount_ends', get('discount_ends'));
      if ((fieldInput('discount_badge') as HTMLInputElement | null)?.checked) body.set('discount_badge', '1');
    }

    button.disabled = true;
    button.classList.add('btn--busy');
    try {
      const endpoint = mode === 'add-to-sale' ? '/api/store' : '/api/product';
      const res = await fetch(endpoint, { method: 'POST', body });
      const data = await res.json() as BulkDiscountResponse;
      if (!data.ok) throw new Error(data.error ?? 'failed');
      // One call updates the row's cached record, its chip AND its inline edit form — the edit
      // form is synced whether it is open or closed, because it is rendered once by the server
      // and never re-read on expand ("stays old until I refresh the page").
      data.applied?.forEach((row) => syncProductRow(row.id, row.discount));
      // "מוצרים במבצע" is rendered on the server, so a change made from the Products tab leaves
      // it showing the previous catalog until something re-renders it.
      markPromotionsStale();
      showToast(clear ? (i.bulkDiscountCleared ?? 'ההנחה הוסרה')
        : mode === 'add-to-sale' ? (i.bulkAddedToSale ?? 'המוצרים נוספו למבצע')
        : (i.bulkDiscountDone ?? 'המבצע הוחל'));
      panel.close();
    } catch {
      showErrorToast(i.bulkDiscountError ?? 'לא הצלחנו להחיל את המבצע');
    } finally {
      button.disabled = false;
      button.classList.remove('btn--busy');
    }
  };

  applyBtn?.addEventListener('click', () => void send('apply', applyBtn));
  addSaleBtn?.addEventListener('click', () => void send('add-to-sale', addSaleBtn));
}

/** The sale's "selected products" scope field — the shared dashboard picker
 *  (product-multi-picker.ts, also used by the advertising tab's boost scope). Returns a repaint
 *  function the scope switch calls, since a container that was hidden renders nothing. */
function initProductPicker(i: Record<string, string>): () => void {
  const list = el('sale-products-list');
  const hidden = el<HTMLInputElement>('sale-product-ids');
  if (!list || !hidden) return () => {};

  const picker = initProductMultiPicker({
    list,
    hidden,
    search: el<HTMLInputElement>('sale-products-search'),
    count: el('sale-products-count'),
    options: readProductOptions('sale-products-data'),
    labels: { selected: i.saleProductsSelected ?? 'נבחרו', none: i.saleProductsNone ?? '' },
  });
  return picker.render;
}

/** Everything that lives INSIDE #dash-panel-promotions. Split out from initPromotionsTab so it
 *  can be re-run after the panel's HTML is replaced — the Products tab can change what belongs
 *  in the "products on sale" list, and the panel is server-rendered, so the only way to keep it
 *  honest without duplicating its markup in JS is to re-render it from the server and re-wire. */
function initSaleForm(): void {
  const form = el<HTMLFormElement>('store-sale-form');
  const i = getI18n();

  if (form) {
    const active  = el<HTMLInputElement>('sale-active');
    const title   = el<HTMLInputElement>('sale-title');
    const text    = el<HTMLInputElement>('sale-text');
    const percent = el<HTMLInputElement>('sale-percent');
    const preview = el('sale-preview');
    const pvPct   = el('sale-preview-pct');
    const pvTitle = el('sale-preview-title');
    const pvText  = el('sale-preview-text');
    const pvEmpty = el('sale-preview-empty');
    const saveBtn = el<HTMLButtonElement>('store-sale-save-btn');
    const scope = el<HTMLSelectElement>('sale-scope');
    const scopeField = el('sale-category-field');
    const scopeInput = el<HTMLInputElement>('sale-category-id');
    const productsField = el('sale-products-field');
    const productIdsInput = el<HTMLInputElement>('sale-product-ids');

    // Only the ACTIVE scope's field keeps its value: leaving a category id (or a product list)
    // behind after switching would keep the sale narrow while the form says "the whole store".
    const refreshScope = (): void => {
      const mode = scope?.value ?? 'store';
      if (scopeField) scopeField.hidden = mode !== 'category';
      if (productsField) productsField.hidden = mode !== 'products';
      if (mode !== 'category' && scopeInput) {
        scopeInput.value = '';
        // Tell the picker its field was emptied from outside, or its trigger keeps showing
        // categories this sale no longer covers.
        scopeInput.dispatchEvent(new Event('picker:sync'));
      }
      if (mode !== 'products' && productIdsInput) productIdsInput.value = '';
      if (mode === 'products') renderProductPicker();
      refresh();
    };
    scope?.addEventListener('change', refreshScope);
    // A raw <select> renders with the OS's own popup, which is the one control on the page that
    // doesn't look like the rest of the site (and can't be clamped inside a scrollable panel).
    if (scope) initSelectDropdown(scope);

    const renderProductPicker = initProductPicker(i);

    // What the banner will print for the current scope: the picked category's path, the shared
    // "on selected items" wording, or the store-wide line. Only a category-scoped sale with no
    // category chosen yet prints nothing — that state can't be saved anyway, and printing the
    // store-wide line there would preview a sale the seller is not about to publish.
    const scopeLabel = (): string => {
      if (scope?.value === 'products') return pvText?.dataset.selectedLabel ?? '';
      if (scope?.value !== 'category') return pvText?.dataset.storeLabel ?? '';
      if (!scopeInput?.value) return '';
      return document.querySelector<HTMLElement>('#sale-category-field .category-picker__label')?.textContent?.trim() ?? '';
    };

    const refresh = (): void => {
      const on = !!active?.checked && !!title?.value.trim();
      if (preview) preview.hidden = !on;
      if (pvEmpty) pvEmpty.hidden = on;
      // `innerHTML`, from the same builder the banner and the server-rendered preview use: each
      // Latin run in the seller's copy has to arrive inside its own isolate, or a number typed
      // after a coupon code lands on the wrong side of it (lib/bidi-isolate.ts). A plain text node
      // here would leave the live preview as the one place still showing the old behaviour, which
      // is the exact drift a preview exists to prevent.
      // Escaped by that builder — this is text the seller is typing, going straight into the DOM.
      if (pvTitle) pvTitle.innerHTML = isolateLatinRunsHtml(title?.value.trim() ?? '');
      if (pvText) {
        // Same join StoreSaleBanner uses, so the preview can't drift from the real banner.
        const subtitle = [scopeLabel(), text?.value.trim()].filter(Boolean).join(' · ');
        pvText.innerHTML = isolateLatinRunsHtml(subtitle);
        pvText.hidden = !subtitle;
      }
      const pct = Math.round(Number(percent?.value ?? 0));
      if (pvPct) {
        pvPct.textContent = `-${pct}%`;
        pvPct.hidden = !(pct > 0);
      }
    };
    [active, title, text, percent].forEach((f) => {
      f?.addEventListener('input', refresh);
      f?.addEventListener('change', refresh);
    });
    // The category picker writes its ids into this hidden input and fires `input` on it. Without
    // this the preview only caught up on the next keystroke elsewhere — and with several
    // categories now pickable in one open menu, that is several ticks the preview would ignore.
    scopeInput?.addEventListener('input', refresh);
    refresh();
    refreshScope();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // An active sale with no headline would render as a blank green strip — caught here so the
      // seller sees why instantly, and again server-side (that check is the real one).
      if (active?.checked && !title?.value.trim()) {
        if (title) { showFieldError(title, i.storeSaleTitleRequired ?? 'צריך כותרת למבצע'); title.focus(); }
        return;
      }
      if (title) clearFieldError(title);
      // Category scope with nothing picked would save as a store-wide sale — a much bigger
      // discount than the seller just asked for. Stop it here rather than silently widening it.
      if (scope?.value === 'category' && !scopeInput?.value) {
        // The message hangs off the SCOPE control, which is the one the seller can see and change —
        // `scopeInput` is a hidden field carrying the picked value and has nothing to sit under.
        if (scope) { showFieldError(scope, i.saleScopeCategoryMissing ?? 'בחרו קטגוריה'); scope.focus(); }
        return;
      }
      if (scope?.value === 'products' && !productIdsInput?.value) {
        if (scope) { showFieldError(scope, i.saleScopeProductsMissing ?? 'בחרו לפחות מוצר אחד'); scope.focus(); }
        return;
      }
      if (scope) clearFieldError(scope);
      // Success is confirmed ON the button ("נשמר" + ✓), exactly like the Settings tab — this
      // form stays on screen after saving, so the confirmation belongs where the seller's
      // attention already is. A toast is reserved for the failure case, which needs to survive
      // the seller having looked away.
      const origText = saveBtn?.textContent ?? '';
      if (saveBtn) {
        saveBtn.style.minWidth = `${saveBtn.offsetWidth}px`;
        saveBtn.disabled = true;
        saveBtn.classList.add('btn--busy');
        // ⚠️ The THIRD hand-rolled copy of the busy-button markup. `scripts/dashboard/btn-busy.ts`
        // owns this treatment now (it was extracted from store-image.ts and header-logo.ts on
        // 2026-08-09) and this one should move onto it — it is left in place only because this
        // button's restore is not the module's: it also pins `minWidth` and clears
        // `btn--confirmed`, so the swap is a change to the save flow rather than a substitution.
        // Escaped in the meantime for the reason btn-busy.ts stopped using innerHTML at all:
        // `aria-label="${…}"` is an attribute context, and this file had no escaper at all.
        const savingLabel = esc(i.savingShort ?? 'שומר');
        saveBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.5em">${savingLabel}<span class="dot-pulse" role="status" aria-label="${savingLabel}"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span></span>`;
      }
      const restoreSave = (): void => {
        if (!saveBtn) return;
        saveBtn.disabled = false;
        saveBtn.classList.remove('btn--busy', 'btn--confirmed');
        saveBtn.style.minWidth = '';
        saveBtn.textContent = origText;
      };
      try {
        const res = await fetch('/api/store', { method: 'POST', body: new FormData(form) });
        const data = await res.json() as SaleResponse;
        if (!data.ok) throw new Error(data.error ?? 'failed');
        // The form is now the saved state — re-baseline the unsaved-changes guard.
        window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form } }));
        if (saveBtn) {
          // btn--confirmed keeps it disabled through the hold (blocks a double-submit) while
          // reading as success, not as blocked.
          saveBtn.classList.remove('btn--busy');
          saveBtn.classList.add('btn--confirmed');
          saveBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${CHECK_SVG}${i.saved ?? 'נשמר'}</span>`;
          saveBtn.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
            { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
          );
          setTimeout(restoreSave, 1500);
        }
      } catch {
        showErrorToast(i.storeSaleSaveError ?? 'לא הצלחנו לשמור את המבצע');
        restoreSave();
      }
    });
  }

  // Roll-up rows: end one product's own discount without leaving the tab.
  document.querySelectorAll<HTMLButtonElement>('[data-clear-discount]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const productId = btn.dataset.clearDiscount ?? '';
      const storeId = btn.dataset.storeId ?? '';
      if (!productId || !storeId) return;
      btn.disabled = true;
      const body = new FormData();
      body.set('_action', 'bulk-discount');
      body.set('storeId', storeId);
      body.set('productIds', productId);
      body.set('clear', '1');
      try {
        const res = await fetch('/api/product', { method: 'POST', body });
        const data = await res.json() as SaleResponse;
        if (!data.ok) throw new Error(data.error ?? 'failed');
        document.querySelector(`[data-discounted-row="${CSS.escape(productId)}"]`)?.remove();
        // The Products tab shows the same product — its chip and its edit form are now stale.
        window.dispatchEvent(new CustomEvent('promo:product-discount-changed', { detail: { id: productId } }));
        showToast(i.saleCleared ?? 'ההנחה הוסרה מהמוצר');
      } catch {
        btn.disabled = false;
        showErrorToast(i.saleClearError ?? 'לא הצלחנו להסיר את ההנחה');
      }
    });
  });
}

/** Write a product's new discount into every place the Products tab caches it: the row's own
 *  `data-discount`, its "-N%" chip (resolved through the running sale, like the server does) and
 *  its inline edit form. Shared by the bulk dialog and the Promotions roll-up so neither can
 *  leave the other stale. */
export function syncProductRow(id: string, discount: ProductDiscount | null): void {
  const row = document.querySelector<HTMLElement>(`[data-product-display="${CSS.escape(id)}"]`);
  if (row) {
    row.dataset.discount = discount ? JSON.stringify(discount) : '';
    // …and the island the edit form is built from, for a row nobody has opened yet. Without it the
    // form would open holding the discount this call just replaced, and saving would restore it.
    syncPageProduct(row);
  }

  const chip = document.querySelector<HTMLElement>(`[data-row-sale="${CSS.escape(id)}"]`);
  if (chip && row) {
    const view = resolvePrice({
      id,
      price: Number(row.dataset.sortPrice ?? 0),
      categoryId: row.dataset.categoryId || undefined,
      discount: discount ?? undefined,
    }, dashStoreSale());
    chip.textContent = view.isDiscounted ? `-${view.percentOff}%` : '';
    chip.hidden = !view.isDiscounted;
  }

  const editRow = document.querySelector<HTMLElement>(`[data-product-edit="${CSS.escape(id)}"]`);
  const editField = editRow?.querySelector<HTMLElement>('[data-discount-field]');
  if (!editRow || !editField) return;
  const set = (name: string, value: string): void => {
    const input = editField.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    if (input) input.value = value;
  };
  set('discount_type', discount?.type ?? '');
  set('discount_value', discount ? String(discount.value) : '');
  set('discount_starts', discount?.startsAt ?? '');
  set('discount_ends', discount?.endsAt ?? '');
  const badge = editField.querySelector<HTMLInputElement>('[name="discount_badge"]');
  if (badge) badge.checked = discount?.showBadge !== false;
  refreshDiscountFieldsIn(editRow);
  // The form now matches what is stored — it must stop counting as unsaved against the old value.
  const editForm = editRow.querySelector<HTMLFormElement>('form');
  if (editForm) window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: editForm } }));
}

/** The Promotions panel is server-rendered, so a discount changed from the Products tab leaves
 *  its "products on sale" list showing the previous catalog. Rather than rebuilding those rows
 *  in JS — a second copy of markup that would drift from the Astro component — the panel is
 *  marked stale and re-fetched from the server the next time the seller opens it. Deferring to
 *  tab-open means a seller applying twenty discounts in a row pays for one re-render, not twenty.
 */
let promotionsStale = false;

export function markPromotionsStale(): void {
  promotionsStale = true;
}

async function refreshPromotionsPanel(): Promise<void> {
  const panel = el('dash-panel-promotions');
  if (!panel || !promotionsStale) return;
  promotionsStale = false;
  try {
    const res = await fetch(location.href, { headers: { 'X-Requested-With': 'fetch' } });
    const html = await res.text();
    const fresh = new DOMParser().parseFromString(html, 'text/html').getElementById('dash-panel-promotions');
    if (!fresh) return;
    panel.innerHTML = fresh.innerHTML;
    initSaleForm();
    // silent: a background re-render of a panel nobody is waiting on; the stale one stays usable.
  } catch {
    // A failed refresh must not leave the panel permanently un-refreshable.
    promotionsStale = true;
  }
}

/**
 * The "מבצע" button and its dialog live in the PRODUCTS panel, not in this one — so they have to be
 * bound when Products loads, and until 2026-08-23 they were not: the only caller was
 * `initPromotionsTab`, which runs when the Promotions tab is opened. Tick rows, press מבצע, and
 * nothing happened at all — unless the seller had happened to visit Promotions earlier in the same
 * page life, which is why it looked like it worked (owner: *"וכלום לא קורה כשלוחצים על מבצע
 * בסרגל הצף"*).
 *
 * Exported and idempotent, because both tabs now reach it and either can be opened first. The code
 * stays in this module rather than moving to `products.ts`: it patches the promotions roll-up
 * (`markPromotionsStale`) and every row's chip (`syncProductRow`), so it belongs with them — the
 * products chunk imports it on demand instead, which costs nothing until the button is pressed.
 */
let bulkDiscountBound = false;
export function ensureBulkDiscount(): void {
  if (bulkDiscountBound) return;
  bulkDiscountBound = true;
  initBulkDiscount(getI18n());
}

export function initPromotionsTab(): void {
  initSaleForm();
  ensureBulkDiscount();
  // The sale's category-scope picker. Bound from THIS chunk, not by the sweep that used to run in
  // the products chunk: this panel arrives on the click that opens it, long after that sweep — so
  // the trigger did nothing at all unless the seller happened to open the Products tab afterwards
  // (see bindCategoryPickersIn).
  bindCategoryPickersIn('dash-panel-promotions');

  // The reverse direction of markPromotionsStale(): a discount removed from the roll-up leaves
  // the Products tab's chip and inline edit form showing the value it no longer has.
  window.addEventListener('promo:product-discount-changed', (e) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id;
    if (id) syncProductRow(id, null);
  });

  const panel = el('dash-panel-promotions');
  // Re-render on every open while stale, not once: the seller can bounce between tabs.
  panel?.addEventListener('dashtab:show', () => void refreshPromotionsPanel());
}
