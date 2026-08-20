// @vitest-environment jsdom
/**
 * The Products toolbar has four buttons, three ways to open an editor and a lock, and the owner's
 * point on 2026-08-20 is the right one: *"יש שם המון קומבינציות של לחיצות, בחירות, בחירות חלקיות,
 * ביטול בחירות חלקיות… צריך לחשוב על המון תרחישי קצה, ולראות שזה לא שובר אחד את השני."*
 *
 * Each of those pieces has its own test file, and each of them passes. What nothing covered is the
 * pieces MEETING — which is where the day's bugs actually were: a rebuild destroying an editor that
 * a different button opened, a label derived from a selection that had not been restored yet, a
 * draft outliving the product it belonged to.
 *
 * So this file is deliberately about combinations rather than features, and it pins two invariants
 * that must hold after EVERY sequence, however the seller got there:
 *
 *   **1. The toolbar acts on the selection and on nothing else.** It only exists while something is
 *      ticked, it counts what is ticked, and מחק / ערוך / עריכת תמונות / הנחה all mean that set. A
 *      row the seller opened from its own menu is his, and is closed by its own "ביטול".
 *   **2. The word on the button is what the press will do.** "ערוך" opens, "סגור עריכה" closes —
 *      derived from live row state after every operation, never from what it was last set to.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBulkSelection } from '../src/scripts/dashboard/bulk-selection.js';
import { applyPagination, bindExistingRows, initBulkSelect } from '../src/scripts/dashboard/products.js';

(globalThis as { CSS?: { escape(v: string): string } }).CSS ??= {
  escape: (value: string) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`),
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const IDS = ['p1', 'p2', 'p3'];
const product = (id: string): Record<string, unknown> => ({
  id, storeId: 's1', name: id, description: '', price: 10, stock: 5, images: [], rev: 'r1',
});

let pageItems = IDS;
function stubFetch(): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ok: true, items: pageItems.map(product), page: 1, totalPages: 1, total: pageItems.length, stockAlerts: 0,
    }),
  } as unknown as Response)) as typeof fetch;
}

function renderTab(): void {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{"bulkEdit":"ערוך","bulkEditClose":"סגור עריכה","bulkUploadImages":"העלה תמונות","bulkUploadLocked":"סגרו קודם את עריכת התמונות"},"gallery":{}}</script>
    <script type="application/json" id="dash-products-page">${JSON.stringify(IDS.map(product))}</script>
    <div id="upload-config" data-store-id="s1" data-cloud="c" data-preset="p" data-store-slug="s" data-store-name="S"></div>
    <div class="products-header">
      <input type="checkbox" class="bulk-select-all">
      <span id="bulk-count-badge" hidden><span id="bulk-count">0</span></span>
      <span id="bulk-sep" hidden></span>
      <button id="bulk-delete-btn" hidden type="button"></button>
      <button id="bulk-edit-btn" hidden type="button"><span id="bulk-edit-label">ערוך</span></button>
      <button id="bulk-discount-btn" hidden type="button"></button>
      <button id="bulk-upload-btn" hidden type="button"><span id="bulk-upload-label">העלה תמונות</span></button>
      <span id="bulk-count-paren"></span>
    </div>
    <div id="bulk-upload-panel" hidden></div>
    <table id="products-table"><tbody id="products-tbody">
      ${IDS.map((id) => `
        <tr data-product-display="${id}" data-store-id="s1" data-images='[]'>
          <td class="row-num">1</td><td class="thumb-col"></td>
          <td class="name-col"><span class="product-name">${id}</span></td>
          <td><input type="checkbox" data-bulk-check="${id}"></td>
          <td><button type="button" data-edit-toggle="${id}"></button></td>
        </tr>
        <tr class="edit-row" data-product-edit="${id}" data-edit-pending hidden></tr>`).join('')}
    </tbody></table>
    <p id="empty-products" hidden></p>`;
}

const chk = (id: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`[data-bulk-check="${id}"]`)!;
const editRowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-product-edit="${id}"]`);
const isOpen = (id: string): boolean => !!editRowOf(id) && !editRowOf(id)!.hidden;
const openIds = (): string[] => IDS.filter(isOpen);
const editBtn = (): HTMLButtonElement => document.getElementById('bulk-edit-btn') as HTMLButtonElement;
const label = (): string => document.getElementById('bulk-edit-label')!.textContent ?? '';
const uploadBtn = (): HTMLButtonElement => document.getElementById('bulk-upload-btn') as HTMLButtonElement;
const panel = (): HTMLElement => document.getElementById('bulk-upload-panel')!;
const selectAll = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.bulk-select-all')!;

function tick(id: string, on = true): void {
  const box = chk(id);
  box.checked = on;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
function tickAll(on = true): void {
  const box = selectAll();
  box.checked = on;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
const press = (btn: HTMLElement): void => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
const openFromRowMenu = (id: string): void => {
  press(document.querySelector<HTMLButtonElement>(`[data-edit-toggle="${id}"]`)!);
};

/**
 * Invariant 2, asserted after every sequence rather than at the one place it was noticed: the word
 * on the button has to match what pressing it does. Verified by PRESSING — a label that agrees with
 * the code by accident and disagrees with the seller is the failure being guarded.
 */
