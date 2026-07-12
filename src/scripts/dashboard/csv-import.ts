import { esc } from '../../lib/gallery-widget.js';
import { showStatus } from './status.js';
import { buildRows, attachListeners, initThumbs, applyPagination, type ProductData } from './products.js';
import { templateCsv, type BulkRowResult } from '../../lib/csv-bulk.js';
import { csvErrorMessage, buildPreviewHtml } from './csv-preview.js';

function getDashI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initCsvImport(cloud: string, preset: string): void {
  const panel       = document.getElementById('csv-panel') as HTMLElement | null;
  const toggleBtn   = document.getElementById('toggle-csv-panel');
  const closeBtn    = document.getElementById('csv-panel-close');
  const templateBtn = document.getElementById('csv-template-btn');
  const fileInput   = document.getElementById('csv-file-input') as HTMLInputElement | null;
  const fileNameEl  = document.getElementById('csv-file-name');
  const previewEl   = document.getElementById('csv-preview') as HTMLElement | null;
  const storeId     = panel?.dataset.storeId ?? '';
  const i = getDashI18n();

  if (!panel || !fileInput || !previewEl) return;
  const panelEl = panel;
  let pendingCsv = '';

  // Always the same fixed sample regardless of the store's own catalog — a brand-new seller
  // with zero products still gets a concrete example of the expected format (export alone
  // would just give them a bare header row when there's nothing to export yet).
  templateBtn?.addEventListener('click', () => {
    const lang = document.documentElement.dir === 'rtl' ? 'he' : 'en';
    const blob = new Blob([templateCsv(lang)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'products-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  toggleBtn?.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      document.getElementById('add-product-form')?.setAttribute('hidden', '');
      document.getElementById('toggle-add-form')?.removeAttribute('hidden');
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  closeBtn?.addEventListener('click', () => { panel.hidden = true; });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (fileNameEl) fileNameEl.textContent = file.name;
    pendingCsv = await file.text();
    fileInput.value = '';
    await runPreview();
  });

  async function runPreview(): Promise<void> {
    if (!pendingCsv) return;
    previewEl!.hidden = false;
    previewEl!.innerHTML = `<span class="dot-pulse" role="status" aria-label="loading"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span>`;
    try {
      const res = await fetch('/api/store-product/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, csv: pendingCsv, commit: false }),
      });
      const data = await res.json() as { ok: boolean; results?: Array<BulkRowResult & { currentName?: string }>; error?: string };
      if (!data.ok) {
        previewEl!.innerHTML = `<p class="csv-error">${esc(csvErrorMessage(i, data.error))}</p>`;
        return;
      }
      renderPreview(data.results ?? []);
    } catch {
      previewEl!.innerHTML = `<p class="csv-error">${esc(i.csvImportFailed ?? 'Import failed.')}</p>`;
    }
  }

  function renderPreview(results: Array<BulkRowResult & { currentName?: string }>): void {
    previewEl!.innerHTML = buildPreviewHtml(results, i);

    document.getElementById('csv-cancel-btn')?.addEventListener('click', () => {
      previewEl!.hidden = true;
      previewEl!.innerHTML = '';
      pendingCsv = '';
    });

    document.getElementById('csv-confirm-btn')?.addEventListener('click', (e) => commitImport(e.currentTarget as HTMLButtonElement));
  }

  async function commitImport(btn: HTMLButtonElement): Promise<void> {
    const cancelBtn = document.getElementById('csv-cancel-btn') as HTMLButtonElement | null;
    btn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = i.csvImporting ?? 'Importing...';

    try {
      const res = await fetch('/api/store-product/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, csv: pendingCsv, commit: true }),
      });
      const data = await res.json() as { ok: boolean; results?: Array<BulkRowResult & { product?: ProductData }> };
      if (!data.ok) { showStatus(i.csvImportFailed ?? 'Import failed.', true); return; }

      applyResults(data.results ?? []);
      previewEl!.hidden = true;
      previewEl!.innerHTML = '';
      panelEl.hidden = true;
      pendingCsv = '';
      if (fileNameEl) fileNameEl.textContent = '';
      showStatus(i.csvImportDone ?? 'Import complete.');
    } catch {
      showStatus(i.csvImportFailed ?? 'Import failed.', true);
    } finally {
      btn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      btn.textContent = origLabel;
    }
  }

  function applyResults(results: Array<BulkRowResult & { product?: ProductData }>): void {
    const tbody    = document.getElementById('products-tbody') as HTMLTableSectionElement | null;
    const table    = document.getElementById('products-table') as HTMLTableElement | null;
    const emptyMsg = document.getElementById('empty-products');
    if (!tbody) return;

    // Build id → element maps once instead of a querySelector per updated row —
    // matters once a batch touches hundreds of existing rows in a large table.
    const displayById = new Map<string, Element>();
    const editById = new Map<string, Element>();
    tbody.querySelectorAll<HTMLElement>('[data-product-display]').forEach((el) => {
      displayById.set(el.dataset.productDisplay ?? '', el);
    });
    tbody.querySelectorAll<HTMLElement>('[data-product-edit]').forEach((el) => {
      editById.set(el.dataset.productEdit ?? '', el);
    });

    for (const r of results) {
      if (r.action === 'error' || !r.product) continue;
      const [display, edit] = buildRows(r.product);
      attachListeners(display, edit, cloud, preset);

      const oldDisplay = r.action === 'update' ? displayById.get(r.id ?? '') : undefined;
      const oldEdit     = r.action === 'update' ? editById.get(r.id ?? '') : undefined;
      if (oldDisplay && oldEdit) {
        oldDisplay.replaceWith(display);
        oldEdit.replaceWith(edit);
      } else {
        tbody.prepend(display, edit);
      }
      initThumbs(display);
    }

    if (table) table.hidden = false;
    if (emptyMsg) emptyMsg.hidden = true;
    applyPagination();
  }
}
