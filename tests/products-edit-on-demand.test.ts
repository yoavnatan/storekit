import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Products tab's edit forms are built on the click that opens one (2026-08-11).
 *
 * Measured before the change: 43KB of markup per product, 58% of that tab's whole response, for
 * forms nothing could reach without JavaScript — the edit control is a scripted menu item. The page
 * now ships an empty row plus a small product island, and `products.ts#buildEditRow` fills it.
 *
 * Every way this can break is silent, which is why it is pinned here rather than trusted:
 *  · the row opens EMPTY (the bug that actually happened — see the `hasAttribute` case below);
 *  · the island and the API drift, so a form opened on the first paint differs from one opened
 *    after a filter change;
 *  · the island goes stale under an in-place edit, and saving the form puts the old value back.
 */

const ROOT = process.cwd();
const PAGE = path.join(ROOT, 'src/pages/seller/dashboard.astro');
const CLIENT = path.join(ROOT, 'src/scripts/dashboard/products.ts');
const PROMOS = path.join(ROOT, 'src/scripts/dashboard/promotions.ts');
const API = path.join(ROOT, 'src/pages/api/seller/products.ts');

const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('the page ships a pending row and an island, not ten forms', () => {
  const page = read(PAGE);

  it('renders the edit row EMPTY and marked pending', () => {
    expect(page).toContain('<tr class="edit-row" data-product-edit={p.id} data-edit-pending hidden></tr>');
  });

  it('no longer renders any of the edit form', () => {
    // The three heaviest pieces, and the ones whose absence proves the per-product form is gone:
    // the variant/stock editor, the per-product SEO panel, and a gallery holding a product's own
    // images. `productSeoInputFrom` reads a real product, so its absence is the whole test.
    expect(page).not.toContain('data-combo-stock-input');
    expect(page).not.toContain('productSeoInputFrom(');
    // The ADD form is still server-rendered — ONE form, not one per product, and it is the only
    // reason a gallery and a SEO panel appear here at all. Both start from nothing, which is what
    // these two assertions say: an empty gallery and the empty-product SEO input.
    const galleries = [...page.matchAll(/galleryWidgetHtml\(([^,]*),/g)].map((m) => m[1]!.trim());
    expect(galleries, 'only the add form, and it starts empty').toEqual(['[]']);
    expect(page).toContain('productSeoPanelHtml(EMPTY_PRODUCT_SEO');
  });

  it('ships the island through jsonForScript, never a bare stringify', () => {
    // A product NAME is free text. `</script>` inside one would end the element early and put the
    // rest of the catalogue into the page as markup (lib/json-script.ts).
    expect(page).toMatch(/id="dash-products-page" set:html=\{jsonForScript\(/);
  });
});

describe('one row shape, two producers', () => {
  it('both the island and the API build it with toSellerProductRow', () => {
    // A form opened on the first paint and one opened after a filter change are the same form only
    // if the objects behind them are the same object.
    expect(read(PAGE)).toContain('toSellerProductRow(p, {');
    expect(read(API)).toContain('toSellerProductRow(p, {');
  });
});

describe('the builder', () => {
  const client = read(CLIENT);

  it('reads the pending marker with hasAttribute, never through dataset', () => {
    // THE BUG, caught in a browser and not by any test: the server writes a bare
    // `data-edit-pending`, so `dataset.editPending` is `''` — falsy. `if (!row.dataset.editPending)`
    // therefore returned early every single time and the form opened empty, with no error anywhere.
    expect(client).toContain("row.hasAttribute('data-edit-pending')");
    // Comment lines are allowed to name it — that is where the trap is written down.
    const inCode = client.split('\n').filter((l) => l.includes('dataset.editPending') && !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(inCode, 'read the marker with hasAttribute — dataset gives "" for a valueless attribute').toEqual([]);
  });

  it('is reached by EVERY path that opens a row', () => {
    // The row menu's "ערוך" and the toolbar's bulk-edit toggle. A path that set `hidden = false`
    // straight off the DOM would open a placeholder.
    const opens = [...client.matchAll(/ensureEditRow\(/g)];
    expect(opens.length, 'the definition plus one call per opener').toBeGreaterThanOrEqual(3);
    // …and nothing reveals a row without going through it first.
    expect(client).not.toMatch(/editRow\.hidden = false;\s*\n\s*displayRow\.hidden = true/);
  });

  it('hands the new form to the draft guard', () => {
    // The guard scans for forms when the DOCUMENT loads, and this one is built later — so without
    // this the seller's typing in the tab's most-used form would stop being kept, and a crash would
    // lose it with nothing anywhere reporting that it had (project_dashboard_draft_recovery).
    expect(client).toContain('window.__dashScanDrafts?.(built)');
  });

  it('re-queries the row instead of holding the one it replaced', () => {
    // `replaceWith` swaps the element, so a second opener with a stale reference would show the
    // empty node it captured at wiring time.
    expect(client).toMatch(/document\.querySelector<HTMLTableRowElement>\(`\[data-product-edit="\$\{CSS\.escape\(productId\)\}"\]`\)/);
  });
});

describe('the island cannot go stale under the table', () => {
  const client = read(CLIENT);

  it('follows every in-place patch of a display row', () => {
    // The island is a snapshot taken when the document was served. An inline cell edit, a
    // visibility toggle or a per-combo stock change patches the ROW and not the island — so a form
    // built from it afterwards would hold the old value, and saving would put it back. All three go
    // through `syncEditRowRev`, which is why the follow-up hangs off it.
    expect(client).toMatch(/function syncEditRowRev\([\s\S]*?syncPageProductFromRow\(displayRow, rev\)/);
    expect((client.match(/syncEditRowRev\(/g) ?? []).length, 'definition + every mutation site').toBeGreaterThanOrEqual(4);
  });

  it('follows the discount roll-up, which does not go through that seam', () => {
    // promotions.ts#syncProductRow writes `data-discount` and nothing else. Its own comment calls
    // itself the one place that writes a discount everywhere the tab caches it — the island is now
    // one of those places.
    expect(read(PROMOS)).toContain('syncPageProduct(row)');
  });

  it('reads the name from the cell, not from the sort attribute', () => {
    // `data-sort-name` is lower-cased for sorting. Taking it as the product's name would silently
    // rewrite the seller's own capitalisation the next time they saved.
    expect(client).toContain("querySelector<HTMLElement>('.product-name')?.textContent?.trim()");
  });
});
