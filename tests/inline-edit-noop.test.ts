// @vitest-environment jsdom
/**
 * An inline cell edit that changed nothing must not be saved — and must not look saved.
 *
 * Owner, 2026-08-22: *"אם אני עורך inline משהו אבל בעצם לא עשיתי שינוי — למה זה עדיין עושה לי שם
 * שלוש נקודות של loader, לא חבל?"*
 *
 * This control commits on `blur`, so the commonest thing that happens to it is not an edit at all:
 * a click lands on a name, the seller changes their mind, they click elsewhere. Every one of those
 * was a POST, a spinner in the cell, and — because the server answers a successful patch with a new
 * `rev` — a revision bump on a row the seller had open, which is what turns their OWN next save
 * into a "somebody else changed this" conflict warning. A warning a seller caused themselves is
 * exactly what teaches them to click straight through the real one.
 *
 * The stock cases are the ones that make this a money/inventory test rather than a cosmetic one:
 * `patch-product-fields` writes an ABSOLUTE stock number with the displayed figure as its
 * compare-and-set baseline, so a no-op commit is a real write racing real sales for no reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindExistingRows, initInlineEdit } from '../src/scripts/dashboard/products.js';

(globalThis as { CSS?: { escape(v: string): string } }).CSS ??= {
  escape: (value: string) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`),
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const PRODUCT = {
  id: 'p1', storeId: 's1', name: 'כיסא עץ', description: '', price: 149.5, stock: 7,
  images: [], rev: 'r1',
};

let posted: FormData[] = [];

/** Answers a patch the way `/api/product` does, so a REAL edit still completes. */
function stubFetch(): void {
  posted = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(init?.body as FormData);
    return {
      ok: true,
      json: async () => ({
        ok: true, rev: 'r2', stockAlerts: 0,
        product: { name: 'שונה', price: 200, stock: 3 },
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

function renderTab(): void {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <script type="application/json" id="dash-products-page">${JSON.stringify([PRODUCT])}</script>
    <div id="upload-config" data-store-id="s1" data-cloud="c" data-preset="p" data-store-slug="s" data-store-name="S"></div>
    <table id="products-table"><tbody id="products-tbody">
      <tr data-product-display="p1" data-store-id="s1"
          data-sort-name="כיסא עץ" data-sort-price="149.5" data-sort-stock="7">
        <td class="name-col"><span class="product-name">כיסא עץ</span></td>
        <td class="num product-price">₪149.50</td>
        <td class="num product-stock">7</td>
      </tr>
      <tr class="edit-row" data-product-edit="p1" data-edit-pending hidden></tr>
    </tbody></table>`;
}

const cell = (sel: string): HTMLElement => document.querySelector<HTMLElement>(sel)!;
const openCell = (sel: string): HTMLInputElement => {
  cell(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return cell(sel).querySelector<HTMLInputElement>('[data-inline-input]')!;
};
/** Blur is what commits — the same gesture as clicking away from the cell. */
const commit = async (input: HTMLInputElement): Promise<void> => {
  input.dispatchEvent(new FocusEvent('blur'));
  await Promise.resolve();
  await Promise.resolve();
};

let inlineBound = false;

beforeEach(() => {
  stubFetch();
  renderTab();
  bindExistingRows('c', 'p');
  // `initInlineEdit` binds one delegated listener on `document`, which survives `innerHTML`.
  if (!inlineBound) { initInlineEdit(); inlineBound = true; }
});

describe('an inline edit that changed nothing', () => {
  it('does not POST, for the name', async () => {
    const input = openCell('.product-name');
    await commit(input);
    expect(posted).toHaveLength(0);
  });

  it('does not POST, for the price — including a differently written same number', async () => {
    const input = openCell('.product-price');
    input.value = '149.50';
    await commit(input);
    expect(posted).toHaveLength(0);
  });

  it('does not POST, for the stock', async () => {
    const input = openCell('.product-stock');
    await commit(input);
    expect(posted).toHaveLength(0);
  });

  it('does not POST when a number field is left empty — that is a seller giving up, not a value', async () => {
    const input = openCell('.product-stock');
    input.value = '';
    await commit(input);
    expect(posted).toHaveLength(0);
  });

  it('puts the rendered value straight back, with no spinner left behind', async () => {
    const input = openCell('.product-price');
    await commit(input);
    // Asserted on what RENDERS, not on the flag the code just cleared: the cell is text again,
    // there is no input and no `.dot-pulse` in it.
    expect(cell('.product-price').querySelector('[data-inline-input]')).toBeNull();
    expect(cell('.product-price').querySelector('.dot-pulse')).toBeNull();
    expect(cell('.product-price').textContent).toBe('₪149.50');
  });

  it('leaves the row re-openable — the cell is not stuck in edit mode', async () => {
    await commit(openCell('.product-stock'));
    expect(cell('.product-stock').dataset.inlineActive).toBeUndefined();
    expect(openCell('.product-stock')).not.toBeNull();
  });
});

describe('an inline edit that DID change something', () => {
  it('still POSTs the new price', async () => {
    const input = openCell('.product-price');
    input.value = '200';
    await commit(input);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.get('price')).toBe('200');
  });

  it('still POSTs the new stock, carrying the displayed figure as its compare-and-set baseline', async () => {
    const input = openCell('.product-stock');
    input.value = '3';
    await commit(input);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.get('stock')).toBe('3');
    expect(posted[0]?.get('prevStock')).toBe('7');
  });

  it('counts a name that differs only in its letters, not in its spaces', async () => {
    const input = openCell('.product-name');
    input.value = '  כיסא עץ  ';
    await commit(input);
    expect(posted).toHaveLength(0);

    const again = openCell('.product-name');
    again.value = 'כיסא עץ מלא';
    await commit(again);
    expect(posted).toHaveLength(1);
  });
});
