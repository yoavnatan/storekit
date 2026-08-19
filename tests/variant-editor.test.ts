// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { comboKey, MAX_VARIANT_COMBOS } from '../src/lib/variant-combo.js';
import { CSV_MAX_DIMENSIONS } from '../src/lib/csv-bulk.js';
import { applyVariantsPayload, collectVariantsPayload, initVariantEditors } from '../src/scripts/dashboard/products.js';

/**
 * The product form's variants editor — the table where a seller builds combinations, counts them,
 * and names them for their own inventory system.
 *
 * **One file, and that is deliberate.** These three subjects arrived as three files on 2026-08-19,
 * which cost three jsdom environments (~2–4s each) for one component. `@vitest-environment jsdom`
 * is per FILE, so the way to stop paying that is to keep one file per component, not per bug. 39 of
 * this suite's files boot jsdom; the ones that could be merged are pure waste on every run, in every
 * parallel session.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {} unobserve(): void {} disconnect(): void {}
};

const S = comboKey({ מידה: 'S' });
const M = comboKey({ מידה: 'M' });

/** The editor's own markup, as the dashboard ships it, with a payload applied. */
function renderEditor(
  variants: Array<{ name: string; options: string[] }>,
  variantStock: Record<string, number> = {},
  variantSku: Record<string, string> = {},
  currentStock = 10,
): HTMLFormElement {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">{"dashboard":{},"gallery":{}}</script>
    <form>
      <input name="stock" value="${currentStock}">
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
  applyVariantsPayload(form, { variants, variantStock, variantSku, variantImages: {} }, currentStock);
  return form;
}

const editorOf = (form: HTMLFormElement) => form.querySelector<HTMLElement>('[data-variants-editor]')!;
const noteOf = (form: HTMLFormElement) => editorOf(form).querySelector<HTMLElement>('[data-variant-limit-note]')!;
const skuInput = (form: HTMLFormElement, key: string) =>
  form.querySelector<HTMLInputElement>(`[data-combo-key="${key}"] [data-combo-sku]`)!;
