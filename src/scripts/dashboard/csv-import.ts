import { esc } from '../../lib/gallery-widget.js';
import { showStatus } from './status.js';
import { scrollProductsPanelIntoView } from './scroll-utils.js';
import { applyPagination, type ProductData } from './products.js';
import { templateCsv } from '../../lib/csv-bulk.js';
import type { MergedRowResult } from '../../lib/variant-csv.js';
import { csvErrorMessage, buildPreviewHtml } from './csv-preview.js';

function getDashI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initCsvImport(): void {
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
      document.getElementById('feed-panel')?.setAttribute('hidden', '');
      scrollProductsPanelIntoView(panelEl);
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
      const data = await res.json() as { ok: boolean; results?: Array<MergedRowResult>; error?: string };
      if (!data.ok) {
        previewEl!.innerHTML = `<p class="csv-error [color:var(--color-danger)] text-[0.85rem]">${esc(csvErrorMessage(i, data.error))}</p>`;
        return;
      }
      renderPreview(data.results ?? []);
    } catch {
      previewEl!.innerHTML = `<p class="csv-error [color:var(--color-danger)] text-[0.85rem]">${esc(i.csvImportFailed ?? 'Import failed.')}</p>`;
    }
  }

  function renderPreview(results: Array<MergedRowResult>): void {
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
      const data = await res.json() as { ok: boolean; results?: Array<MergedRowResult & { product?: ProductData }> };
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

  function applyResults(results: Array<MergedRowResult & { product?: ProductData }>): void {
    // A CSV batch can touch products scattered across many server pages, so
    // patching individual DOM rows in place (the pre-pagination approach) no
    // longer makes sense — just re-fetch whatever page/search/sort/filter
    // the seller currently has open.
    if (!results.some((r) => r.action !== 'error')) return;
    applyPagination();
  }
}
