/**
 * A panel's markup and the code that wires it must belong to the SAME panel.
 *
 * **The bug this is made of (2026-08-19).** `#feed-panel` — the whole external-inventory sync — is
 * rendered inside the *products* panel, and `initFeedSync` was called from the *settings* loader.
 * Every `init*` binds elements that must already exist and runs once, so on any ordinary visit the
 * "סנכרון מלאי חיצוני" button did nothing at all: the module that binds it had never been imported.
 * Opening Settings first, in the same page load, happened to fix it — which is exactly why it
 * survived every test, every review and every demo, and why the owner could not try the feature.
 *
 * The dashboard has ~14 of these panel loaders and they are edited constantly, so the property is
 * checked rather than remembered: for each id below, whichever `<SellerPanelShell panel="X">` block
 * renders it must be the block whose loader calls its init. This is the same shape as the
 * category-picker fix already recorded in the page ("bound the pickers of two panels that wire none
 * of their own, so those worked or did not depending on which tab the seller opened first").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');

/** Which panel's markup contains this element id. */
function panelRendering(id: string): string | undefined {
  const at = SRC.indexOf(`id="${id}"`);
  if (at === -1) return undefined;
  const before = SRC.slice(0, at);
  const shells = [...before.matchAll(/<SellerPanelShell panel="([a-z-]+)"/g)];
  return shells.at(-1)?.[1];
}

/** Which panel's LOADER calls this init function. */
function panelWiring(initCall: string): string | undefined {
  const at = SRC.indexOf(initCall);
  if (at === -1) return undefined;
  const before = SRC.slice(0, at);
  const loaders = [...before.matchAll(/^ {4}([a-z]+): async \(\) => \{$/gm)];
  return loaders.at(-1)?.[1];
}

/** id rendered → the init that binds it. Add a row whenever a panel grows a script. */
const PANEL_SCRIPTS: Array<{ id: string; init: string }> = [
  { id: 'feed-panel', init: 'feed.initFeedSync();' },
  { id: 'csv-panel', init: 'csv.initCsvImport();' },
];

describe('a panel wires its own markup', () => {
  for (const { id, init } of PANEL_SCRIPTS) {
    it(`#${id} is wired by the panel that renders it`, () => {
      const rendered = panelRendering(id);
      const wired = panelWiring(init);
      expect(rendered, `#${id} is not inside any SellerPanelShell`).toBeDefined();
      expect(wired, `${init} is not inside any panel loader`).toBeDefined();
      expect(wired, `#${id} is rendered by "${rendered}" but wired by "${wired}" — on a visit that opens "${rendered}" first, nothing binds it`).toBe(rendered);
    });

    it(`#${id} is wired exactly once — a second init answers every click twice`, () => {
      expect(SRC.split(init).length - 1, `${init} appears more than once`).toBe(1);
    });
  }
});
