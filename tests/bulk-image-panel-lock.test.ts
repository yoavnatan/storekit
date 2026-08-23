// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clearBulkSelection, syncBulkSelectionToRows } from '../src/scripts/dashboard/bulk-selection.js';
import { bindExistingRows, initBulkSelect } from '../src/scripts/dashboard/products.js';

/**
 * **The bulk image panel freezes the selection it was built from, and nothing else may open a
 * second gallery for a product it holds** (owner, 2026-08-17: *"שיהיה ברור. לא צריך בחירה אחרי
 * זה"*).
 *
 * `renderUploadPanel` reads the selection ONCE, at open time. Everything pinned below is a way the
 * live table underneath used to walk away from that snapshot, and every one of them was silent:
 *
 *  · tick a third product → the toolbar counts 3, the panel still works on 2;
 *  · UNtick one that is in the panel → it stays in the panel, and "שמור הכל" writes images to a
 *    product the seller just dropped — the one thing `bulk-selection.ts` promises cannot happen;
 *  · clear the selection, or merely FILTER to a category holding none of the selected rows (
 *    `selectedRowIds` counts only rendered rows) → `updateBar`'s `empty` branch hides the panel
 *    outright, taking every unsaved pick with it;
 *  · open a product's own edit row while it sits in the panel → two live galleries, both posting
 *    the whole `images` list, last save wins. That one is data loss rather than confusion, and the
 *    revision merge that normally catches it is *defeated* rather than absent — see
 *    `syncEditRowRev`, whose own guard is in `bulk-image-rev-sync.test.ts`.
 *
 * Driven through the real `initBulkSelect` against the markup `dashboard.astro` ships, because the
 * bug was never in a pure function: it was in which listener ran last.
 */

/** jsdom ships no `CSS.escape`, and `products.ts` builds every id selector through it (a product id
 *  is server-generated, but a selector concatenated from data is the habit worth keeping). Every
 *  browser this code runs in has it, so polyfilling is restoring the environment rather than
 *  bending the test — the alternative is dropping the escape from the source to suit jsdom. */
(globalThis as { CSS?: { escape(v: string): string } }).CSS ??= {
  escape: (value: string) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`),
};

/** Same class, second API: opening the panel scrolls its sticky header into view, and that watches
 *  the container with a `ResizeObserver` jsdom does not implement. Stubbed inert — this file is
 *  about which listener runs, never about where the page ends up scrolled. */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

/** The image every product starts with — what a stale gallery would still be showing. */
const ORIGINAL_IMAGE = 'https://res.cloudinary.com/x/image/upload/before-save.jpg';

/** The parts of the Products tab this behaviour touches, in the shapes the page really renders. */
function renderTab(productIds: string[]): void {
  const island = productIds.map((id) => ({
    id, storeId: 's1', name: id, description: '', price: 10, stock: 5,
    images: [ORIGINAL_IMAGE], rev: 'rev-served',
  }));
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <!-- The snapshot buildEditRow reads for a row nobody has opened yet. Its staleness on images
         is the whole subject of "what a panel save leaves behind" below. -->
    <script type="application/json" id="dash-products-page">${JSON.stringify(island)}</script>
    <div id="upload-config" data-store-id="s1"></div>
    <div class="products-header">
      <input type="checkbox" class="bulk-select-all">
    </div>
    <!-- The four selection buttons are in the floating bar (BulkActionBar.astro), and none of them
         carries a hidden attribute in the markup: the BAR is what appears with a selection, so
         hidden on a BUTTON now means one thing only, which is what this file is about - the image
         panel has taken that action away. -->
    <div id="bulk-bar" class="bulk-bar">
      <span id="bulk-count">0</span>
      <button id="bulk-delete-btn" type="button"></button>
      <button id="bulk-edit-btn" type="button"><span id="bulk-edit-label"></span></button>
      <button id="bulk-discount-btn" type="button"></button>
      <button id="bulk-upload-btn" type="button"><span id="bulk-upload-label"></span></button>
    </div>
    <div id="bulk-upload-panel" hidden></div>
    <table><tbody id="products-tbody">
      ${productIds.map((id) => `
        <tr data-product-display="${id}" data-images='["${ORIGINAL_IMAGE}"]'>
          <td class="row-num">1</td>
          <td class="thumb-col"></td>
          <td><span class="product-name">${id}</span></td>
          <td><input type="checkbox" data-bulk-check="${id}"></td>
          <td><button type="button" data-edit-toggle="${id}"></button></td>
        </tr>
        <tr class="edit-row" data-product-edit="${id}" data-edit-pending hidden></tr>`).join('')}
    </tbody></table>`;
}

