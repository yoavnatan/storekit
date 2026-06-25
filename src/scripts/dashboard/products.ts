import { esc } from '../../lib/gallery-widget.js';
import { galleryWidgetHtml, initGalleryWidget, resolveGalleryUrls, resetGallery } from './gallery.js';
import { showStatus } from './status.js';
import { formatPrice } from '../../config/store.config.js';

export interface ProductData {
  id: string; storeId: string; name: string;
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

export function buildRows(p: ProductData, cloud: string, preset: string): [HTMLTableRowElement, HTMLTableRowElement] {
  const i = getDashI18n();
  const g = getGalleryI18n();

  const display = document.createElement('tr');
  display.dataset.productDisplay = p.id;
  display.dataset.sortName = p.name.toLowerCase();
  display.dataset.sortPrice = String(p.price);
  display.dataset.sortStock = String(p.stock);
  display.dataset.sortWishlist = '0';
  display.innerHTML = `
    <td class="num row-num"></td>
    <td>
      <div class="product-name-cell">
        ${p.images?.[0] ? `<img src="${esc(p.images[0])}" alt="" class="product-thumb" width="42" height="42" loading="lazy">` : ''}
        <div>
          <span class="product-name">${esc(p.name)}</span>
          ${p.description ? `<span class="product-desc">${esc(p.description)}</span>` : ''}
        </div>
      </div>
    </td>
    <td class="num product-price">${fmtPrice(p.price)}</td>
    <td class="num product-stock">${stockHtml(p.stock, i.outOfStock ?? 'Out of stock')}</td>
    <td class="num" style="color:var(--color-muted);font-size:0.82rem">—</td>
    <td class="actions">
      <button class="btn btn--ghost btn--sm" type="button" data-edit-toggle="${p.id}">${i.edit ?? 'Edit'}</button>
      <button class="btn btn--danger btn--sm" type="button" data-delete-product="${p.id}" data-store-id="${esc(p.storeId)}">${i.delete ?? 'Delete'}</button>
    </td>`;

  const edit = document.createElement('tr');
  edit.className = 'edit-row';
  edit.dataset.productEdit = p.id;
  edit.hidden = true;
  edit.innerHTML = `
    <td colspan="6">
      <form method="POST" action="/api/product" class="dash-form inline-edit-form">
        <input type="hidden" name="_action" value="edit-product">
        <input type="hidden" name="productId" value="${p.id}">
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
          <button class="btn btn--sm" type="submit">${i.save ?? 'Save'}</button>
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
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = i18n.saving ?? 'Saving…'; }

  try {
    const gallery = form.querySelector<Element>('.gallery-widget');
    try {
      if (gallery) await resolveGalleryUrls(gallery, cloud, preset);
    } catch {
      showStatus(i18n.uploadFailed ?? 'Image upload failed. Please try again.', true);
      return;
    }

    const fd = new FormData(form);
    const res = await fetch('/api/product', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; images?: string[]; error?: string };
    if (!data.ok) { showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true); return; }

    const savedImages = data.images ?? [];
    const savedImage = savedImages[0] ?? null;

    const displayRow = document.querySelector<HTMLTableRowElement>(`[data-product-display="${productId}"]`);
    const editRow    = document.querySelector<HTMLTableRowElement>(`[data-product-edit="${productId}"]`);

    if (displayRow) {
      const name = String(fd.get('name'));
      const description = String(fd.get('description'));
      const price = parseFloat(String(fd.get('price')));
      const stock = parseInt(String(fd.get('stock')), 10);

      const nameCell = displayRow.querySelector<HTMLElement>('.product-name-cell');
      if (nameCell) {
        let thumb = nameCell.querySelector<HTMLImageElement>('.product-thumb');
        // Prefer the gallery slot's current src (may be a blob URL = immediate, no network fetch)
        const gallerySrc = (() => {
          if (!gallery) return null;
          const slot = gallery.querySelector<Element>('.gallery-slot');
          const filled = slot?.querySelector<HTMLElement>('.gallery-slot__filled');
          if (!filled || filled.hasAttribute('hidden')) return null;
          return slot?.querySelector<HTMLImageElement>('.gallery-slot__img')?.getAttribute('src') ?? null;
        })();
        const thumbSrc = gallerySrc || savedImage;
        if (thumbSrc) {
          if (!thumb) {
            thumb = document.createElement('img');
            thumb.className = 'product-thumb';
            thumb.width = 42; thumb.height = 42;
            thumb.alt = '';
            nameCell.prepend(thumb);
          }
          thumb.src = thumbSrc;
        } else { thumb?.remove(); }
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
    if (editRow) editRow.hidden = true;
    if (displayRow) displayRow.hidden = false;
    showStatus(i18n.productUpdated ?? 'Product updated.');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText; }
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

export function renumberRows(): void {
  document
    .querySelectorAll<HTMLElement>('#products-tbody [data-product-display] .row-num')
    .forEach((cell, i) => { cell.textContent = String(i + 1); });
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
