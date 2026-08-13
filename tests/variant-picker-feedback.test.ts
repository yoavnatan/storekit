import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Choose a size first" has to be VISIBLE, wherever the picker is rendered.
 *
 * **The bug this pins (owner reported it, 2026-08-12).** The shake-and-ring feedback was defined
 * twice — `.product-detail-page .variant-group--invalid` in product.css and
 * `.store-page .variant-group--invalid` in store.css — each hung off a page wrapper.
 * `StoreProductModal` renders from `BaseLayout`, so its markup sits inside NEITHER wrapper and
 * matched no rule at all.
 *
 * The consequence was not a missing animation. `pmFlagMissingVariants()` adds the class, finds
 * groups, and returns `true` — which makes the click handler `return` before adding. So a buyer who
 * had not chosen a size pressed "הוסף לעגלה" and the site did nothing at all: no item, no message,
 * no movement. Every piece was individually correct, which is why it survived — the JS was right,
 * both CSS rules were right, and only the JOIN between them was wrong.
 *
 * Both page sheets are imported into main.css, so the page prefix never controlled loading; it only
 * decided which ancestors matched. Hence: one definition, and no ancestor in the selector.
 */

const STYLES = join(process.cwd(), 'src', 'styles');
const allCss = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allCss(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);

const SHEETS = allCss(STYLES).map((f) => ({ file: f, css: readFileSync(f, 'utf8') }));

describe('the missing-variant feedback reaches the modal', () => {
  it('is defined in exactly one stylesheet', () => {
    // The duplication IS the bug — two copies is how each one ended up scoped to a different page
    // and neither to the modal. File names are in the failure message so a second copy names itself.
    const definers = SHEETS.filter((s) => s.css.includes('.variant-group--invalid'));
    expect(definers.map((d) => d.file.replace(STYLES, ''))).toHaveLength(1);
  });

  it('is not scoped to any page wrapper', () => {
    // A page-ancestor prefix is exactly what excluded the modal. `.store-page`/`.product-detail-page`
    // are the two that did it; the assertion is written against the SHAPE so a third wrapper cannot
    // reintroduce it under a new name.
    for (const { css } of SHEETS) {
      const rules = css.match(/^[^\n@}]*\.variant-group--invalid[^\n{]*\{/gm) ?? [];
      for (const rule of rules) {
        expect(rule.trim().startsWith('.variant-group--invalid')).toBe(true);
      }
    }
  });

  it('has one set of keyframes, not one per page sheet', () => {
    const withKeyframes = SHEETS.filter((s) => /@keyframes\s+variant-shake/.test(s.css));
    expect(withKeyframes).toHaveLength(1);
  });

  it('both pickers still ask for the feedback before adding to the cart', () => {
    const modal = readFileSync(join(process.cwd(), 'src/components/StoreProductModal.astro'), 'utf8');
    const page = readFileSync(join(process.cwd(), 'src/pages/[storeSlug]/[productSlug].astro'), 'utf8');
    expect(modal).toMatch(/if \(pmVariants\.length && pmFlagMissingVariants\(\)\) return;/);
    expect(page).toMatch(/if \(pageVariants\.length && flagMissingVariants\(\)\) return;/);
  });

  it('the modal really is rendered outside the page wrappers — which is why scoping cannot return', () => {
    // Stated as a test rather than a comment: if the modal is ever moved back inside a page, the
    // rules above stop being load-bearing and someone should re-read them deliberately.
    expect(readFileSync(join(process.cwd(), 'src/layouts/BaseLayout.astro'), 'utf8')).toContain('<StoreProductModal />');
  });
});