const values = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** Type into the dimension NAME field — the path that refreshes the whole table on every keystroke. */
function typeDimName(form: HTMLFormElement, index: number, value: string): void {
  const input = [...form.querySelectorAll<HTMLInputElement>('[data-dim-name]')][index]!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Nudge a freshly rendered editor through its own refresh, the way any edit to a dimension does. */
function touchEditor(form: HTMLFormElement): void {
  form.querySelector<HTMLInputElement>('[data-dim-name]')?.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeAll(() => { initVariantEditors(); });
beforeEach(() => { document.body.innerHTML = ''; });

/**
 * **Relabelling a dimension must not empty the stock table** (found 2026-08-19, external-sync audit).
 *
 * A combo is keyed by its dimension NAME and value, and the name field refreshes the table on every
 * keystroke. So typing one character into "צבע" rebuilt the grid under keys nothing matched, every
 * per-combo count went blank in front of the seller, and saving from there put the whole product
 * back on one shared pool — 5 red and 5 blue becoming 10 units any combo could sell.
 */
describe('renaming a variant dimension', () => {
  const twoByTwo = () => renderEditor(
    [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }],
    {
      [comboKey({ צבע: 'אדום', מידה: 'S' })]: 5,
      [comboKey({ צבע: 'אדום', מידה: 'L' })]: 1,
      [comboKey({ צבע: 'כחול', מידה: 'S' })]: 4,
      [comboKey({ צבע: 'כחול', מידה: 'L' })]: 0,
    },
  );

  it('keeps every per-combo count, under the new name', () => {
    const form = twoByTwo();
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
    const form = twoByTwo();
    for (const partial of ['C', 'Co', 'Col', 'Colo', 'Color']) typeDimName(form, 0, partial);

    const { variantStock } = collectVariantsPayload(form);
    expect(Object.values(variantStock).sort()).toEqual([0, 1, 4, 5]);
    expect(variantStock[comboKey({ Color: 'אדום', מידה: 'S' })]).toBe(5);
  });

  it('leaves the counts alone when the edit is not a relabel at all', () => {
    const form = twoByTwo();
    typeDimName(form, 0, 'צבע'); // a no-op edit, to prove the remap does not fire on every refresh

    const { variantStock } = collectVariantsPayload(form);
    expect(variantStock[comboKey({ צבע: 'אדום', מידה: 'S' })]).toBe(5);
    expect(variantStock[comboKey({ צבע: 'כחול', מידה: 'L' })]).toBe(0);
  });
});

/**
 * **Both variant limits have to be visible while the set is being built** (owner, 2026-08-19: *"זה
 * צריך להיות ברור ליוזר"*). Over the combo cap the save was simply refused, with a message nobody
 * saw coming; past three variant types the product quietly stopped being expressible in a file,
 * which the seller met as an import error weeks later, on a sync they had come to rely on.
 */
describe('the variant limits, said on the spot', () => {
  it('says nothing at all about an ordinary product', () => {
    const form = renderEditor([{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }]);
    touchEditor(form);
    expect(noteOf(form).hidden).toBe(true);
  });

  it('names the fourth variant type\'s consequence, with the bound derived and not typed', () => {
    const form = renderEditor([
      { name: 'צבע', options: ['אדום'] }, { name: 'מידה', options: ['S'] },
      { name: 'חומר', options: ['עץ'] }, { name: 'נפח', options: ['1L'] },
    ]);
    touchEditor(form);
    expect(noteOf(form).hidden).toBe(false);
    expect(noteOf(form).textContent).toContain(String(CSV_MAX_DIMENSIONS));
    // The wording names what the seller can DO about it, not the rule that produced it.
    expect(noteOf(form).textContent!.length).toBeGreaterThan(20);
  });

  it('refuses the combo limit before the save does — and quotes no arithmetic at the seller', () => {
    // 15 × 15 = 225 combinations, from 30 typed values.
    const form = renderEditor([
      { name: 'צבע', options: values(15, 'c') },
      { name: 'מידה', options: values(15, 's') },
    ]);
    touchEditor(form);
    expect(noteOf(form).hidden).toBe(false);
    // Neither the count nor the cap: both are the code's own multiplication, and a seller cannot
    // count their way down to a number. The note says what to do instead.
    expect(noteOf(form).textContent).not.toContain('225');
    expect(noteOf(form).textContent).not.toContain(String(MAX_VARIANT_COMBOS));
    expect(noteOf(form).textContent!.length).toBeGreaterThan(10);
  });

  it('does not expand 225 rows to say so', () => {
    // The expansion is what the limit exists to prevent, and here it would run on the seller's own
    // machine on every keystroke.
    const form = renderEditor([
      { name: 'צבע', options: values(15, 'c') },
      { name: 'מידה', options: values(15, 's') },
    ]);
    touchEditor(form);
    expect(editorOf(form).querySelectorAll('[data-variant-combo-row]').length).toBeLessThan(MAX_VARIANT_COMBOS);
  });
});

/**
 * The per-combination code, as the seller actually meets it: a column in the combo table. It is what
 * an external inventory feed matches its rows on (`variant-sku-match.ts`), and until 2026-08-19 it
 * could only be set through the CSV round-trip.
 */
describe('the SKU column in the combo table', () => {
  const shirt = (sku: Record<string, string> = {}) =>
    renderEditor([{ name: 'מידה', options: ['S', 'M'] }], { [S]: 3, [M]: 4 }, sku, 7);

  it('shows the codes the product already has', () => {
    const form = shirt({ [S]: 'SH-S' });
    expect(skuInput(form, S).value).toBe('SH-S');
    expect(skuInput(form, M).value, 'a combo with no code shows an empty box').toBe('');
  });

  it('sends what the seller typed, and leaves the blank ones out entirely', () => {
    const form = shirt();
    skuInput(form, S).value = '  SH-S  ';

    const { variantSku } = collectVariantsPayload(form);
    // Trimmed, and M is absent rather than '' — no code is a real answer.
    expect(variantSku).toEqual({ [S]: 'SH-S' });
  });

  it('carries the codes through a relabelled dimension, like the counts beside them', () => {
    const form = shirt({ [S]: 'SH-S', [M]: 'SH-M' });
    typeDimName(form, 0, 'Size');

    const { variantSku, variantStock } = collectVariantsPayload(form);
    expect(variantSku).toEqual({
      [comboKey({ Size: 'S' })]: 'SH-S',
      [comboKey({ Size: 'M' })]: 'SH-M',
    });
    expect(variantStock[comboKey({ Size: 'S' })], 'and the stock still rides along too').toBe(3);
  });
});
