// @vitest-environment jsdom
/**
 * Two answers to the same question the seller keeps asking of the Products table: *what is open,
 * and what is waiting?*
 *
 * **The marks** (owner, 2026-08-20: *"אז אחד אחד עוברים עליהם?"*). The floating notice can name one
 * product with a waiting draft, so several of them meant one round each with no way to see how many
 * there were. Opening them all was the alternative he proposed and it was MEASURED rather than
 * argued: twenty editors is ~950ms of frozen page on a laptop, a document 42 screens tall, and
 * twenty bars still to answer — it front-loads the wait without saving any of the work. A mark on
 * each row costs nothing, shows all of them at once, and opens exactly one when pressed.
 *
 * **Close editing** (owner, same day, and the answer is the opposite of the first attempt). A row
 * opened from its own "ערוך" menu survives a press of the toolbar's "סגור עריכה", which reads as a
 * contradiction. Making that button global was tried and rejected on sight: *"מה קורה אם הוא לוחץ
 * מחק? מה קורה אם הוא לוחץ על עריכת תמונות? אתה עושה פה סלט."* The bar exists only while something
 * is ticked, it counts what is ticked, and מחק / עריכת תמונות / הנחה all act on that set — one
 * button in it with a wider reach is a second rule nobody can see. So the toolbar means the
 * SELECTION, and a row the seller opened himself is closed by its own "ביטול".
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearBulkSelection, syncBulkSelectionToRows } from '../src/scripts/dashboard/bulk-selection.js';
import { bindExistingRows, initBulkSelect, initDraftMarks, markDraftRows } from '../src/scripts/dashboard/products.js';

/** jsdom ships neither, and products.ts uses both — restoring the environment, not bending the code. */
(globalThis as { CSS?: { escape(v: string): string } }).CSS ??= {
  escape: (value: string) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`),
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const IDS = ['p1', 'p2', 'p3'];

function renderTab(): void {
  const island = IDS.map((id) => ({
    id, storeId: 's1', name: id, description: '', price: 10, stock: 5, images: [], rev: 'r1',
  }));
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{"draftRowMark":"יש שינויים שלא הספקת לשמור"},"gallery":{}}</script>
    <script type="application/json" id="dash-products-page">${JSON.stringify(island)}</script>
    <div id="upload-config" data-store-id="s1"></div>
    <div class="products-header">
      <input type="checkbox" class="bulk-select-all">
      <span id="bulk-count-badge" hidden><span id="bulk-count">0</span></span>
      <span id="bulk-sep" hidden></span>
      <button id="bulk-delete-btn" hidden type="button"></button>
      <button id="bulk-edit-btn" hidden type="button"><span id="bulk-edit-label"></span></button>
      <button id="bulk-discount-btn" hidden type="button"></button>
      <button id="bulk-upload-btn" hidden type="button"><span id="bulk-upload-label"></span></button>
      <span id="bulk-count-paren"></span>
    </div>
    <div id="bulk-upload-panel" hidden></div>
    <table><tbody id="products-tbody">
      ${IDS.map((id) => `
        <tr data-product-display="${id}">
          <td class="row-num">1</td>
          <td class="thumb-col"></td>
          <td class="name-col"><span class="product-name">${id}</span></td>
          <td><input type="checkbox" data-bulk-check="${id}"></td>
          <td><button type="button" data-edit-toggle="${id}"></button></td>
        </tr>
        <tr class="edit-row" data-product-edit="${id}" data-edit-pending hidden></tr>`).join('')}
    </tbody></table>`;
}

const marks = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('[data-draft-mark]'))
  .map((el) => el.dataset.draftMark ?? '');
const editRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-product-edit="${id}"]`)!;
const displayRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-product-display="${id}"]`)!;
const isOpen = (id: string): boolean => !editRow(id).hidden;
const bulkEditBtn = (): HTMLButtonElement => document.getElementById('bulk-edit-btn') as HTMLButtonElement;
const bulkEditLabel = (): string => document.getElementById('bulk-edit-label')!.textContent ?? '';

