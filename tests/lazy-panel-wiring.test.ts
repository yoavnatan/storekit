import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A control that arrives with a lazily-loaded panel must be wired by THAT panel's own chunk.
 *
 * **The failure, reported by the owner on 2026-08-15: the sale's category menu "לא נותן לי לפתוח
 * בכלל".** The seller dashboard renders one panel per request and fetches the other nine on the
 * click that opens them (`SellerPanelShell` → `data-lazy`). The category pickers were bound by a
 * single `document.querySelectorAll('.category-picker')` sweep that ran when the PRODUCTS chunk
 * loaded — so the picker in Promotions was wired only if the seller had already opened Products,
 * and in the ordinary order nobody had. The trigger was a dead button. The boost picker in
 * Advertising had exactly the same hole, and nobody had reported it.
 *
 * **Why no test could have caught it before, and what this one does instead.** Every part was
 * correct on its own: the picker binds fine, the panel loads fine, the sweep runs fine. Only the
 * JOIN was wrong, and its symptom is silence — no error, no console line, nothing rendered
 * incorrectly. So this pins the RULE rather than the two call sites: a panel-scoped selector, and
 * every panel that ships a picker wiring it from its own module.
 *
 * The map below is deliberately exhaustive rather than a list of the two that were broken: a file
 * that grows a picker and is not in it fails here until someone decides which chunk wires it. That
 * is the whole point — the bug was an omission, and an allowlist that only names known files
 * cannot catch the next omission.
 */

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

/** Every file that renders a picker → the module that must bind it. */
const PICKER_OWNERS: Record<string, string> = {
  // The add-product form and each product row; the products chunk binds the panel, and
  // products.ts binds a row it rebuilds itself.
  'pages/seller/dashboard.astro': "picker.bindCategoryPickersIn('dash-panel-products')",
  'components/dashboard/PromotionsPanel.astro': "bindCategoryPickersIn('dash-panel-promotions')",
  'components/dashboard/BoostFormFields.astro': "bindCategoryPickersIn('dash-panel-advertising')",
};

/** Where the binding call has to appear for each of those. */
const BINDER_OF: Record<string, string> = {
  'pages/seller/dashboard.astro': 'pages/seller/dashboard.astro',
  'components/dashboard/PromotionsPanel.astro': 'scripts/dashboard/promotions.ts',
  'components/dashboard/BoostFormFields.astro': 'scripts/dashboard/advertising.ts',
};

function astroFilesWithPickers(): string[] {
  const hits: string[] = [];
  (function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.astro')) continue;
      if (readFileSync(full, 'utf8').includes('data-category-picker')) {
        hits.push(full.slice(SRC.length + 1));
      }
    }
  })(SRC);
  return hits;
}

describe('every category picker is bound by the chunk that ships it', () => {
  it('no file renders one without an owner', () => {
    // A new picker in a new panel lands here first, before a seller finds it as a dead button.
    expect(astroFilesWithPickers().sort()).toEqual(Object.keys(PICKER_OWNERS).sort());
  });

  for (const [file, call] of Object.entries(PICKER_OWNERS)) {
    it(`${file} is wired by ${BINDER_OF[file]}`, () => {
      expect(read(BINDER_OF[file])).toContain(call);
    });
  }

  it('the admin per-store view binds the boost picker itself', () => {
    // It renders `BoostFormFields` outside any dashboard shell and shares `advertising.ts`, where
    // the panel-scoped call correctly finds nothing. Its own sweep is therefore load-bearing, and
    // is safe there for the reason it was not in the dashboard: that page is one document, fully
    // rendered before its script runs.
    expect(read('pages/admin/store/[slug]/advertising.astro')).toContain('forEach(initCategoryPicker)');
  });
});

describe('element sweeps in the dashboard are panel-scoped', () => {
  const DASH = read('pages/seller/dashboard.astro');

  it('binds no widget class across the whole document', () => {
    // `document.querySelectorAll('.thing').forEach(init)` is the shape that broke: it binds
    // whatever has arrived so far, so a panel works or does not depending on the order the seller
    // opened the tabs in. Every such sweep names the panel it belongs to.
    const sweeps = [...DASH.matchAll(/document\.querySelectorAll<[^>]*>\('([^']+)'\)/g)].map((m) => m[1]);
    const unscoped = sweeps.filter((sel) => sel.startsWith('.') && !sel.includes('#dash-panel-'));
    expect(unscoped, `unscoped widget sweeps: ${unscoped.join(', ')}`).toEqual([]);
  });

  it('the helper refuses to bind when its panel is absent', () => {
    // The admin's per-store advertising page shares advertising.ts and has no dashboard shells;
    // falling back to `document` there would re-create the document-wide sweep this replaced.
    const src = read('scripts/dashboard/category-picker.ts');
    expect(src).toMatch(/document\.getElementById\(panelId\)\s*\n?\s*\?\./);
    expect(src).not.toMatch(/getElementById\(panelId\)\s*\?\?\s*document/);
  });
});