const box = (id: string) => document.querySelector<HTMLInputElement>(`[data-bulk-check="${id}"]`)!;
const editToggle = (id: string) => document.querySelector<HTMLButtonElement>(`[data-edit-toggle="${id}"]`)!;
const selectAll = () => document.querySelector<HTMLInputElement>('.bulk-select-all')!;
const panel = () => document.getElementById('bulk-upload-panel')!;
const uploadBtn = () => document.getElementById('bulk-upload-btn') as HTMLButtonElement;
const panelIds = () => Array.from(panel().querySelectorAll<HTMLElement>('[data-upload-product]'))
  .map((el) => el.dataset.uploadProduct);

/** Ticks a row the way a seller does — the delegated `change` listener is what records it. */
function tick(id: string, on = true): void {
  const chk = box(id);
  chk.checked = on;
  chk.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Open the panel over the current selection. */
function openPanel(): void {
  uploadBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const IDS = ['p1', 'p2', 'p3'];
let tbodyHtml = '';

/**
 * **`initBulkSelect` runs ONCE for the whole file, and that is load-bearing rather than tidy.**
 *
 * It registers delegated listeners on `document` — the checkbox `change` and the thumbnail/row-number
 * click — and nothing ever removes them. Calling it per test therefore stacks handlers, and the
 * thumbnail one *toggles*: with two copies attached a click flips the box and flips it straight
 * back, so the shortcut looks blocked whether or not the lock is in place. That is a test which
 * passes for the wrong reason, and it passed against deliberately broken source before this was
 * restructured. Only the tbody is rebuilt between tests, which is also what `applyPagination` does
 * — the toolbar and the panel are the same elements `initBulkSelect` captured, as on a real page.
 */
beforeAll(() => {
  renderTab(IDS);
  tbodyHtml = document.getElementById('products-tbody')!.innerHTML;
  initBulkSelect('demo-cloud', 'demo-preset');
});

beforeEach(() => {
  // Close through the real path if a previous test left the panel open, so the lock is lifted by
  // the code under test rather than by the fixture reaching in.
  if (!panel().hidden) openPanel();
  document.getElementById('products-tbody')!.innerHTML = tbodyHtml;
  document.querySelectorAll<HTMLElement>('[data-product-edit]').forEach((r) => { r.hidden = true; });
  document.querySelectorAll<HTMLElement>('[data-product-display]').forEach((r) => { r.hidden = false; });
  clearBulkSelection();
  // Wires the per-ROW listeners onto the rows just rendered — including the row menu's "ערוך",
  // which is where `editToggleBlocked` runs. These are element-scoped, so unlike `initBulkSelect`'s
  // document-level ones they cannot accumulate: each rebuild produces new buttons.
  bindExistingRows('demo-cloud', 'demo-preset');
  document.getElementById('ajax-status')?.remove();
  // Re-ticks the fresh checkboxes from the (now empty) selection and repaints the toolbar.
  syncBulkSelectionToRows();
});

describe('opening the panel freezes the selection it was built from', () => {
  it('renders exactly the products that were selected', () => {
    tick('p1'); tick('p2');
    openPanel();
    expect(panel().hidden).toBe(false);
    expect(panelIds()).toEqual(['p1', 'p2']);
  });

  it('disables every row checkbox and the select-all box', () => {
    tick('p1'); tick('p2');
    openPanel();
    expect(box('p1').disabled).toBe(true);
    // p3 too: the frozen list must not grow either.
    expect(box('p3').disabled).toBe(true);
    expect(selectAll().disabled).toBe(true);
  });

  it('takes the competing bulk actions off the toolbar', () => {
    tick('p1');
    openPanel();
    // Bulk edit opens the very galleries that conflict; delete and discount would act on a list
    // the seller can no longer correct.
    expect(document.getElementById('bulk-edit-btn')!.hidden).toBe(true);
    expect(document.getElementById('bulk-delete-btn')!.hidden).toBe(true);
    expect(document.getElementById('bulk-discount-btn')!.hidden).toBe(true);
    // …and leaves the one way out.
    expect(uploadBtn().hidden).toBe(false);
  });

  it('ignores the thumbnail/row-number shortcut into the selection', () => {
    // `disabled` stops a click on the box itself, but this handler sets `.checked` in code, so it
    // needs its own answer — it was the one hole a DOM-only lock left open.
    tick('p1');
    openPanel();
    document.querySelector<HTMLElement>('[data-product-display="p3"] .thumb-col')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(box('p3').checked).toBe(false);
    expect(panelIds()).toEqual(['p1']);
  });

  it('blocks the row menu\'s own edit for a product the panel holds, and only for those', () => {
    tick('p1');
    openPanel();
    // `aria-disabled`, never the `disabled` attribute — the first version used `disabled` and the
    // owner could see neither the greying nor the message (2026-08-17). A `disabled` button takes
    // no pointer events, so the browser refuses to show its `title`; and the menu item is styled
    // by utilities that carry no `:disabled` variant, so it looked untouched: same pointer cursor,
    // same hover highlight, on a control that did nothing.
    expect(editToggle('p1').getAttribute('aria-disabled')).toBe('true');
    expect(editToggle('p1').hasAttribute('disabled')).toBe(false);
    expect(editToggle('p1').title).not.toBe('');
    // A product outside the panel has no second gallery to conflict with.
    expect(editToggle('p3').hasAttribute('aria-disabled')).toBe(false);
    expect(editToggle('p3').title).toBe('');
  });

  it('greys the blocked item through the markup, in both renderers', () => {
    // `aria-disabled` only greys anything if the class list says so, and the button is rendered
    // twice — server-side by dashboard.astro and client-side by `productRowHtml` for every rebuilt
    // row. The twin that was missed is the one the seller meets after a sort (memory
    // `project_brand_boost_twin_drift`).
    const NEEDED = ['aria-disabled:opacity-45', 'aria-disabled:cursor-not-allowed', 'aria-disabled:hover:bg-transparent'];
    const client = fs.readFileSync(path.join(process.cwd(), 'src/scripts/dashboard/products.ts'), 'utf8');
    const page = fs.readFileSync(path.join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');
    for (const source of [client, page]) {
      const line = source.split('\n').find((l) => l.includes('data-edit-toggle=') && l.includes('product-menu__item'))!;
      expect(line).toBeTruthy();
      NEEDED.forEach((cls) => expect(line).toContain(cls));
    }
  });

  it('a click on the blocked item explains itself instead of doing nothing', () => {
    // The tooltip needs a hover. A seller who clicked has already decided not to wait for one, and
    // a control that swallows a click silently is the thing this whole change is against
    // (memory `feedback_noop_interactions_invisible`).
    tick('p1');
    openPanel();
    // The notice is a TOAST since 2026-08-17 — it used to be a coloured strip inserted into the
    // panel, and a notice that reflows the page under the seller's eye was the wrong shape wherever
    // it was put. What this test cares about is unchanged and is the only thing worth pinning: the
    // click SAID something.
    const spoken: string[] = [];
    const listener = (e: Event): void => { spoken.push((e as CustomEvent<{ title?: string }>).detail?.title ?? ''); };
    window.addEventListener('toast:show', listener);
    editToggle('p1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.removeEventListener('toast:show', listener);
    expect(spoken.join('')).not.toBe('');
    // …and the row did NOT open.
    expect(document.querySelector<HTMLElement>('[data-product-edit="p1"]')!.hidden).toBe(true);
  });

  it('closes an edit row that was ALREADY open before the panel opened', () => {
    // Put the row in the state the row menu leaves it in — display hidden, edit shown. Set here
    // rather than by clicking, because the toggle's listener belongs to `attachListeners`, which
    // the products init wires per row and `initBulkSelect` never touches. What is under test is
    // what OPENING the panel does to a row it finds open, and that is exactly this state.
    tick('p1');
    const editRow = document.querySelector<HTMLElement>('[data-product-edit="p1"]')!;
    const displayRow = document.querySelector<HTMLElement>('[data-product-display="p1"]')!;
    editRow.hidden = false;
    displayRow.hidden = true;

    openPanel();

    // Disabling the menu item only stops the NEXT one; a row already open is the same two galleries.
    expect(editRow.hidden).toBe(true);
    expect(displayRow.hidden).toBe(false);
  });
});

describe('what a panel save leaves behind for the edit form', () => {
  /**
   * Owner's question, 2026-08-17: *"אם ערכתי מהסקשן זה יופיע בטופס עריכה? בלי לעשות רענן"*. There
   * are two answers because there are two states an edit row can be in, and only one of them was
   * right before this:
   *
   *  · a form that already EXISTS gets repainted by `syncEditRowRev` — pinned in
   *    `bulk-image-rev-sync.test.ts`;
   *  · a row still marked `data-edit-pending` has no form yet, and `buildEditRow` builds it from the
   *    page's product island. The island is a snapshot of the served document, so unless the save
   *    writes images back into it, opening that form afterwards shows the PRE-SAVE gallery — and
   *    saving it posts that stale list back over what was just uploaded.
   *
   * This drives the whole chain through the real save and then opens the form, because the failure
   * was an ORDER of operations (the revision was copied into the island before the row's
   * `data-images` moved), and no assertion on one function alone would have caught it.
   */
  const NEW_IMAGE = 'https://res.cloudinary.com/x/image/upload/after-save.jpg';

  it('an edit form opened AFTER the save shows the saved images, with no reload', async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = ((url: string, init?: { body?: FormData }) => {
      fetchCalls.push(String(url));
      const action = init?.body instanceof FormData ? String(init.body.get('_action')) : '';
      expect(action).toBe('patch-product-images');
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, images: [NEW_IMAGE], rev: 'rev-after-save' }),
      });
    }) as unknown as typeof fetch;

    tick('p1');
    openPanel();
    document.getElementById('bulk-upload-save-all')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The save is a promise chain with no hook to await; one macrotask turn is enough for a fetch
    // that resolves immediately.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(1);

    // The row itself followed…
    const row = document.querySelector<HTMLElement>('[data-product-display="p1"]')!;
    expect(JSON.parse(row.dataset.images!)).toEqual([NEW_IMAGE]);

    // …and so did the island, which is the half that was missing: closing the panel lifts the lock,
    // and the form built on the next click must carry the saved list.
    openPanel();
    editToggle('p1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const built = document.querySelector<HTMLElement>('[data-product-edit="p1"]')!;
    const urls = Array.from(built.querySelectorAll<HTMLInputElement>('input[name="images"]'))
      .map((inp) => inp.value).filter(Boolean);
    expect(urls).toEqual([NEW_IMAGE]);
  });
});

