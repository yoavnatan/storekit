/**
 * Bulk-selection state for the seller's products table.
 *
 * Kept outside `initBulkSelect`'s closure because every toolbar control
 * (filter / sort / search / page size / prev-next) rebuilds the tbody from
 * scratch through `applyPagination()`. The rebuilt checkboxes come back
 * unticked, so a live selection appeared to cancel itself the moment the
 * seller filtered — while the toolbar count, which read its own state and not
 * the DOM, kept showing the old number and bulk delete still targeted rows
 * nobody could see.
 *
 * Two layers, deliberately:
 * - **What counts and what acts** is always the ticked rows the table renders
 *   right now (`selectedRowIds`). Filter to one category and the count drops
 *   to that category's share of the selection; nothing is ever deleted,
 *   discounted or edited outside what the seller can see.
 * - **Memory** (`selected`) outlives the rows so the ids a filter hid come
 *   back ticked when the filter is cleared, instead of being silently dropped.
 *
 * "Select all" is a mode, not a one-off click: while it is armed, every row
 * the table renders next joins the selection — filter, and the whole filtered
 * result is selected, exactly like the box promises. Unticking a single row
 * disarms it (the box no longer tells the truth), and unticking the box itself
 * clears the selection, hidden ids included.
 */

const selected = new Set<string>();
let selectAllArmed = false;
let notify: () => void = () => {};

/** Registered by initBulkSelect so a sync refreshes the toolbar (count, action buttons). */
export function onBulkSelectionChange(fn: () => void): void {
  notify = fn;
}

/** The selection as the seller sees it: ticked AND currently rendered. */
export function selectedRowIds(root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('[data-bulk-check]:checked'))
    .map((box) => box.dataset.bulkCheck ?? '')
    .filter(Boolean);
}

export function setBulkSelected(id: string, on: boolean): void {
  if (on) selected.add(id);
  else selected.delete(id);
}

export function isSelectAllArmed(): boolean {
  return selectAllArmed;
}

/** Arms "select all" — the caller then syncs, which pulls in every rendered row. */
export function armSelectAll(): void {
  selectAllArmed = true;
}

/** Drops the mode but keeps the selection — for when one row is unticked by hand. */
export function disarmSelectAll(): void {
  selectAllArmed = false;
}

export function clearBulkSelection(): void {
  selectAllArmed = false;
  selected.clear();
}

/**
 * Re-applies the selection to freshly rendered checkboxes: while "select all"
 * is armed every rendered row joins the selection first, so a filter change
 * selects its whole result. Call after any rebuild of the products tbody.
 */
export function syncBulkSelectionToRows(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('[data-bulk-check]').forEach((box) => {
    const id = box.dataset.bulkCheck ?? '';
    if (selectAllArmed && id) selected.add(id);
    box.checked = selected.has(id);
  });
  notify();
}
