// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindExistingRows } from '../src/scripts/dashboard/products.js';

/**
 * **What a saved edit form leaves on the row behind it** (owner, 2026-08-17: *"צריך לוודא
 * שכששומרים טופס הוא נשמר גם אם אני אפתח אותו שוב לפני ריענון של הדף. לא רק התמונות, כולו"*).
 *
 * The form itself was never at risk — its markup survives the save and reopening it just unhides
 * the same DOM, so it shows exactly what was written. What went stale is the DISPLAY ROW, and the
 * row is what every other feature on the tab reads:
 *
 *   `data-images`     → `renderUploadPanel` builds the bulk image panel from it. Save new photos in
 *                       the edit form, open the panel for that product, and it offered the OLD
 *                       list — with "שמור הכל" ready to post it back over what was just saved.
 *                       The mirror image of the bug the panel lock was built for.
 *   `data-discount`   → the bulk "מבצע" panel prefills from it (promotions.ts#65).
 *   `data-categoryId` → the same panel sends it as the scope of a category-wide sale
 *                       (promotions.ts#387), so a recategorised product could be priced under the
 *                       category it had just left.
 *
 * All three arrive in the save response and were simply never written down. Driven through the real
 * submit handler rather than asserted on source, because the guarantee is "after a save the row
 * agrees with the record", and only the whole path can say whether it does.
 */

(globalThis as { CSS?: { escape(v: string): string } }).CSS ??= {
  escape: (value: string) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`),
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {} unobserve(): void {} disconnect(): void {}
};

const OLD_IMAGE = 'https://res.cloudinary.com/x/image/upload/old.jpg';
const NEW_IMAGE = 'https://res.cloudinary.com/x/image/upload/new.jpg';
const OLD_DISCOUNT = { type: 'percent', value: 10 };
const NEW_DISCOUNT = { type: 'percent', value: 25 };

function renderTab(): void {
  const island = [{
    id: 'p1', storeId: 's1', name: 'p1', description: '', price: 10, stock: 5,
    images: [OLD_IMAGE], categoryId: 'cat-old', discount: OLD_DISCOUNT, rev: 'rev-served',
  }];
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <script type="application/json" id="dash-products-page">${JSON.stringify(island)}</script>
    <div id="upload-config" data-store-id="s1"></div>
    <div class="products-header"></div>
    <table><tbody id="products-tbody">
      <tr data-product-display="p1"
          data-images='["${OLD_IMAGE}"]'
          data-category-id="cat-old"
          data-discount='${JSON.stringify(OLD_DISCOUNT)}'
          data-store-id="s1">
        <td class="thumb-col"></td>
        <td><span class="product-name">p1</span></td>
        <td class="product-price"></td>
        <td class="product-stock"></td>
        <td class="cat-col"></td>
        <td class="sku-col"></td>
        <td><button type="button" data-edit-toggle="p1"></button></td>
      </tr>
      <tr class="edit-row" data-product-edit="p1" data-edit-pending hidden></tr>
    </tbody></table>`;
}

const row = () => document.querySelector<HTMLElement>('[data-product-display="p1"]')!;

/** The server's answer to `edit-product`, with every field the client is supposed to write down. */
function mockSaveResponse(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true, rev: 'rev-after-save',
        images: [NEW_IMAGE], categoryId: 'cat-new', categoryPath: 'חדש', discount: NEW_DISCOUNT,
      }),
    });
  }) as unknown as typeof fetch;
  return calls;
}

beforeAll(() => { renderTab(); });

beforeEach(() => {
  renderTab();
  bindExistingRows('demo-cloud', 'demo-preset');
});

describe('a saved edit form updates the row every other feature reads', () => {
  async function openAndSave(): Promise<void> {
    document.querySelector<HTMLButtonElement>('[data-edit-toggle="p1"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const form = document.querySelector<HTMLFormElement>('form.inline-edit-form')!;
    expect(form).toBeTruthy();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // The handler is async around one immediately-resolving fetch; two turns clear its chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('writes the saved images back, so the bulk image panel cannot offer the old ones', async () => {
    const calls = mockSaveResponse();
    await openAndSave();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(row().dataset.images!)).toEqual([NEW_IMAGE]);
  });

  it('writes the saved discount back, so the bulk sale panel prefills from the new one', async () => {
    mockSaveResponse();
    await openAndSave();
    expect(JSON.parse(row().dataset.discount!)).toEqual(NEW_DISCOUNT);
  });

  it('writes the saved category id back, so a category-wide sale scopes to where it is now', async () => {
    mockSaveResponse();
    await openAndSave();
    expect(row().dataset.categoryId).toBe('cat-new');
  });

  it('carries the revision, so the seller\'s own next save is not read as a conflict', async () => {
    mockSaveResponse();
    await openAndSave();
    const form = document.querySelector<HTMLFormElement>('form.inline-edit-form')!;
    expect(form.dataset.baseRev).toBe('rev-after-save');
  });
});
