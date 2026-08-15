/**
 * Data a CLIENT renderer needs belongs to the page, not to the panel that happens to edit it.
 *
 * ## The bug
 *
 * The seller dashboard embeds its store's category tree as a JSON island, and it sat inside the
 * SETTINGS panel — next to the tree editor that owns it, which read as the obvious place. That was
 * true until 2026-08-11, when panels stopped being server-rendered and started arriving one fetch
 * at a time. From then on, a seller who never opened Settings had no tree in the document at all:
 * `getCategoryTree()` returned `[]`, and every client renderer that turns a `categoryId` back into
 * a readable path silently resolved a real category to nothing.
 *
 * The owner hit it as "the edit form says ללא קטגוריה for a product that has one" (2026-08-15), but
 * the same emptiness was in the products table's category chip on every row the client REBUILT —
 * i.e. after any page change, filter or sort — while page one looked right because the server had
 * rendered it. Each half was correct on its own; only the join was wrong, and no diff contained it
 * because the island had not moved, the panels had.
 *
 * ## What this test holds
 *
 * An island read by a module that runs OUTSIDE the panel it sits in must not sit in a panel at all.
 * It is expressed as a small map rather than a scan, because the general question — "which module
 * runs when this markup exists?" — needs a call graph, and a guard that guesses it would be one
 * more thing to disbelieve. What the map buys is that adding an island is a decision: the test
 * names every one in the file, so a new one fails here until somebody says which side it is on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');

/** Where the panels begin. Everything before this is in the page shell and always present. */
const FIRST_PANEL = SRC.indexOf('<SellerPanelShell');

/** Inside a panel = more panel OPENINGS than closings before this point. Depth, not "after the
 *  first one" — several of these islands sit BETWEEN two panels, which is still the page shell. */
function insidePanel(at: number): boolean {
  const head = SRC.slice(0, at);
  const opens = head.split('<SellerPanelShell').length - 1;
  const closes = head.split('</SellerPanelShell>').length - 1;
  return opens > closes;
}

/** Every `<script type="application/json" id="…">` in the file, with where it sits. */
function islands(): { id: string; inPanel: boolean }[] {
  const out: { id: string; inPanel: boolean }[] = [];
  for (const m of SRC.matchAll(/<script[^>]*type="application\/json"[^>]*id="([^"]+)"/g)) {
    out.push({ id: m[1]!, inPanel: insidePanel(m.index) });
  }
  return out;
}

/**
 * `false` = must be in the page shell, because something outside its panel reads it.
 * `true`  = may live in a panel, because only that panel's own wiring reads it, and that wiring
 *           runs after the panel's markup has arrived.
 */
const MAY_LIVE_IN_A_PANEL: Record<string, boolean> = {
  // Read by the products table's chip/filter/sort AND by the category picker in a product's edit
  // form — none of which is the settings panel it used to live in.
  'category-tree-data': false,
  // The products on the current page, consumed by the products panel's own row builder.
  'dash-products-page': true,
  // The message tab's filter values, consumed by the message tab.
  'msg-filter-values-data': true,
  // The store's running sale, read by the products panel's row builder — and it already sits in the
  // page shell, between two panels, which is where it has to stay for the same reason as the tree.
  'dash-store-sale': false,
  // The performance tab's first-paint figures, consumed by that tab alone.
  'perf-initial-summary': true,
};

describe('a JSON island is reachable by whoever reads it', () => {
  it('found the panels at all', () => {
    // Guards the guard: a rename of the shell component would put every island "before the panels"
    // and make the rule below vacuous.
    expect(FIRST_PANEL).toBeGreaterThan(0);
    expect(islands().length).toBeGreaterThan(0);
  });

  it('names every island in the file, so a new one cannot be added silently', () => {
    const unknown = islands().map((i) => i.id).filter((id) => !(id in MAY_LIVE_IN_A_PANEL));
    expect(unknown).toEqual([]);
  });

  it('keeps a cross-panel island in the page shell', () => {
    const misplaced = islands()
      .filter((i) => MAY_LIVE_IN_A_PANEL[i.id] === false && i.inPanel)
      .map((i) => i.id);
    expect(misplaced).toEqual([]);
  });
});
