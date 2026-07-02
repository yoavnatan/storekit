import { esc } from '../../lib/gallery-widget.js';
import { galleryWidgetHtml, initGalleryWidget, resolveGalleryUrls, resetGallery } from './gallery.js';
import { showStatus } from './status.js';
import { formatPrice } from '../../config/store.config.js';
import { thumbUrl } from './cloudinary.js';

export interface ProductData {
  id: string; storeId: string; slug?: string; name: string;
  description: string; price: number; stock: number; images?: string[];
  category?: string; tags?: string[];
  specs?: Array<{ label: string; value: string }>;
  variants?: Array<{ name: string; options: string[] }>;
}

function fmtPrice(n: number) { return formatPrice(n); }


function warnIcon(label: string): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${esc(label)}" style="color:var(--color-danger,#dc2626);flex-shrink:0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

function stockHtml(stock: number, outOfStockLabel: string): string {
  return stock <= 0
    ? `<span style="display:inline-flex;align-items:center;gap:0.3rem"><span>0</span>${warnIcon(outOfStockLabel)}</span>`
    : String(stock);
}

function getRawI18n() {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}'); } catch { return {}; }
}
function getDashI18n() { return getRawI18n().dashboard ?? {}; }
function getGalleryI18n() { return getRawI18n().gallery ?? {}; }

function categoryFieldHtml(category: string, i18n: Record<string, string>): string {
  return `<label class="field">
    <span>${esc(i18n.categoryLabel ?? 'Category')}</span>
    <input class="input" name="category" value="${esc(category)}" placeholder="${esc(i18n.categoryPlaceholder ?? '')}" list="store-categories-list">
  </label>`;
}

