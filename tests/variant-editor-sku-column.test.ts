// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { comboKey } from '../src/lib/variant-combo.js';
import { applyVariantsPayload, collectVariantsPayload, initVariantEditors } from '../src/scripts/dashboard/products.js';

/**
 * The per-combination code, as the seller actually meets it: a column in the combo table.
 *
 * It has to survive the two things that happen to that table — a save, and a relabelled dimension —
 * because the code is the link to the seller's own inventory system and a lost one silently stops
 * an external sync from matching (`variant-sku-match.ts`).
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {} unobserve(): void {} disconnect(): void {}
};

const S = comboKey({ מידה: 'S' });
const M = comboKey({ מידה: 'M' });

function renderEditor(variantSku: Record<string, string> = {}): HTMLFormElement {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <form>
      <input name="stock" value="10">
      <div class="field variants-editor" data-variants-editor>
        <div class="variant-dims" data-variant-dims></div>
        <p data-variant-limit-note hidden></p>
        <div class="variant-combos" data-variant-combos hidden>
          <p data-variant-combo-hint hidden></p>
          <table><thead data-variant-combo-thead></thead><tbody data-variant-combo-rows></tbody><tfoot data-variant-combo-tfoot></tfoot></table>
        </div>
      </div>
    </form>`;
  const form = document.querySelector('form')!;
  applyVariantsPayload(form, {
    variants: [{ name: 'מידה', options: ['S', 'M'] }],
    variantStock: { [S]: 3, [M]: 4 },
    variantSku,
    variantImages: {},
  }, 7);
  return form;
}

const skuInput = (form: HTMLFormElement, key: string) =>
  form.querySelector<HTMLInputElement>(`[data-combo-key="${key}"] [data-combo-sku]`)!;

beforeAll(() => { initVariantEditors(); });
beforeEach(() => { document.body.innerHTML = ''; });

describe('the SKU column in the combo table', () => {
  it('shows the codes the product already has', () => {
    const form = renderEditor({ [S]: 'SH-S' });
    expect(skuInput(form, S).value).toBe('SH-S');
    expect(skuInput(form, M).value, 'a combo with no code shows an empty box, not a placeholder value').toBe('');
  });

  it('sends what the seller typed, and leaves the blank ones out entirely', () => {
    const form = renderEditor();
    skuInput(form, S).value = '  SH-S  ';

    const { variantSku } = collectVariantsPayload(form);
    // Trimmed, and M is absent rather than '' — no code is a real answer.
    expect(variantSku).toEqual({ [S]: 'SH-S' });
  });

  it('carries the codes through a relabelled dimension, like the counts beside them', () => {
    const form = renderEditor({ [S]: 'SH-S', [M]: 'SH-M' });
    const nameInput = form.querySelector<HTMLInputElement>('[data-dim-name]')!;
    nameInput.value = 'Size';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    const { variantSku, variantStock } = collectVariantsPayload(form);
    expect(variantSku).toEqual({
      [comboKey({ Size: 'S' })]: 'SH-S',
      [comboKey({ Size: 'M' })]: 'SH-M',
    });
    expect(variantStock[comboKey({ Size: 'S' })], 'and the stock still rides along too').toBe(3);
  });
});
