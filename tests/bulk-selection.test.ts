// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSelectAll,
  clearBulkSelection,
  disarmSelectAll,
  isSelectAllArmed,
  onBulkSelectionChange,
  selectedRowIds,
  setBulkSelected,
  syncBulkSelectionToRows,
} from '../src/scripts/dashboard/bulk-selection.js';

/** Rebuilds the products tbody the way applyPagination() does — fresh, unticked checkboxes. */
function renderRows(ids: string[]): void {
  document.body.innerHTML = ids
    .map((id) => `<input type="checkbox" data-bulk-check="${id}">`)
    .join('');
}

beforeEach(() => {
  clearBulkSelection();
  onBulkSelectionChange(() => {});
  document.body.innerHTML = '';
});

describe('the count follows the view', () => {
  it('drops to the selected rows the filter left on screen', () => {
    renderRows(['a', 'b', 'c']);
    ['a', 'b', 'c'].forEach((id) => setBulkSelected(id, true));

    renderRows(['a', 'c']); // filtered — 'b' is out of this view
    syncBulkSelectionToRows();

    expect(selectedRowIds()).toEqual(['a', 'c']);
  });

  it('counts nothing when the filter leaves none of the selection on screen', () => {
    renderRows(['a', 'b']);
    ['a', 'b'].forEach((id) => setBulkSelected(id, true));

    renderRows(['z']);
    syncBulkSelectionToRows();

    expect(selectedRowIds()).toEqual([]);
  });

  it('brings the hidden rows back ticked once the filter is cleared', () => {
    renderRows(['a', 'b', 'c']);
    ['a', 'b', 'c'].forEach((id) => setBulkSelected(id, true));

    renderRows(['a']);           // filter on
    syncBulkSelectionToRows();
    renderRows(['a', 'b', 'c']); // filter cleared
    syncBulkSelectionToRows();

    expect(selectedRowIds()).toEqual(['a', 'b', 'c']);
  });

  it('leaves an empty selection empty', () => {
    renderRows(['a', 'b']);
    syncBulkSelectionToRows();

    expect(selectedRowIds()).toEqual([]);
  });

  it('notifies the toolbar so the count follows a sync', () => {
    const notify = vi.fn();
    onBulkSelectionChange(notify);
    renderRows(['a']);
    syncBulkSelectionToRows();

    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('select-all is a mode, not a one-off click', () => {
  it('selects the whole filtered result while it stays armed', () => {
    renderRows(['a', 'b']);
    armSelectAll();
    syncBulkSelectionToRows();

    renderRows(['c', 'd']); // a different filter
    syncBulkSelectionToRows();
    expect(selectedRowIds()).toEqual(['c', 'd']);

    renderRows(['a', 'b', 'c', 'd']); // filter cleared — both rounds are still selected
    syncBulkSelectionToRows();
    expect(selectedRowIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('stops pulling in new rows once disarmed, keeping what was already picked', () => {
    renderRows(['a', 'b']);
    armSelectAll();
    syncBulkSelectionToRows();

    disarmSelectAll();          // seller unticked one row by hand
    setBulkSelected('b', false);
    renderRows(['c', 'd']);
    syncBulkSelectionToRows();
    expect(selectedRowIds()).toEqual([]);

    renderRows(['a', 'b', 'c', 'd']);
    syncBulkSelectionToRows();
    expect(selectedRowIds()).toEqual(['a']);
    expect(isSelectAllArmed()).toBe(false);
  });

  it('clears everything, including rows the filter hides', () => {
    renderRows(['a', 'b']);
    armSelectAll();
    syncBulkSelectionToRows();
    renderRows(['a']);
    syncBulkSelectionToRows();

    clearBulkSelection();
    renderRows(['a', 'b']);
    syncBulkSelectionToRows();

    expect(selectedRowIds()).toEqual([]);
    expect(isSelectAllArmed()).toBe(false);
  });
});
