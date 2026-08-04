/**
 * `content-visibility: auto` carries PAINT CONTAINMENT, and paint containment clips descendants.
 *
 * **Why this is a test and not a comment.** The store grid's product card has had
 * `content-visibility: auto` since the grid grew a "load more" — a real scroll-perf win. The comment
 * on that rule says the hover shadow is unaffected, and it is: the shadow belongs to the CARD, and
 * an element's own outset shadow is never clipped by its own containment. What the comment does not
 * cover is a DESCENDANT's outset paint, and there is one — the global focus ring is
 * `outline: 2px; outline-offset: 2px` (base/reset.css), drawn entirely OUTSIDE its element, and the
 * card's image wrap is a `role="button" tabindex="0"` spanning the card's full width. A keyboard
 * user tabbing to it got a ring sliced off flat on both sides. Found 2026-08-04.
 *
 * The trap is invisible in the CSS that causes it and only shows up in a state no build step
 * exercises, so: any rule that turns `content-visibility: auto` on must hand it back on
 * `:focus-within`. The same applies to `:hover` the moment a hover shadow is moved onto a child of
 * the contained element — this guard cannot see that, so it is written here instead.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const STYLES = path.join(process.cwd(), 'src/styles');

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(full);
    return e.name.endsWith('.css') ? [full] : [];
  });
}

/** Selectors that declare `content-visibility: auto`, per file. */
function containedSelectors(css: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (/content-visibility\s*:\s*auto/.test(match[2]!)) out.push(selector);
  }
  return out;
}

/** Does the file release containment for `selector` on `state`? */
function releasedOn(css: string, selector: string, state: string): boolean {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/content-visibility\s*:\s*visible/.test(match[2]!)) continue;
    // A comma-separated rule counts if ANY of its selectors is this one plus the state.
    if (sel.split(',').some((s) => s.trim() === `${selector}${state}`)) return true;
  }
  return false;
}

interface Offence { file: string; selector: string; missing: string[] }

function findOffences(): Offence[] {
  const out: Offence[] = [];
  for (const file of cssFiles(STYLES)) {
    const css = fs.readFileSync(file, 'utf8');
    for (const selector of containedSelectors(css)) {
      const missing = [':focus-within'].filter((state) => !releasedOn(css, selector, state));
      if (missing.length) out.push({ file: path.relative(process.cwd(), file), selector, missing });
    }
  }
  return out;
}

describe('content-visibility: auto must not clip a descendant focus ring', () => {
  it('every contained selector hands containment back on :focus-within', () => {
    const offences = findOffences();
    expect(
      offences,
      offences.length
        ? `content-visibility: auto applies paint containment at all times (only the SIZE containment is\n` +
          `dropped once the element is on screen), and paint containment clips descendants to the padding\n` +
          `box — so a descendant's hover shadow and the global focus ring (outline-offset: 2px, drawn\n` +
          `outside its element) get sliced off flat. Add a { content-visibility: visible } rule for the\n` +
          `missing states:\n${offences.map((o) => `  ${o.file}  ${o.selector}  missing: ${o.missing.join(' ')}`).join('\n')}`
        : '',
    ).toEqual([]);
  });

  it('actually looks at the files, and would catch a regression', () => {
    // A guard that silently matched nothing would pass for ever, so: it read real files, it finds
    // the one real user of this property, and its matcher recognises both halves of the pattern.
    expect(cssFiles(STYLES).length).toBeGreaterThan(10);
    expect(findOffences()).toEqual([]);

    const store = fs.readFileSync(path.join(STYLES, 'pages/store.css'), 'utf8');
    expect(containedSelectors(store)).toContain('.product-grid > .product-card');

    const broken = '.x { content-visibility: auto; }';
    expect(containedSelectors(broken)).toEqual(['.x']);
    expect(releasedOn(broken, '.x', ':hover')).toBe(false);
    expect(releasedOn('.x:hover, .x:focus-within { content-visibility: visible; }', '.x', ':focus-within')).toBe(true);
  });
});
