import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two shared UI recipes landed on 2026-08-10, and both replaced a pair of hand-rolled copies that
 * had drifted apart on screen. A copy is exactly how each of them got there, so each gets a tree
 * scan rather than a note in a header.
 *
 *  1. `.img-badge` — the ONE box the "new" and "on sale" corner marks share (utilities/utils.css).
 *     They used to be two designs, two radii and two type sizes stacked in one 24px corner, one of
 *     them pulsing forever. Anything positioning itself in that corner has to take the box.
 *  2. `.field-error` — the site's replacement for the browser's validation bubble
 *     (lib/field-validity.ts). It is created in exactly one place; a second creator is a second
 *     definition of what a wrong field looks like, which is the state this project already reached
 *     once with SIX focus treatments for one field (see the note on `.input:focus`).
 *
 * fileURLToPath, not `.pathname` — this repo's own directory name is Hebrew and `.pathname` hands
 * back the percent-encoded form, which `readdirSync` cannot open.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|astro)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const rel = (path: string): string => path.slice(SRC.length);

describe('.img-badge is the only box a corner mark may have', () => {
  // Every place that renders one, wherever it renders it from — Astro markup or a client-side
  // template string. `sale-badge` is emitted by lib/price-html.ts for all ~8 price surfaces.
  const MARKS = ['badge--new', 'sale-badge'];

  it('never renders a corner mark without the shared box', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const { path, text } of FILES) {
      // The stylesheet-free half only: a `class="…"` / `class={…}` attribute or a template literal
      // building one. Matching class LISTS, not the bare word, so a comment mentioning the name
      // (there are several, deliberately) is not a hit.
      for (const m of text.matchAll(/class=["'{`]([^"'}`]*)["'}`]/g)) {
        const classes = m[1];
        if (!MARKS.some((mark) => new RegExp(`(^|\\s)${mark}(\\s|$)`).test(classes))) continue;
        seen++;
        if (!/(^|\s)img-badge(\s|$)/.test(classes)) offenders.push(`${rel(path)}: class="${classes}"`);
      }
    }
    expect(offenders).toEqual([]);
    // A scan that matches nothing passes for the wrong reason — the failure mode every guard test
    // in this repo has to rule out about ITSELF. Three "new" chips are rendered today (the store
    // grid twice, server- and client-side, and the product hero).
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('covers the ONE site the markup scan structurally cannot see', () => {
    // Every sale badge on the site — ~8 price surfaces — comes from this one string builder, and it
    // writes `class="${escapeHtml(cls)}"`, so the class list is not in the markup for the scan above
    // to read. It is also the site that actually broke while this recipe was being built: the box
    // class was added to the CSS and to the three Astro call sites, and forgotten here, which
    // renders the badge as unpositioned green text in the middle of the card.
    const priceHtml = readFileSync(fileURLToPath(new URL('../src/lib/price-html.ts', import.meta.url)), 'utf8');
    expect(priceHtml).toMatch(/const cls = `img-badge sale-badge/);
  });

  it('keeps the two marks differing by fill only — neither may re-declare the geometry', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/styles/utilities/utils.css', import.meta.url)), 'utf8');
    const block = (selector: string): string =>
      css.slice(css.indexOf(`\n${selector} {`)).split('}')[0] ?? '';
    // position/top/height/padding/radius/font-size belong to `.img-badge` and nowhere else. A
    // variant re-declaring one is the drift this whole recipe exists to end.
    const GEOMETRY = /(^|\n)\s*(position|top|inset-inline-start|height|padding|border-radius|font-size)\s*:/;
    for (const variant of ['.sale-badge', '.badge--new']) {
      expect(GEOMETRY.test(block(variant)), `${variant} re-declares geometry`).toBe(false);
    }
  });

  it('never puts an endless animation on one — nothing on this site loops forever', () => {
    // `.badge--new` pulsed on a 2.5s `infinite` for months. The rule is site-wide (memory
    // `feedback_no_ambient_looping_motion`); this holds it for the corner marks specifically,
    // where it actually happened.
    const css = readFileSync(fileURLToPath(new URL('../src/styles/utilities/utils.css', import.meta.url)), 'utf8');
    const badgeRules = css.slice(css.indexOf('.img-badge {'), css.indexOf('/* ── Edge fade'));
    expect(badgeRules).not.toMatch(/infinite/);
  });
});

describe('.field-error has exactly one creator', () => {
  it('is only built by lib/field-validity.ts', () => {
    const OWNER = 'lib/field-validity.ts';
    const offenders = FILES.filter(({ path, text }) => {
      if (rel(path).replace(/\\/g, '/') === OWNER) return false;
      // Creating one means naming the class in markup or in a className assignment. A `.field-error`
      // selector (a stylesheet, a querySelector) is not creation.
      return /class(Name)?\s*[=:]\s*["'`][^"'`]*field-error/.test(text) || /["'`]field-error["'`]/.test(text);
    });
    expect(offenders.map(({ path }) => rel(path))).toEqual([]);
    // Same self-check as above: prove the scan can see the owner it is exempting, or it is passing
    // because it matches nothing at all.
    const owner = FILES.find(({ path }) => rel(path).replace(/\\/g, '/') === OWNER);
    expect(owner?.text).toMatch(/['"`]field-error['"`]/);
  });

  it('the owner reports through the shared strings rather than a literal sentence', () => {
    const owner = readFileSync(fileURLToPath(new URL('../src/lib/field-validity.ts', import.meta.url)), 'utf8');
    // The Hebrew fallbacks are deliberate and live in ONE object; a second Hebrew literal anywhere
    // else in the file is a message that would never follow the language toggle.
    const fallbackBlock = owner.slice(owner.indexOf('const FALLBACK'), owner.indexOf('export const FIELD_ERROR_CLASS'));
    const hebrewOutside = owner.replace(fallbackBlock, '').match(/[֐-׿]/g) ?? [];
    expect(hebrewOutside).toEqual([]);
  });
});