function labelMatchesEffect(): void {
  if (editBtn().hidden) return;
  const before = openIds();
  const said = label();
  press(editBtn());
  const after = openIds();
  if (said === 'סגור עריכה') expect(after.length, `"${said}" should have closed something`).toBeLessThan(before.length);
  else expect(after.length, `"${said}" should have opened something`).toBeGreaterThanOrEqual(before.length);
  press(editBtn());   // put it back
}

/**
 * **The page is rendered ONCE, and only the tbody is rebuilt between tests** — the same constraint
 * `bulk-image-panel-lock.test.ts` records, and it is a fact about the code rather than tidiness.
 * `initBulkSelect` captures the toolbar's elements and registers delegated listeners on `document`:
 * re-rendering the body would leave it holding detached nodes, and calling it again would stack a
 * second copy of every listener. Rebuilding the tbody alone is also exactly what `applyPagination`
 * does on a real page.
 */
let tbodyHtml = '';
beforeAll(() => {
  renderTab();
  tbodyHtml = document.getElementById('products-tbody')!.innerHTML;
  initBulkSelect('c', 'p');
});

beforeEach(() => {
  pageItems = IDS;
  stubFetch();
  window.__dashScanDrafts = (): void => {};
  window.__dashFlushDrafts = (): void => {};
  window.__dashDropProductDraft = (): void => {};
  window.__dashDraftProducts = (): string[] => [];
  // Close through the real path if a previous test left the panel open, so the lock is lifted by
  // the code under test rather than by the fixture reaching in.
  if (!panel().hidden) press(uploadBtn());
  document.getElementById('products-tbody')!.innerHTML = tbodyHtml;
  clearBulkSelection();
  bindExistingRows('c', 'p');
  selectAll().checked = false;
});