describe('the panel survives what used to close it', () => {
  it('a tbody rebuild that renders none of the selected rows leaves it open', () => {
    tick('p1'); tick('p2');
    openPanel();
    // What a filter change does: `applyPagination` replaces the tbody wholesale. `selectedRowIds`
    // then answers 0 — it counts only RENDERED ticked rows — which used to reach the `empty`
    // branch and hide the panel with the seller's uploads still in it.
    document.getElementById('products-tbody')!.innerHTML = '';
    // The rebuild notifies through the same path `syncBulkSelectionToRows` uses.
    selectAll().dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel().hidden).toBe(false);
    expect(panelIds()).toEqual(['p1', 'p2']);
    expect(document.getElementById('bulk-count')!.textContent).toBe('2');
  });

  it('the toolbar toggle still closes it when no selected row is rendered', () => {
    // The regression this pins: the toggle used to answer "is there anything selected on screen?"
    // BEFORE "am I open?", so a filter that rendered none of the panel's rows made the button
    // inert and left the ✕ as the only exit.
    tick('p1');
    openPanel();
    document.getElementById('products-tbody')!.innerHTML = '';
    openPanel();
    expect(panel().hidden).toBe(true);
  });

  it('closing it lifts the lock', () => {
    tick('p1');
    openPanel();
    openPanel(); // the toggle's close half
    expect(panel().hidden).toBe(true);
    expect(box('p1').disabled).toBe(false);
    expect(box('p3').disabled).toBe(false);
    expect(selectAll().disabled).toBe(false);
    expect(editToggle('p1').disabled).toBe(false);
    expect(document.getElementById('bulk-edit-btn')!.hidden).toBe(false);
  });
});
