// @vitest-environment jsdom
/**
 * What happens to an OPEN product editor, and to the draft behind it, when the table moves under it.
 *
 * Four failures found together on 2026-08-20, after the owner said *"אז אתה חייב לטפל בבאג שמצאת!
 * זה גרוע, ותחפש שם עוד באגים"*. Every one of them is silent, and three of them only became visible
 * the day drafts started being announced:
 *
 *  1. **A table rebuild threw away every open editor and the typing in it.** `applyPagination`
 *     replaces the whole tbody, and it is the end of BOTH deletes and the whole of search, filter,
 *     sort, page and page-size — so deleting one product silently discarded a half-written edit of
 *     another. Confirmed in a real browser before it was fixed. (The cross-tab refresh had been
 *     protected from exactly this since it was written — `tab-sync.ts#isBusy` — while the seller's
 *     own filter had not.)
 *  2. **The last words typed never reached localStorage**, because a draft is debounced 700ms and
 *     nothing flushed it before the rows went.
 *  3. **A successful save left the draft behind.** Every other save on this dashboard fires
 *     `dash:saved`; the product editor and the add-product form did not, so the guard neither
 *     dropped the draft nor retook its baseline — and the next load offered back, as unsaved work,
 *     exactly what the server already had.
 *  4. **A deleted product's draft outlived it** by up to seven days, because everything that drops
 *     a draft is anchored to the form that owns it and there is no longer a form or a row.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBulkSelection } from '../src/scripts/dashboard/bulk-selection.js';
import {
  applyPagination, bindExistingRows, initBulkSelect, initDeleteProduct,
} from '../src/scripts/dashboard/products.js';

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

/** What `/api/seller/products` answers — the shape `applyPagination` reads. */
function stubFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    const body = url.includes('/api/seller/products')
      ? { ok: true, items: IDS.map(product), page: 1, totalPages: 1, total: IDS.length, stockAlerts: 0 }
      : { ok: true, rev: 'r2' };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

function renderTab(): void {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <script type="application/json" id="dash-products-page">${JSON.stringify(IDS.map(product))}</script>
    <div id="upload-config" data-store-id="s1" data-cloud="c" data-preset="p" data-store-slug="s" data-store-name="S"></div>
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
    <table id="products-table"><tbody id="products-tbody">
      ${IDS.map((id) => `
        <tr data-product-display="${id}" data-store-id="s1">
          <td class="row-num">1</td><td class="thumb-col"></td>
          <td class="name-col"><span class="product-name">${id}</span></td>
          <td><input type="checkbox" data-bulk-check="${id}"></td>
          <td>
            <button type="button" data-edit-toggle="${id}"></button>
            <button type="button" data-delete-product="${id}" data-store-id="s1"></button>
          </td>
        </tr>
        <tr class="edit-row" data-product-edit="${id}" data-edit-pending hidden></tr>`).join('')}
    </tbody></table>
    <p id="empty-products" hidden></p>`;
}

const editRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-product-edit="${id}"]`)!;
const isOpen = (id: string): boolean => !editRow(id).hidden;
const openFromRowMenu = (id: string): void => {
  document.querySelector<HTMLButtonElement>(`[data-edit-toggle="${id}"]`)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

/** The confirm modal is a separate module; here we take the decision it would have carried. */
async function confirmNext(act: () => void): Promise<void> {
  let onConfirm: (() => Promise<void> | void) | undefined;
  const listener = (e: Event): void => { onConfirm = (e as CustomEvent).detail?.onConfirm; };
  window.addEventListener('confirm:open', listener);
  act();
  window.removeEventListener('confirm:open', listener);
  await onConfirm?.();
}

let scanned: string[] = [];
let flushed = 0;
let dropped: string[] = [];

beforeAll(() => {
  renderTab();
  initBulkSelect('c', 'p');
  initDeleteProduct();
});

beforeEach(() => {
  stubFetch();
  scanned = []; flushed = 0; dropped = [];
  window.__dashFlushDrafts = (): void => { flushed++; };
  window.__dashDropProductDraft = (id: string): void => { dropped.push(id); };
  window.__dashScanDrafts = (root?: ParentNode): void => {
    scanned.push((root as HTMLElement)?.getAttribute?.('data-product-edit') ?? 'document');
  };
  window.__dashDraftProducts = (): string[] => [];
  renderTab();
  clearBulkSelection();
  bindExistingRows('c', 'p');
});

describe('an open editor survives the table being rebuilt under it', () => {
  it('is still open, for every product the new page still shows', async () => {
    openFromRowMenu('p2');
    expect(isOpen('p2')).toBe(true);
    await applyPagination();
    // Before the fix this was false: `replaceChildren` took the row and the typing with it, and
    // nothing said so. It is the last thing a delete does, and the whole of filter/sort/search/page.
    expect(isOpen('p2')).toBe(true);
    expect([isOpen('p1'), isOpen('p3')]).toEqual([false, false]);
  });

  it('writes the pending draft BEFORE the rows go', async () => {
    openFromRowMenu('p2');
    await applyPagination();
    // A draft is debounced 700ms. Without this flush the last words typed are in no form and in no
    // localStorage entry — they are simply gone.
    expect(flushed).toBe(1);
  });

  it('hands the rebuilt form to the draft guard, so what he typed is offered back', async () => {
    openFromRowMenu('p2');
    await applyPagination();
    // The row is a fresh copy of the SERVER's values; his own are in the draft, and this is the
    // call that puts the offer in front of him instead of losing the edit in silence.
    expect(scanned).toContain('p2');
  });

  it('does not resurrect an editor for a product the new page no longer shows', async () => {
    openFromRowMenu('p2');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, items: [product('p1')], page: 1, totalPages: 1, total: 1, stockAlerts: 0 }),
    } as unknown as Response)) as typeof fetch;
    await applyPagination();
    expect(document.querySelector('[data-product-edit="p2"]')).toBe(null);
  });
});

describe('a draft never outlives what it belongs to', () => {
  it('is forgotten when the product is deleted', async () => {
    await confirmNext(() => {
      document.querySelector<HTMLButtonElement>('[data-delete-product="p3"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Everything else that drops a draft runs from the form that owns it, and there is no longer a
    // form or a row — so without this it sits for its full week and is announced as unsaved work on
    // a product that does not exist.
    expect(dropped).toEqual(['p3']);
  });

  it('is not forgotten when the delete was refused', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ ok: false, error: 'no' }),
    } as unknown as Response)) as typeof fetch;
    await confirmNext(() => {
      document.querySelector<HTMLButtonElement>('[data-delete-product="p3"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dropped).toEqual([]);
  });
});

describe('a save says so, like every other save on this dashboard', () => {
  it('fires dash:saved with the form, so the draft goes and the baseline is retaken', async () => {
    openFromRowMenu('p1');
    const form = editRow('p1').querySelector<HTMLFormElement>('form')!;
    const saved: HTMLFormElement[] = [];
    const listener = (e: Event): void => { saved.push((e as CustomEvent).detail?.form); };
    window.addEventListener('dash:saved', listener);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(saved.length).toBe(1));
    window.removeEventListener('dash:saved', listener);
    expect(saved[0]).toBe(form);
  });
});
