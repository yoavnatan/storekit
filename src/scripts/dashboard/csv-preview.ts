import { esc } from '../../lib/gallery-widget.js';
import type { BulkRowResult } from '../../lib/csv-bulk.js';

export function csvErrorMessage(i: Record<string, string>, error?: string): string {
  if (error === 'missing-columns') return i.csvMissingColumns ?? 'Missing required columns.';
  if (error === 'empty-file') return i.csvEmptyFile ?? 'The file is empty.';
  if (error === 'too-many-rows') return i.csvTooManyRows ?? 'The file has too many rows.';
  return i.csvImportFailed ?? 'Import failed.';
}

function rowErrorLabel(i: Record<string, string>, code: string): string {
  switch (code) {
    case 'id-not-found':   return i.csvErrIdNotFound ?? 'ID not found';
    case 'name-required':  return i.csvErrNameRequired ?? 'Name missing';
    case 'price-invalid':  return i.csvErrPriceInvalid ?? 'Invalid price';
    case 'stock-invalid':  return i.csvErrStockInvalid ?? 'Invalid stock';
    case 'sku-duplicate':  return i.csvErrSkuDuplicate ?? 'SKU already used by another product';
    case 'category-orphan-subcategory': return i.csvErrCategoryOrphan ?? 'A subcategory column is filled in without the category level above it';
    case 'spam-keyword': return i.csvErrSpamKeyword ?? 'The text contains a term flagged as spam';
    case 'keyword-stuffing': return i.csvErrKeywordStuffing ?? 'A word repeats far more than natural writing (keyword stuffing)';
    default: return code;
  }
}

/** Builds the whole preview panel's innerHTML (summary counts, per-row error list, and — for
 *  updates — the current→new product name so a seller can visually confirm the internal id
 *  column resolved to the right product before committing). Caller still owns wiring the
 *  confirm/cancel button listeners, since those need callbacks this pure function shouldn't. */
export function buildPreviewHtml(results: Array<BulkRowResult & { currentName?: string }>, i: Record<string, string>): string {
  const creates = results.filter((r) => r.action === 'create');
  const updates = results.filter((r) => r.action === 'update');
  const errors  = results.filter((r) => r.action === 'error');

  const errorRows = errors.map((r) => `
    <div class="csv-row csv-row--error flex flex-col gap-[0.15rem] border [border-color:var(--color-danger)] rounded-[0.4rem] px-[0.6rem] py-[0.45rem] bg-[color:var(--color-surface)] text-[0.8rem]">
      <span class="csv-row__line font-semibold [color:var(--color-muted)]">${esc(i.csvLine ?? 'Line')} ${r.line}</span>
      <span class="csv-row__msg [color:var(--color-danger)]">${esc(r.errors.map((e) => rowErrorLabel(i, e)).join(', '))}</span>
    </div>`).join('');

  // The id column is an internal UUID the seller has no reason to trust blindly — showing
  // which real product each update row currently resolves to (and the name it'll become, if
  // changed) lets them visually catch a scrambled/wrong row before anything is written. A
  // plain CSV can't protect this any other way (no cell-locking in the format).
  const updateRows = updates.map((r) => {
    const newName = r.input?.name;
    const changed = newName && newName !== r.currentName;
    return `
    <div class="csv-row csv-row--update [border-color:var(--color-border)]">
      <span class="csv-row__line font-semibold [color:var(--color-muted)]">${esc(i.csvLine ?? 'Line')} ${r.line}</span>
      <span class="csv-row__msg [color:var(--color-text)]">${esc(r.currentName ?? '')}${changed ? ` → ${esc(newName!)}` : ''}</span>
    </div>`;
  }).join('');

  return `
    <div class="csv-summary flex flex-col gap-[0.4rem] mb-[0.65rem] sm:flex-row sm:flex-wrap sm:gap-[0.6rem]">
      <span class="csv-summary__item csv-summary__item--create text-[0.82rem] font-semibold px-[0.6rem] py-[0.3rem] rounded-[0.4rem] border [border-color:var(--color-success)] bg-[color:var(--color-surface)] w-fit [color:var(--color-success)]">${creates.length} ${esc(i.csvRowsToCreate ?? 'New products')}</span>
      <span class="csv-summary__item csv-summary__item--update text-[0.82rem] font-semibold px-[0.6rem] py-[0.3rem] rounded-[0.4rem] border [border-color:var(--color-border)] bg-[color:var(--color-surface)] w-fit [color:var(--color-text)]">${updates.length} ${esc(i.csvRowsToUpdate ?? 'Products to update')}</span>
      ${errors.length ? `<span class="csv-summary__item csv-summary__item--error text-[0.82rem] font-semibold px-[0.6rem] py-[0.3rem] rounded-[0.4rem] border [border-color:var(--color-danger)] bg-[color:var(--color-surface)] w-fit [color:var(--color-danger)]">${errors.length} ${esc(i.csvRowsError ?? 'Rows with errors')}</span>` : ''}
    </div>
    ${updateRows ? `<p class="csv-panel__hint muted">${esc(i.csvConfirmUpdates ?? 'Confirm these are the right products before importing:')}</p><div class="csv-error-list csv-update-list flex flex-col gap-[0.4rem] max-h-[220px] overflow-y-auto mb-2 pe-[0.25rem]">${updateRows}</div>` : ''}
    ${errorRows ? `<div class="csv-error-list flex flex-col gap-[0.4rem] max-h-[220px] overflow-y-auto mb-3 pe-[0.25rem]">${errorRows}</div>` : ''}
    <div class="csv-panel__confirm flex flex-col gap-2 sm:flex-row">
      <button type="button" class="btn btn--sm w-full sm:w-auto" id="csv-confirm-btn" ${creates.length + updates.length === 0 ? 'disabled' : ''}>${esc(i.csvConfirmImport ?? 'Confirm import')}</button>
      <button type="button" class="btn btn--ghost btn--sm w-full sm:w-auto" id="csv-cancel-btn">${esc(i.csvCancelImport ?? 'Cancel')}</button>
    </div>`;
}