function tick(id: string, on = true): void {
  const chk = document.querySelector<HTMLInputElement>(`[data-bulk-check="${id}"]`)!;
  chk.checked = on;
  chk.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The row menu's own "ערוך" — the entry point the toolbar used to be blind to. */
function openFromRowMenu(id: string): void {
  document.querySelector<HTMLButtonElement>(`[data-edit-toggle="${id}"]`)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

let tbodyHtml = '';
let waiting: string[] = [];

// Both of these register DELEGATED listeners on `document` and nothing removes them, so they run
// once for the whole file — the same reason `bulk-image-panel-lock.test.ts` gives. Only the tbody is
// rebuilt between tests, which is also what a real filter/page change does.
beforeAll(() => {
  renderTab();
  tbodyHtml = document.getElementById('products-tbody')!.innerHTML;
  window.__dashDraftProducts = (): string[] => waiting;
  initBulkSelect('demo-cloud', 'demo-preset');
  initDraftMarks();
});

beforeEach(() => {
  waiting = [];
  document.getElementById('products-tbody')!.innerHTML = tbodyHtml;
  document.querySelectorAll<HTMLElement>('[data-product-edit]').forEach((r) => { r.hidden = true; });
  document.querySelectorAll<HTMLElement>('[data-product-display]').forEach((r) => { r.hidden = false; });
  clearBulkSelection();
  bindExistingRows('demo-cloud', 'demo-preset');
  syncBulkSelectionToRows(document.getElementById('products-tbody')!);
  markDraftRows();
});

describe('the rows say which products have work waiting', () => {
  it('marks every waiting product at once, and nothing else', () => {
    waiting = ['p1', 'p3'];
    markDraftRows();
    expect(marks()).toEqual(['p1', 'p3']);
  });

  it('puts the mark in the row the seller reads, beside the name', () => {
    waiting = ['p2'];
    markDraftRows();
    const mark = document.querySelector<HTMLElement>('[data-draft-mark]')!;
    expect(mark.previousElementSibling?.className).toContain('product-name');
    expect(mark.closest('[data-product-display]')?.getAttribute('data-product-display')).toBe('p2');
    // A control, not a decoration: the only thing to do about it is open that row, and an icon with
    // no way in would leave the seller hunting for one.
    expect(mark.tagName).toBe('BUTTON');
    expect(mark.getAttribute('aria-label')).toBe('יש שינויים שלא הספקת לשמור');
  });

  it('opens that product when pressed', () => {
    waiting = ['p2'];
    markDraftRows();
    document.querySelector<HTMLElement>('[data-draft-mark]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isOpen('p2')).toBe(true);
    expect(displayRow('p2').hidden).toBe(true);
  });

  it('takes the mark away once that draft is no longer waiting', () => {
    waiting = ['p1', 'p2'];
    markDraftRows();
    // The row arrived, so the guard pruned it — the mark has to go in the same breath, or it points
    // at an offer the form itself is now making.
    waiting = ['p2'];
    markDraftRows();
    expect(marks()).toEqual(['p2']);
  });

  it('draws them again after the table rebuilds its rows', () => {
    // A filter, a sort or a page change replaces every row, and the marks are localStorage's state:
    // nothing in the rebuilt markup knows about them.
    waiting = ['p3'];
    markDraftRows();
    expect(marks()).toEqual(['p3']);
    document.getElementById('products-tbody')!.innerHTML = tbodyHtml;
    expect(marks()).toEqual([]);
    markDraftRows();
    expect(marks()).toEqual(['p3']);
  });

  it('adds one mark per row however often it runs', () => {
    waiting = ['p1'];
    markDraftRows();
    markDraftRows();
    markDraftRows();
    expect(marks()).toEqual(['p1']);
  });
});

describe('the toolbar means the selection, every button of it', () => {
  it('opens and closes exactly the ticked products, and leaves an unrelated editor alone', () => {
    // Exactly the seller's sequence: edit one product from its menu, then tick some others.
    openFromRowMenu('p1');
    tick('p2');
    tick('p3');
    expect(isOpen('p1')).toBe(true);
    expect(bulkEditLabel()).toBe('ערוך');

    bulkEditBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect([isOpen('p2'), isOpen('p3')]).toEqual([true, true]);
    expect(bulkEditLabel()).toBe('סגור עריכה');

    bulkEditBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // p1 is the seller's own editing session and none of the toolbar's business — מחק and
    // עריכת תמונות do not touch it either, and one button reaching wider than the count beside it
    // is the "salad" this was rejected for.
    expect([isOpen('p1'), isOpen('p2'), isOpen('p3')]).toEqual([true, false, false]);
    expect([displayRow('p2').hidden, displayRow('p3').hidden]).toEqual([false, false]);
  });

  it('opens only what was picked', () => {
    tick('p2');
    bulkEditBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect([isOpen('p1'), isOpen('p2'), isOpen('p3')]).toEqual([false, true, false]);
  });

  it('keeps what he typed — closing hides the row, it does not rebuild it', () => {
    tick('p1');
    bulkEditBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const row = editRow('p1');
    row.dataset.typed = 'still here';
    bulkEditBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isOpen('p1')).toBe(false);
    // Throwing the work away is what the row's own "ביטול" is for, and that one says so.
    expect(editRow('p1').dataset.typed).toBe('still here');
  });
});
