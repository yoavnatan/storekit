import { esc } from '../../lib/gallery-widget.js';
import { galleryWidgetHtml, initGalleryWidget, resolveGalleryUrls, resetGallery } from './gallery.js';
import { showStatus } from './status.js';

export interface ProductData {
  id: string; storeId: string; name: string;
  description: string; price: number; stock: number; images?: string[];
}

function fmtPrice(n: number) { return `$${n.toFixed(2)}`; }

export function buildRows(p: ProductData, cloud: string, preset: string): [HTMLTableRowElement, HTMLTableRowElement] {
  const display = document.createElement('tr');
  display.dataset.productDisplay = p.id;
  display.dataset.sortName = p.name.toLowerCase();
  display.dataset.sortPrice = String(p.price);
  display.dataset.sortStock = String(p.stock);
  display.innerHTML = `
    <td>
      <div class="product-name-cell">
        ${p.images?.[0] ? `<img src="${esc(p.images[0])}" alt="" class="product-thumb" width="30" height="30" loading="lazy">` : ''}
        <div>
          <span class="product-name">${esc(p.name)}</span>
          ${p.description ? `<span class="product-desc">${esc(p.description)}</span>` : ''}
        </div>
      </div>
    </td>
    <td class="num">${fmtPrice(p.price)}</td>
    <td class="num">${p.stock}</td>
    <td class="actions">
      <button class="btn btn--ghost btn--sm" type="button" data-edit-toggle="${p.id}">Edit</button>
      <button class="btn btn--danger btn--sm" type="button" data-delete-product="${p.id}" data-store-id="${esc(p.storeId)}">Delete</button>
    </td>`;

  const edit = document.createElement('tr');
  edit.className = 'edit-row';
  edit.dataset.productEdit = p.id;
  edit.hidden = true;
  edit.innerHTML = `
    <td colspan="4">
      <form method="POST" action="/api/product" class="dash-form inline-edit-form">
        <input type="hidden" name="_action" value="edit-product">
        <input type="hidden" name="productId" value="${p.id}">
        <div class="field-row">
          <label class="field"><span>Name <span class="req">*</span></span><input class="input" name="name" value="${esc(p.name)}" required></label>
          <label class="field"><span>Price ($)</span><input class="input" name="price" type="number" min="0" step="0.01" value="${p.price}"></label>
          <label class="field"><span>Stock</span><input class="input" name="stock" type="number" min="0" step="1" value="${p.stock}"></label>
        </div>
        <label class="field"><span>Description</span><textarea class="input" name="description" rows="2">${esc(p.description)}</textarea></label>
        <div class="field">
          <span class="field-label">Product images</span>
          ${galleryWidgetHtml(p.images ?? [])}
        </div>
        <div class="form-actions">
          <button class="btn btn--sm" type="submit">Save</button>
          <button class="btn btn--ghost btn--sm" type="button" data-cancel-edit="${p.id}">Cancel</button>
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
  const origText = submitBtn?.textContent ?? 'Save';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  try {
    const gallery = form.querySelector<Element>('.gallery-widget');
    try {
      if (gallery) await resolveGalleryUrls(gallery, cloud, preset);
    } catch {
      showStatus('Image upload failed. Please try again.', true);
      return;
    }

    const fd = new FormData(form);
    const res = await fetch('/api/product', { method: 'POST', body: fd });
    const data = await res.json() as { ok: boolean; images?: string[]; error?: string };
    if (!data.ok) { showStatus(data.error ?? 'Error saving.', true); return; }

    const savedImages = data.images ?? [];
    const savedImage = savedImages[0] ?? null;

    const displayRow = document.querySelector<HTMLTableRowElement>(`[data-product-display="${productId}"]`);
    const editRow    = document.querySelector<HTMLTableRowElement>(`[data-product-edit="${productId}"]`);

    if (displayRow) {
      const name = String(fd.get('name'));
      const description = String(fd.get('description'));
      const price = parseFloat(String(fd.get('price')));
      const stock = String(fd.get('stock'));

      const nameCell = displayRow.querySelector<HTMLElement>('.product-name-cell');
      if (nameCell) {
        let thumb = nameCell.querySelector<HTMLImageElement>('.product-thumb');
        if (savedImage) {
          if (!thumb) {
            thumb = document.createElement('img');
            thumb.className = 'product-thumb';
            thumb.width = 30; thumb.height = 30;
            thumb.loading = 'lazy'; thumb.alt = '';
            nameCell.prepend(thumb);
          }
          thumb.src = savedImage;
        } else { thumb?.remove(); }
      }

      const nameEl = displayRow.querySelector('.product-name');
      if (nameEl) nameEl.textContent = name;

      let descEl = displayRow.querySelector('.product-desc');
      if (description) {
        if (!descEl) { descEl = document.createElement('span'); descEl.className = 'product-desc'; nameEl?.after(descEl); }
        descEl.textContent = description;
      } else { descEl?.remove(); }

      const cells = displayRow.querySelectorAll('td');
      if (cells[1]) cells[1].textContent = fmtPrice(price);
      if (cells[2]) cells[2].textContent = stock;

      displayRow.dataset.sortName = name.toLowerCase();
      displayRow.dataset.sortPrice = String(price);
      displayRow.dataset.sortStock = stock;
    }
    if (editRow) editRow.hidden = true;
    if (displayRow) displayRow.hidden = false;
    showStatus('Product updated.');
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
    const submitBtn = addForm.querySelector<HTMLButtonElement>('[type="submit"]');
    const origText = submitBtn?.textContent ?? 'Add product';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

    try {
      const gallery = addForm.querySelector<Element>('.gallery-widget');
      try {
        if (gallery) await resolveGalleryUrls(gallery, cloud, preset);
      } catch {
        showStatus('Image upload failed. Please try again.', true);
        return;
      }

      const fd = new FormData(addForm);
      const res = await fetch('/api/product', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; product?: ProductData; error?: string };
      if (!data.ok) { showStatus(data.error ?? 'Error adding product.', true); return; }

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
      }

      addForm.reset();
      if (gallery) resetGallery(gallery);
      addFormWrap?.setAttribute('hidden', '');
      document.getElementById('toggle-add-form')?.removeAttribute('hidden');
      showStatus('Product added.');
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
    const productName = row?.querySelector('.product-name')?.textContent ?? 'this product';

    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: 'Delete product?',
        message: `"${productName}" will be permanently deleted.`,
        okLabel: 'Delete',
        onConfirm: async () => {
          const fd = new FormData();
          fd.set('_action', 'delete-product');
          fd.set('productId', productId);
          fd.set('storeId', storeId);
          const res = await fetch('/api/product', { method: 'POST', body: fd });
          const data = await res.json() as { ok: boolean; error?: string };
          if (!data.ok) { showStatus(data.error ?? 'Error deleting.', true); return; }

          document.querySelector(`[data-product-display="${productId}"]`)?.remove();
          document.querySelector(`[data-product-edit="${productId}"]`)?.remove();

          const tbody = document.getElementById('products-tbody');
          if (tbody && tbody.querySelectorAll('[data-product-display]').length === 0) {
            document.getElementById('products-table')?.setAttribute('hidden', '');
            document.getElementById('empty-products')?.removeAttribute('hidden');
          }
          showStatus('Product deleted.');
        },
      },
    }));
  });
}

export function initTableSort(): void {
  let sortCol = '';
  let sortDir = 'asc';

  function sortTable(col: string) {
    sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    sortCol = col;

    const tbody = document.getElementById('products-tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('[data-product-display]'));
    rows.sort((a, b) => {
      let va: string | number = '';
      let vb: string | number = '';
      if (col === 'name')  { va = a.dataset.sortName  ?? ''; vb = b.dataset.sortName  ?? ''; }
      if (col === 'price') { va = parseFloat(a.dataset.sortPrice ?? '0'); vb = parseFloat(b.dataset.sortPrice ?? '0'); }
      if (col === 'stock') { va = parseInt(a.dataset.sortStock  ?? '0', 10); vb = parseInt(b.dataset.sortStock  ?? '0', 10); }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    for (const display of rows) {
      const edit = tbody.querySelector<HTMLTableRowElement>(`[data-product-edit="${display.dataset.productDisplay}"]`);
      tbody.append(display);
      if (edit) tbody.append(edit);
    }

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
