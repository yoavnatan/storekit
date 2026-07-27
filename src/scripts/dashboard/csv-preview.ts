import { esc } from '../../lib/gallery-widget.js';
import type { MergedRowResult } from '../../lib/variant-csv.js';

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
    case 'variant-missing-option': return i.csvErrVariantMissingOption ?? 'A grouped row is missing an option name or value';
    case 'variant-inconsistent-dimensions': return i.csvErrVariantInconsistent ?? 'Rows in the group declare different variant dimensions';
    case 'variant-duplicate-combo': return i.csvErrVariantDuplicateCombo ?? 'Two rows in the group have the same option combination';
    case 'variant-group-mixed-id': return i.csvErrVariantMixedId ?? 'Rows in the group point at different products (id)';
    default: return code;
  }
}

/** "Line 5" for a plain product, "Lines 5–7" for a variant group (its whole row span). */
function lineLabel(i: Record<string, string>, lines: number[]): string {
  const single = i.csvLine ?? 'Line';
  if (lines.length <= 1) return `${single} ${lines[0] ?? ''}`;
  return `${i.csvLines ?? single} ${lines[0]}–${lines[lines.length - 1]}`;
}

const CHIP_BASE = 'text-[0.82rem] font-semibold px-[0.6rem] py-[0.3rem] rounded-[var(--radius-sm)] border bg-[color:var(--color-surface)] w-fit';

/** Builds the preview as one clearly separated card: a titled review box with a summary-chip row,
 *  then only the rows that need the seller's eyes — updates that actually change a product (shown as
 *  current→new name so they can confirm the internal id/sku resolved to the right product) and error
 *  rows. Rows identical to the existing product ("unchanged") are never listed — a re-uploaded catalog
 *  or a sku+stock feed is mostly no-ops; they only appear as a summary count and are skipped on commit.
 *  A variant group shows as one entry with a "N variants" badge. Caller wires the confirm/cancel. */