describe('a selection and an editor the seller opened himself', () => {
  it('leaves his row alone through open, close and open again', () => {
    openFromRowMenu('p1');
    tick('p2'); tick('p3');

    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2', 'p3']);
    press(editBtn());
    expect(openIds()).toEqual(['p1']);
    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('says "ערוך" while only his own row is open, and the press proves it', () => {
    openFromRowMenu('p1');
    tick('p2');
    expect(label()).toBe('ערוך');
    labelMatchesEffect();
  });
});

describe('partial selections, and taking them back', () => {
  it('follows the selection when a product is added to it mid-edit', () => {
    tick('p1'); tick('p2');
    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2']);

    // A third joins while two are open. The button still describes the selection, and a press has
    // to leave the table in one state rather than half open and half closed.
    tick('p3');
    expect(label()).toBe('סגור עריכה');
    press(editBtn());
    expect(openIds()).toEqual([]);
    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('lets go of a row when its product is unticked, and stops claiming it', () => {
    tick('p1'); tick('p2');
    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2']);

    tick('p2', false);            // he changed his mind about p2 — its editor is still open
    expect(label()).toBe('סגור עריכה');
    press(editBtn());
    // p2 is nobody's business but his now; the toolbar closed exactly what it still holds.
    expect(openIds()).toEqual(['p2']);
  });

  it('hides itself when the selection empties, leaving open rows untouched', () => {
    tick('p1'); tick('p2');
    press(editBtn());
    tick('p1', false); tick('p2', false);
    expect(editBtn().hidden).toBe(true);
    // Nothing closed them, and nothing should have: the toolbar acts on a selection that no longer
    // exists. Both rows keep their own "ביטול".
    expect(openIds()).toEqual(['p1', 'p2']);
  });

  it('comes back with the right word when the selection returns', () => {
    tick('p1');
    press(editBtn());
    tick('p1', false);
    expect(editBtn().hidden).toBe(true);
    tick('p1');
    // Re-derived from live row state, never from what the label was when it was last hidden.
    expect(label()).toBe('סגור עריכה');
    labelMatchesEffect();
  });

  it('handles select-all, then one taken back', () => {
    tickAll();
    press(editBtn());
    expect(openIds()).toEqual(IDS);
    tick('p2', false);
    press(editBtn());
    expect(openIds()).toEqual(['p2']);
    expect(label()).toBe('ערוך');
    labelMatchesEffect();
  });
});

describe('mixed states — some of the selection open, some not', () => {
  it('says close, and closes, when the selection is half open', () => {
    openFromRowMenu('p1');
    tickAll();
    // p1 is open and ticked, p2 and p3 are ticked and closed. A press cannot both open and close,
    // so the word has to say which — and it is the seller's own open row that decides.
    expect(label()).toBe('סגור עריכה');
    press(editBtn());
    expect(openIds()).toEqual([]);
    expect(label()).toBe('ערוך');
    press(editBtn());
    expect(openIds()).toEqual(IDS);
  });

  it('lets select-all take everything back without touching the open rows', () => {
    tickAll();
    press(editBtn());
    expect(openIds()).toEqual(IDS);
    tickAll(false);
    expect(editBtn().hidden).toBe(true);
    // Unticking is not a statement about editing — the rows stay open, each with its own "ביטול".
    expect(openIds()).toEqual(IDS);
  });

  it('re-arms on the rows a rebuild brings back, and stays honest about the word', async () => {
    tickAll();
    press(editBtn());
    await applyPagination();
    expect([chk('p1').checked, chk('p2').checked, chk('p3').checked]).toEqual([true, true, true]);
    expect(openIds()).toEqual(IDS);
    expect(label()).toBe('סגור עריכה');
    labelMatchesEffect();
  });
});

describe('a rebuild in the middle of all that', () => {
  it('keeps the selection, the open rows and the right word together', async () => {
    tick('p1'); tick('p2');
    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2']);

    await applyPagination();
    expect(openIds()).toEqual(['p1', 'p2']);
    expect([chk('p1').checked, chk('p2').checked, chk('p3').checked]).toEqual([true, true, false]);
    // The bug this ordering caused: the label was asked before the selection was re-ticked, read an
    // empty one, and left "ערוך" on a button whose press closes.
    expect(label()).toBe('סגור עריכה');
    labelMatchesEffect();
  });

  it('keeps a row the seller opened himself, which no button was holding', async () => {
    openFromRowMenu('p3');
    await applyPagination();
    expect(openIds()).toEqual(['p3']);
  });

  it('drops a row whose product the new page no longer shows, and nothing else', async () => {
    openFromRowMenu('p1');
    openFromRowMenu('p3');
    pageItems = ['p1', 'p2'];
    await applyPagination();
    expect(openIds()).toEqual(['p1']);
    expect(editRowOf('p3')).toBe(null);
  });

  it('survives a rebuild that returns nothing at all', async () => {
    tick('p1');
    press(editBtn());
    pageItems = [];
    await applyPagination();
    expect(openIds()).toEqual([]);
    // And the toolbar does not sit there claiming a selection over a table with no rows in it.
    expect(editBtn().hidden).toBe(true);
  });
});

describe('the image panel, which takes products out of the toolbar\'s hands', () => {
  it('hides the other three buttons and locks the checkboxes while it is open', () => {
    tick('p1'); tick('p2');
    press(uploadBtn());
    expect(panel().hidden).toBe(false);
    expect([editBtn().hidden, document.getElementById('bulk-delete-btn')!.hidden]).toEqual([true, true]);
    expect([chk('p1').disabled, chk('p3').disabled]).toEqual([true, true]);
  });

  it('closes the editors of the products it takes over, and only those', () => {
    openFromRowMenu('p3');       // his own, nothing to do with the panel
    tick('p1'); tick('p2');
    press(editBtn());
    expect(openIds()).toEqual(['p1', 'p2', 'p3']);

    press(uploadBtn());
    // Two live galleries for one product is the data loss the lock exists to prevent; p3 is not in
    // the panel, so nothing about it has changed.
    expect(openIds()).toEqual(['p3']);
  });

  it('refuses the row menu for a product it holds, and allows it for one it does not', () => {
    tick('p1');
    press(uploadBtn());
    openFromRowMenu('p1');
    expect(isOpen('p1')).toBe(false);
    openFromRowMenu('p3');
    expect(isOpen('p3')).toBe(true);
  });

  it('does not let a rebuild reopen an editor for a product the panel holds', async () => {
    tick('p1'); tick('p2');
    press(editBtn());
    press(uploadBtn());          // closes p1 and p2's editors, keeps them in the panel
    expect(openIds()).toEqual([]);
    await applyPagination();
    // The reopen list is taken from what is OPEN, and the panel had already closed these — but the
    // combination is exactly the kind that breaks when two mechanisms are written apart.
    expect(openIds()).toEqual([]);
    expect(panel().hidden).toBe(false);
  });

  it('gives the buttons back when it closes', () => {
    tick('p1');
    press(uploadBtn());
    press(uploadBtn());
    expect(panel().hidden).toBe(true);
    expect(editBtn().hidden).toBe(false);
    expect(chk('p1').disabled).toBe(false);
    labelMatchesEffect();
  });
});