function tagsFieldHtml(tags: string[], i18n: Record<string, string>): string {
  return `<label class="field">
    <span>${esc(i18n.tagsLabel ?? 'Tags')}</span>
    <input class="input" name="tags" value="${esc(tags.join(', '))}" placeholder="${esc(i18n.tagsPlaceholder ?? '')}">
  </label>`;
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

function variantEditorHtml(variants: Array<{ name: string; options: string[] }>, i18n: Record<string, string>): string {
  const blocksHtml = variants.map(v => `
    <div class="variant-block" style="border:1px solid var(--color-border);border-radius:var(--radius);padding:0.65rem;margin-bottom:0.5rem">
      <div style="display:flex;gap:0.5rem;align-items:flex-end">
        <label class="field" style="flex:1;margin:0">
          <span>${esc(i18n.variantNameLabel ?? 'Name')}</span>
          <input class="input" name="variant_name" value="${esc(v.name)}" placeholder="${esc(i18n.variantNamePlaceholder ?? '')}">
        </label>
        <label class="field" style="flex:2;margin:0">
          <span>${esc(i18n.variantOptionsLabel ?? 'Options')}</span>
          <input class="input" name="variant_options" value="${esc(v.options.join(', '))}" placeholder="${esc(i18n.variantOptionsPlaceholder ?? '')}">
        </label>
        <button type="button" class="variant-remove-btn btn btn--ghost btn--sm" aria-label="${esc(i18n.variantRemove ?? 'Remove')}" style="flex-shrink:0;margin-bottom:0.1rem">×</button>
      </div>
    </div>`).join('');
  return `<div class="field">
    <span class="field-label">${esc(i18n.variantsLabel ?? 'Variants')}</span>
    <div class="variants-list">${blocksHtml}</div>
    <button type="button" class="variants-add-btn btn btn--ghost btn--sm" style="margin-top:0.5rem">${esc(i18n.variantAddBtn ?? '+ Add variant')}</button>
  </div>`;
}

export function initVariantEditors(): void {
  document.addEventListener('click', (e) => {
    const addBtn = (e.target as Element).closest<HTMLButtonElement>('.variants-add-btn');
    if (addBtn) {
      const list = addBtn.closest('.field')?.querySelector<HTMLElement>('.variants-list');
      if (!list) return;
      const i18n = getDashI18n();
      const block = document.createElement('div');
      block.className = 'variant-block';
      block.style.cssText = 'border:1px solid var(--color-border);border-radius:var(--radius);padding:0.65rem;margin-bottom:0.5rem';
      block.innerHTML = `
        <div style="display:flex;gap:0.5rem;align-items:flex-end">
          <label class="field" style="flex:1;margin:0">
            <span>${esc(i18n.variantNameLabel ?? 'Name')}</span>
            <input class="input" name="variant_name" placeholder="${esc(i18n.variantNamePlaceholder ?? '')}">
          </label>
          <label class="field" style="flex:2;margin:0">
            <span>${esc(i18n.variantOptionsLabel ?? 'Options')}</span>
            <input class="input" name="variant_options" placeholder="${esc(i18n.variantOptionsPlaceholder ?? '')}">
          </label>
          <button type="button" class="variant-remove-btn btn btn--ghost btn--sm" aria-label="${esc(i18n.variantRemove ?? 'Remove')}" style="flex-shrink:0;margin-bottom:0.1rem">×</button>
        </div>`;
      list.appendChild(block);
      block.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    const removeBtn = (e.target as Element).closest<HTMLButtonElement>('.variant-remove-btn');
    if (removeBtn) removeBtn.closest('.variant-block')?.remove();
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
  display.dataset.category = p.category ?? '';
  display.dataset.productSlug = p.slug ?? '';
  display.dataset.storeSlug = resolvedStoreSlug;
  display.dataset.storeName = resolvedStoreName;
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
    <td class="num product-stock">${stockHtml(p.stock, i.outOfStock ?? 'Out of stock')}</td>
    <td class="num" style="color:var(--color-muted);font-size:0.82rem">—</td>
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
        </div>
        <div class="field-row">
          <label class="field"><span>${i.nameReq ?? 'Name *'}</span><input class="input" name="name" value="${esc(p.name)}" required></label>
          <label class="field"><span>${i.priceLabel ?? 'Price'}</span><input class="input" name="price" type="number" min="0" step="0.01" value="${p.price}"></label>
          <label class="field"><span>${i.colStock ?? 'Stock'}</span><input class="input" name="stock" type="number" min="0" step="1" value="${p.stock}"></label>
        </div>
        <label class="field"><span>${i.descLabel ?? 'Description'}</span><textarea class="input" name="description" rows="2">${esc(p.description)}</textarea></label>
        ${categoryFieldHtml(p.category ?? '', i)}
        ${tagsFieldHtml(p.tags ?? [], i)}
        ${variantEditorHtml(p.variants ?? [], i)}
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
  const submitBtn = form.querySelector<HTMLButtonElement>('[type="submit"]');
  const i18n = getDashI18n();
  const origText = submitBtn?.textContent ?? (i18n.save ?? 'Save');
  const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = i18n.saving ?? 'Saving…'; }

  try {
    const gallery = form.querySelector<Element>('.gallery-widget');
    try {
      if (gallery) await resolveGalleryUrls(gallery, cloud, preset);
    } catch {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText; }
      showStatus(i18n.uploadFailed ?? 'Image upload failed. Please try again.', true);
      return;
    }

    const fd = new FormData(form);
    const res = await fetch('/api/product', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; images?: string[]; error?: string };
    if (!data.ok) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText; }
      showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true);
      return;
    }

    const savedImages = data.images ?? [];
    const savedImage = savedImages[0] ?? null;

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
          initThumbs(wrap);
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
      if (stockCell) stockCell.innerHTML = stockHtml(stock, i18n.outOfStock ?? 'Out of stock');

      displayRow.dataset.sortName = name.toLowerCase();
      displayRow.dataset.sortPrice = String(price);
      displayRow.dataset.sortStock = String(stock);
    }

    // Lock width → swap label → animate → close after delay (same pattern as add-to-cart btn)
    if (submitBtn) {
      submitBtn.style.minWidth = `${submitBtn.offsetWidth}px`;
      submitBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${checkSvg}${i18n.saved ?? 'נשמר'}</span>`;
      submitBtn.disabled = true;
      submitBtn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      );
    }
    setTimeout(() => {
      if (editRow) editRow.hidden = true;
      if (displayRow) displayRow.hidden = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.style.minWidth = ''; submitBtn.textContent = origText; }
    }, 1500);
  } catch {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText; }
    showStatus(i18n.errorSaving ?? 'Error saving.', true);
  }
}

export function attachListeners(display: HTMLTableRowElement, edit: HTMLTableRowElement, cloud: string, preset: string): void {
  display.querySelector('[data-edit-toggle]')?.addEventListener('click', () => {
    display.hidden = true; edit.hidden = false;
  });
  edit.querySelector('[data-cancel-edit]')?.addEventListener('click', () => {
    edit.hidden = true; display.hidden = false;
  });
  (edit.querySelector('form') as HTMLFormElement | null)
    ?.addEventListener('submit', (e) => void handleEditSubmit(e as SubmitEvent, cloud, preset));
  const gallery = edit.querySelector<Element>('.gallery-widget');
  if (gallery) initGalleryWidget(gallery, cloud, preset);
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
        renumberRows();
        initThumbs(display);
        refreshCategoryFilter();
      }

      addForm.reset();
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
          renumberRows();
          refreshCategoryFilter();

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
  document
    .querySelectorAll<HTMLElement>('#products-tbody [data-product-display] .row-num')
    .forEach((cell, i) => {
      const num = String(i + 1);
      cell.textContent = num;
      const productId = cell.closest<HTMLElement>('[data-product-display]')?.dataset.productDisplay;
      if (productId) {
        const editNum = document.querySelector<HTMLElement>(`[data-product-edit="${productId}"] .row-num`);
        if (editNum) editNum.textContent = num;
      }
    });
}

export function initTableSort(): void {
  let sortCol = '';
  let sortDir = 'asc';

  function sortTable(col: string) {
    const defaultDir = col === 'wishlist' ? 'desc' : 'asc';
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
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    for (const display of rows) {
      const edit = tbody.querySelector<HTMLTableRowElement>(`[data-product-edit="${display.dataset.productDisplay}"]`);
      tbody.append(display);
      if (edit) tbody.append(edit);
    }
    renumberRows();

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

    const nameEl   = target.closest<HTMLElement>('.product-name');
    const priceEl  = !nameEl ? target.closest<HTMLElement>('.product-price') : null;
    const stockEl  = !nameEl && !priceEl ? target.closest<HTMLElement>('.product-stock') : null;
    const trigger  = nameEl ?? priceEl ?? stockEl;
    if (!trigger) return;

    const row = trigger.closest<HTMLElement>('[data-product-display]');
    if (!row) return;
    const productId = row.dataset.productDisplay ?? '';

    // Don't activate while full edit row is open
    const editRow = document.querySelector<HTMLElement>(`[data-product-edit="${productId}"]`);
    if (editRow && !editRow.hidden) return;

    const field = nameEl ? 'name' : priceEl ? 'price' : 'stock';
    activateInlineEdit(trigger, row, productId, field as 'name' | 'price' | 'stock', i);
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
  let activeCat = '';

  function getCategories(): string[] {
    const cats = new Set<string>();
    document.querySelectorAll<HTMLElement>('[data-product-display]').forEach((r) => {
      const c = r.dataset.category;
      if (c) cats.add(c);
    });
    return [...cats].sort();
  }

  function applyFilter(): void {
    document.querySelectorAll<HTMLElement>('[data-product-display]').forEach((row) => {
      const show = !activeCat || row.dataset.category === activeCat;
      row.hidden = !show;
      const editRow = document.querySelector<HTMLElement>(`[data-product-edit="${row.dataset.productDisplay}"]`);
      if (editRow && !show) editRow.hidden = true;
    });
  }

  function renderChips(): void {
    const cats = getCategories();
    if (cats.length === 0) { bar!.hidden = true; return; }
    if (!cats.includes(activeCat)) activeCat = '';
    bar!.hidden = false;
    bar!.innerHTML = [
      `<button type="button" class="cat-chip${!activeCat ? ' cat-chip--active' : ''}" data-filter-cat="">${esc(i.filterAll ?? 'הכל')}</button>`,
      ...cats.map((c) => `<button type="button" class="cat-chip${activeCat === c ? ' cat-chip--active' : ''}" data-filter-cat="${esc(c)}">${esc(c)}</button>`),
    ].join('');
  }

  bar.addEventListener('click', (e) => {
    const chip = (e.target as Element).closest<HTMLButtonElement>('[data-filter-cat]');
    if (!chip) return;
    activeCat = chip.dataset.filterCat ?? '';
    renderChips();
    applyFilter();
  });

  renderChips();
  _refreshCatFilter = renderChips;
}

export function initBulkSelect(cloud: string, preset: string): void {
  const uploadPanel    = document.getElementById('bulk-upload-panel') as HTMLElement | null;
  const selectAllChk   = document.getElementById('bulk-select-all') as HTMLInputElement | null;
  const bulkCountEl    = document.getElementById('bulk-count') as HTMLElement | null;
  const bulkCountBadge = document.getElementById('bulk-count-badge') as HTMLElement | null;
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
    if (bulkDeleteBtn) bulkDeleteBtn.hidden = empty;
    if (bulkUploadBtn) bulkUploadBtn.hidden = empty;
    if (bulkEditBtn) bulkEditBtn.hidden = empty;
    if (bulkSep) bulkSep.hidden = empty;
    if (empty && uploadPanel) uploadPanel.hidden = true;
    if (empty && bulkEditLabel) bulkEditLabel.textContent = i.bulkEdit ?? 'ערוך';
    if (empty && selectAllChk) selectAllChk.hidden = false;

    if (selectAllChk) {
      selectAllChk.indeterminate = selected.size > 0;
      selectAllChk.checked = false;
    }
  }

  // Checkbox change (delegated)
  document.addEventListener('change', (e) => {
    const chk = (e.target as Element).closest<HTMLInputElement>('[data-bulk-check]');
    if (!chk) return;
    const id = chk.dataset.bulkCheck ?? '';
    if (chk.checked) selected.add(id); else selected.delete(id);
    updateBar();
  });

  // Select all — if anything is selected, deselect all; else select all
  // Read selected.size BEFORE loop (still reflects pre-click state in change handler)
  selectAllChk?.addEventListener('change', () => {
    const shouldSelect = selected.size === 0;
    getCheckboxes().forEach((c) => {
      c.checked = shouldSelect;
      const id = c.dataset.bulkCheck ?? '';
      if (shouldSelect) selected.add(id); else selected.delete(id);
    });
    updateBar();
  });

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
          renumberRows();
          const tbody = document.getElementById('products-tbody');
          if (tbody && tbody.querySelectorAll('[data-product-display]').length === 0) {
            document.getElementById('products-table')?.setAttribute('hidden', '');
            document.getElementById('empty-products')?.removeAttribute('hidden');
          }
          refreshCategoryFilter();
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
    if (selectAllChk) selectAllChk.hidden = !anyOpen;
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