export function buildPreviewHtml(results: Array<MergedRowResult>, i: Record<string, string>): string {
  const creates   = results.filter((r) => r.action === 'create');
  const updates   = results.filter((r) => r.action === 'update' && !r.unchanged);
  const unchanged = results.filter((r) => r.action === 'update' && r.unchanged);
  const errors    = results.filter((r) => r.action === 'error');
  const hasWork = creates.length + updates.length > 0;

  const variantBadge = (r: MergedRowResult): string =>
    r.variantCount ? ` <span class="csv-row__variants [color:var(--color-muted)]">(${r.variantCount} ${esc(i.csvVariants ?? 'variants')})</span>` : '';

  const chip = (n: number, label: string, colorVar: string): string =>
    `<span class="csv-summary__item ${CHIP_BASE} [border-color:var(${colorVar})] [color:var(${colorVar})]">${n} ${esc(label)}</span>`;

  const errorRows = errors.map((r) => `
    <div class="csv-row csv-row--error flex flex-col gap-[0.15rem] border [border-color:var(--color-danger)] rounded-[var(--radius-sm)] px-[0.6rem] py-[0.45rem] bg-[color:var(--color-surface)] text-[0.8rem]">
      <span class="csv-row__line font-semibold [color:var(--color-muted)]">${esc(lineLabel(i, r.lines))}</span>
      <span class="csv-row__msg [color:var(--color-danger)]">${esc(r.errors.map((e) => rowErrorLabel(i, e)).join(', '))}</span>
    </div>`).join('');

  // RTL reads right-to-left, so "current becomes new" must point LEFT (←); an LTR page keeps →.
  const arrow = document.documentElement.dir === 'rtl' ? '←' : '→';

  // The id/sku column resolves to an internal product the seller can't eyeball — showing which real
  // product each row updates (and the name it'll become, if changed) lets them catch a wrong match.
  const updateRows = updates.map((r) => {
    const newName = r.input?.name;
    const renamed = newName && newName !== r.currentName;
    // A variant product where only some combos changed: point at those exact rows + which variant,
    // so "edited one variant" reads as one line — not the whole product's span with an "(N variants)".
    const cc = r.changedCombos;
    if (cc && cc.length) {
      const lineText = cc.length === 1
        ? lineLabel(i, [cc[0]!.line])
        : `${i.csvLines ?? i.csvLine ?? 'Lines'} ${cc.map((c) => c.line).join(', ')}`;
      const labels = cc.map((c) => c.label).filter(Boolean).join(', ');
      return `
    <div class="csv-row csv-row--update [border-color:var(--color-border)]">
      <span class="csv-row__line font-semibold [color:var(--color-muted)]">${esc(lineText)}</span>
      <span class="csv-row__msg [color:var(--color-text)]">${esc(r.currentName ?? '')}${labels ? ` — ${esc(labels)}` : ''}</span>
    </div>`;
    }
    return `
    <div class="csv-row csv-row--update [border-color:var(--color-border)]">
      <span class="csv-row__line font-semibold [color:var(--color-muted)]">${esc(lineLabel(i, r.lines))}</span>
      <span class="csv-row__msg [color:var(--color-text)]">${esc(r.currentName ?? '')}${renamed ? ` ${arrow} ${esc(newName!)}` : ''}${variantBadge(r)}</span>
    </div>`;
  }).join('');

  const section = (title: string, body: string, listClass = ''): string => body ? `
    <div class="csv-preview__section mt-[0.9rem]">
      <h5 class="csv-preview__section-title text-[0.78rem] font-semibold uppercase tracking-[0.04em] [color:var(--color-muted)] mb-[0.4rem]">${esc(title)}</h5>
      <div class="csv-error-list ${listClass} flex flex-col gap-[0.4rem] max-h-[220px] overflow-y-auto pe-[0.25rem]">${body}</div>
    </div>` : '';

  return `
    <section class="csv-preview__card border [border-color:var(--color-border)] rounded-[var(--radius)] p-[0.85rem] bg-[color:var(--color-surface)]">
      <h4 class="csv-preview__title text-[0.9rem] font-semibold [color:var(--color-text)] mb-[0.6rem]">${esc(i.csvPreviewTitle ?? 'Review before import')}</h4>
      <div class="csv-summary flex flex-col gap-[0.4rem] sm:flex-row sm:flex-wrap sm:gap-[0.6rem]">
        ${chip(creates.length, i.csvRowsToCreate ?? 'New products', '--color-success')}
        ${chip(updates.length, i.csvRowsToUpdate ?? 'Products to update', '--color-text')}
        ${unchanged.length ? chip(unchanged.length, i.csvRowsUnchanged ?? 'Unchanged', '--color-muted') : ''}
        ${errors.length ? chip(errors.length, i.csvRowsError ?? 'Rows with errors', '--color-danger') : ''}
      </div>
      ${!hasWork && !errors.length ? `<p class="csv-panel__hint muted mt-[0.7rem]">${esc(i.csvNothingToImport ?? 'Nothing to import — everything is already up to date.')}</p>` : ''}
      ${section(i.csvRowsToUpdate ?? 'Products to update', updateRows, 'csv-update-list')}
      ${section(i.csvRowsError ?? 'Rows with errors', errorRows)}
      ${unchanged.length ? `<p class="csv-preview__note muted text-[0.78rem] mt-[0.7rem]">${esc(i.csvUnchangedNote ?? 'Rows identical to the existing product are skipped.')}</p>` : ''}
      <div class="csv-panel__confirm flex flex-col gap-2 sm:flex-row mt-[0.9rem]">
        <button type="button" class="btn btn--sm w-full sm:w-auto" id="csv-confirm-btn" ${hasWork ? '' : 'disabled'}>${esc(i.csvConfirmImport ?? 'Confirm import')}</button>
        <button type="button" class="btn btn--ghost btn--sm w-full sm:w-auto" id="csv-cancel-btn">${esc(i.csvCancelImport ?? 'Cancel')}</button>
      </div>
    </section>`;
}
