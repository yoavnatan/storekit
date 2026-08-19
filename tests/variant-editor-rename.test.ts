// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { comboKey } from '../src/lib/variant-combo.js';
import { applyVariantsPayload, collectVariantsPayload, initVariantEditors } from '../src/scripts/dashboard/products.js';

/**
 * **Relabelling a dimension must not empty the stock table** (found 2026-08-19, external-sync audit).
 *
 * A combo is keyed by its dimension NAME and value, and the name field refreshes the table on every
 * keystroke. So typing one character into "צבע" rebuilt the grid under keys nothing matched, every
 * per-combo count went blank in front of the seller, and saving from there put the whole product
 * back on one shared pool — 5 red and 5 blue becoming 10 units any combo could sell. The counts are
 * followed through the rename instead; the same rule keeps the per-combo SKUs (and with them the
 * link to the seller's own inventory system) attached on the server side.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {} unobserve(): void {} disconnect(): void {}
};

function renderEditor(): HTMLFormElement {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <form>
      <input name="stock" value="10">
      <div class="field variants-editor" data-variants-editor>
        <div class="variant-dims" data-variant-dims></div>
        <div class="variant-combos" data-variant-combos hidden>
          <p data-variant-combo-hint hidden></p>
          <table><thead data-variant-combo-thead></thead><tbody data-variant-combo-rows></tbody><tfoot data-variant-combo-tfoot></tfoot></table>
        </div>
      </div>
    </form>`;
  const form = document.querySelector('form')!;
  applyVariantsPayload(form, {
    variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }],
    variantStock: {
      [comboKey({ צבע: 'אדום', מידה: 'S' })]: 5,
      [comboKey({ צבע: 'אדום', מידה: 'L' })]: 1,
      [comboKey({ צבע: 'כחול', מידה: 'S' })]: 4,
      [comboKey({ צבע: 'כחול', מידה: 'L' })]: 0,
    },
    variantImages: {},
  }, 10);
  return form;
}

function typeDimName(form: HTMLFormElement, index: number, value: string): void {
  const input = [...form.querySelectorAll<HTMLInputElement>('[data-dim-name]')][index]!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeAll(() => { initVariantEditors(); });

let form: HTMLFormElement;
beforeEach(() => { form = renderEditor(); });

describe('renaming a variant dimension in the product form', () => {
  it('keeps every per-combo count, under the new name', () => {
    typeDimName(form, 0, 'Color');

    const { variants, variantStock } = collectVariantsPayload(form);
    expect(variants[0]!.name).toBe('Color');
    expect(variantStock).toEqual({
      [comboKey({ Color: 'אדום', מידה: 'S' })]: 5,
      [comboKey({ Color: 'אדום', מידה: 'L' })]: 1,
      [comboKey({ Color: 'כחול', מידה: 'S' })]: 4,
      [comboKey({ Color: 'כחול', מידה: 'L' })]: 0,
    });
  });

  it('survives the keystroke-by-keystroke path, not just the finished word', () => {
    // The handler runs on `input`, so a seller typing "Color" moves the keys five times over.
    for (const partial of ['C', 'Co', 'Col', 'Colo', 'Color']) typeDimName(form, 0, partial);

    const { variantStock } = collectVariantsPayload(form);
    expect(Object.values(variantStock).sort()).toEqual([0, 1, 4, 5]);
    expect(variantStock[comboKey({ Color: 'אדום', מידה: 'S' })]).toBe(5);
  });

  it('leaves the counts alone when the edit is not a relabel at all', () => {
    // Adding an option is a real structural change: the old keys still name real combos (the
    // dimension's name did not move), so they keep their counts and the new combo arrives blank,
    // on the shared pool — the "no invented defaults" rule, unchanged by any of this.
    typeDimName(form, 0, 'צבע'); // a no-op edit, to prove the remap does not fire on every refresh

    const { variantStock } = collectVariantsPayload(form);
    expect(variantStock[comboKey({ צבע: 'אדום', מידה: 'S' })]).toBe(5);
    expect(variantStock[comboKey({ צבע: 'כחול', מידה: 'L' })]).toBe(0);
  });
});
