// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_VARIANT_COMBOS } from '../src/lib/variant-combo.js';
import { CSV_MAX_DIMENSIONS } from '../src/lib/csv-bulk.js';
import { applyVariantsPayload, initVariantEditors } from '../src/scripts/dashboard/products.js';

/**
 * **Both variant limits have to be visible while the seller is building the set** (owner,
 * 2026-08-19: *"זה צריך להיות ברור ליוזר"*).
 *
 * Neither was. Over 200 combinations the save was refused with a message nobody saw coming; past
 * three variant types the product silently stopped being expressible in a file, which the seller
 * only discovered as an import error — possibly weeks later, on the sync they had come to rely on.
 * Both are now stated on the spot, and only while they apply.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {} unobserve(): void {} disconnect(): void {}
};

function renderEditor(variants: Array<{ name: string; options: string[] }>): HTMLElement {
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
  applyVariantsPayload(form, { variants, variantStock: {}, variantSku: {}, variantImages: {} }, 10);
  // applyVariantsPayload replaces the editor node, and the note is rebuilt with it.
  const editor = form.querySelector<HTMLElement>('[data-variants-editor]')!;
  // Nudge the editor through its own refresh, the way any edit to a dimension does.
  editor.querySelector<HTMLInputElement>('[data-dim-name]')?.dispatchEvent(new Event('input', { bubbles: true }));
  return editor;
}

const note = (editor: HTMLElement) => editor.querySelector<HTMLElement>('[data-variant-limit-note]')!;
const values = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

beforeAll(() => { initVariantEditors(); });
beforeEach(() => { document.body.innerHTML = ''; });

describe('the variant limits, said on the spot', () => {
  it('says nothing at all about an ordinary product', () => {
    const editor = renderEditor([{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }]);
    expect(note(editor).hidden).toBe(true);
  });

  it('names what a fourth variant type costs — the file, and the sync with it', () => {
    const editor = renderEditor([
      { name: 'צבע', options: ['אדום'] }, { name: 'מידה', options: ['S'] },
      { name: 'חומר', options: ['עץ'] }, { name: 'נפח', options: ['1L'] },
    ]);
    expect(note(editor).hidden).toBe(false);
    expect(note(editor).textContent).toContain(String(CSV_MAX_DIMENSIONS));
    // The wording has to name the consequence, not the rule — a seller does not know what
    // "3 dimensions" means until it is spelled as "a file cannot update this".
    expect(note(editor).textContent!.length).toBeGreaterThan(20);
  });

  it('refuses the combo limit before the save does, with the count in it', () => {
    // 15 × 15 = 225 combinations, from 30 typed values.
    const editor = renderEditor([
      { name: 'צבע', options: values(15, 'c') },
      { name: 'מידה', options: values(15, 's') },
    ]);
    expect(note(editor).hidden).toBe(false);
    expect(note(editor).textContent).toContain('225');
    expect(note(editor).textContent).toContain(String(MAX_VARIANT_COMBOS));
  });

  it('does not expand 225 rows to say so', () => {
    // The expansion is what the limit exists to prevent, and here it would run on the seller's own
    // machine on every keystroke. The table is left as it was — never emptied, or the counts
    // already typed into it would go with it.
    const editor = renderEditor([
      { name: 'צבע', options: values(15, 'c') },
      { name: 'מידה', options: values(15, 's') },
    ]);
    expect(editor.querySelectorAll('[data-variant-combo-row]').length).toBeLessThan(MAX_VARIANT_COMBOS);
  });
});
