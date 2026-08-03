/**
 * An image container is `--color-surface`, never `--color-bg`.
 *
 * **Why this is a test and not a comment.** A product photo shot on a transparent background shows
 * its container's colour THROUGH the subject, so the page's off-white `--color-bg` reads as "this
 * product has a dirty grey backing" rather than as the page behind it. The rule was found and fixed
 * once on the store page's `.product-card__img-wrap`, again on `.store-card__preview-img-wrap`, and
 * again on `.cart-preview__thumb` — three separate reports of the same defect, each fixed by hand,
 * each leaving behind a comment saying "same rule as the other one".
 *
 * That is precisely the shape this repo treats as the next bug: a rule restated in three files and
 * enforced in none. The next image container someone adds will reach for `--color-bg` too, because
 * it is what the surrounding page uses and because nothing says otherwise until a shopper sees a
 * grey product. So the rule is mechanical now.
 *
 * The placeholder variants are deliberately exempt and named below: a slot with NO image cannot
 * show anything through itself, and it is meant to recede into the page.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const STYLES = path.join(process.cwd(), 'src/styles');

/** Selector fragments that mean "this box has a product photo in it". */
const IMAGE_CONTAINER = /(img-wrap|preview-img|__img\b|__thumb\b|pm-slide|slide__img)/;

/** Boxes that hold no image and therefore have nothing to show through — they are page furniture,
 *  and `--color-bg` is the correct answer for them.
 *
 *  `placeholder` in any spelling: the guard's first run flagged `.product-card__img-placeholder`,
 *  which turned out to be the empty-slot box that renders a 15%-opacity SVG icon INSTEAD of a photo.
 *  Nothing shows through it because nothing is in it, and receding into the page is its whole job —
 *  so the exemption is the BEM modifier form (`--placeholder`) and the element-name form
 *  (`__img-placeholder`) alike. */
const NO_IMAGE_EXEMPT = /(empty|placeholder|:hover|:focus|\.loaded)/;

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(full);
    return e.name.endsWith('.css') ? [full] : [];
  });
}

interface Offence { file: string; selector: string }

function findOffences(): Offence[] {
  const out: Offence[] = [];
  for (const file of cssFiles(STYLES)) {
    const css = fs.readFileSync(file, 'utf8');
    // Selector + its declaration block. Good enough for this codebase's hand-written CSS, and a
    // rule it cannot parse simply is not checked rather than falsely failing.
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const body = match[2]!;
      if (!IMAGE_CONTAINER.test(selector) || NO_IMAGE_EXEMPT.test(selector)) continue;
      if (/background(-color)?\s*:\s*var\(--color-bg\)/.test(body)) {
        out.push({ file: path.relative(process.cwd(), file), selector });
      }
    }
  }
  return out;
}

describe('an image container never uses the page background', () => {
  it('finds no container filled with --color-bg', () => {
    const offences = findOffences();
    expect(
      offences,
      offences.length
        ? `These hold a product photo and are filled with --color-bg, so a transparent image shows the page's off-white through the subject. Use var(--color-surface):\n${offences.map((o) => `  ${o.file}  ${o.selector}`).join('\n')}`
        : '',
    ).toEqual([]);
  });

  it('actually looks at the files, and would catch a regression', () => {
    // A guard that silently matched nothing would pass for ever. Two checks: it read real files,
    // and its own matcher recognises the exact declaration it exists to forbid.
    expect(cssFiles(STYLES).length).toBeGreaterThan(10);
    expect(IMAGE_CONTAINER.test('.store-card__preview-img-wrap')).toBe(true);
    expect(/background\s*:\s*var\(--color-bg\)/.test('background: var(--color-bg);')).toBe(true);
    // …and that the exemption is narrow: a real container is not excused by it.
    expect(NO_IMAGE_EXEMPT.test('.store-card__preview-img-wrap')).toBe(false);
    expect(NO_IMAGE_EXEMPT.test('.admin-product-row__thumb--empty')).toBe(true);
    expect(NO_IMAGE_EXEMPT.test('.product-card__img-placeholder')).toBe(true);
  });
});
