/**
 * The store page's client renderers read their strings from ONE payload, and every string they
 * read has to be in it.
 *
 * `[storeSlug]/index.astro` renders the same things twice — product cards, the category nav, the
 * attribute filter menu — once in Astro for the first paint and once in JavaScript for every
 * change after it. The Astro half reads `t.store.*` directly; the JS half can only see what the
 * `pmI18n` object put into the `#pm-i18n` island. A key that exists in `translations.ts` and not in
 * that object therefore renders correctly from the server and turns into an empty string on the
 * first re-render, which is exactly what happened to "נקה סינון" on 2026-08-20: it drew fine, and
 * became a 0×0 link the moment a chip was clicked.
 *
 * That is the whole failure mode — no error, no warning, a control that is simply not there any
 * more — and it is the store-page instance of memory `project_client_renderer_i18n_drift`. Nothing
 * guarded it: `i18n-island-scope.test.ts` watches the DASHBOARD island, which is a different
 * payload with a different problem (its size).
 *
 * Asserted on the source rather than in a browser: the question is whether one object literal
 * covers a set of property reads, and a rendered page can only ever answer it for the strings that
 * particular render happened to need.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../src/pages/[storeSlug]/index.astro', import.meta.url)), 'utf8');

/** The keys `pmI18n` actually ships to the island. */
function shippedKeys(): Set<string> {
  const start = SRC.indexOf('const pmI18n = {');
  expect(start, 'pmI18n has been renamed — this guard is now watching nothing').toBeGreaterThan(-1);
  // To the closing brace of the literal, matched by depth so a nested object cannot end it early.
  let depth = 0;
  let end = start;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = SRC.slice(start, end);
  return new Set([...body.matchAll(/^\s{2}([A-Za-z]\w*):/gm)].map((m) => m[1]!));
}

/** Every `i18n.foo` / `i18n?.foo` the client script reads. `getPMI18n()` is the only producer of a
 *  variable called `i18n` in this file, so the name is an exact selector. */
function readKeys(): Set<string> {
  return new Set([...SRC.matchAll(/\bi18n\??\.([A-Za-z]\w*)/g)].map((m) => m[1]!));
}

describe('the store page ships every string its own JS reads', () => {
  it('finds both sides, so a rename cannot make this pass by finding nothing', () => {
    expect(shippedKeys().size).toBeGreaterThan(10);
    expect(readKeys().size).toBeGreaterThan(5);
  });

  it('has no key read from the island that the island never carried', () => {
    const shipped = shippedKeys();
    const missing = [...readKeys()].filter((k) => !shipped.has(k));
    expect(
      missing,
      'these are read by a client renderer in [storeSlug]/index.astro but are not in `pmI18n`, so '
      + 'they render from the server and vanish on the first re-render. Add them to the pmI18n '
      + 'object beside the strings already there.',
    ).toEqual([]);
  });
});
