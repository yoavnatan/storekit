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

/**
 * The same rule, in MARKUP — because the CSS half above could not see the one that got through.
 *
 * The checkout's cart card filled its 80px photo box with `--color-border` as a Tailwind bracket
 * class, so every background-removed product on the page it matters most sat on grey; it survived
 * the three hand-fixes this file documents AND the guard written to end them, because the guard
 * only ever read `src/styles/**`. As the codebase converts to Tailwind, a rule enforced on the
 * stylesheets alone protects less every month.
 *
 * The shape it looks for is an image CELL and nothing else: a fixed box (`w-` and `h-`) that clips
 * its content (`overflow-hidden`) and is filled with a colour that is not a surface. A hairline
 * divider — the legitimate use of `--color-border` as a background, ~30 of them in this tree — has
 * no width AND height pair and never clips; a progress track has no `w-`. Measured when written:
 * this matches exactly one element in `src/**`, which is the bug it was written for.
 */
const MARKUP_BAD_FILL = /(?:bg-\[color:var\(--color-(?:bg|border)\)\]|\[background:var\(--color-(?:bg|border)\)\])/;

function markupFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return markupFiles(full);
    return /\.(astro|ts)$/.test(e.name) ? [full] : [];
  });
}

/** Every `class="…"` / `class={`…`}` value in the tree, with its file. */
function classLists(): { file: string; cls: string }[] {
  const out: { file: string; cls: string }[] = [];
  for (const file of markupFiles(path.join(process.cwd(), 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/class(?:Name)?\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\}|'([^']*)')/g)) {
      out.push({ file: path.relative(process.cwd(), file), cls: m[1] ?? m[2] ?? m[3] ?? '' });
    }
  }
  return out;
}

/** A fixed, clipping box — i.e. something a photo is put INSIDE. */
function isImageCell(cls: string): boolean {
  return /\boverflow-hidden\b/.test(cls) && /\bw-\S+/.test(cls) && /\bh-\S+/.test(cls);
}

describe('an image container never uses the page background — in markup too', () => {
  it('finds no fixed, clipping box filled with --color-bg or --color-border', () => {
    const offences = classLists().filter(({ cls }) => MARKUP_BAD_FILL.test(cls) && isImageCell(cls));
    expect(
      offences,
      offences.length
        ? `A photo box filled with the page/line colour shows it through a transparent product. Use var(--color-surface) (add a 1px border if it needs an edge):\n${offences.map((o) => `  ${o.file}  ${o.cls.slice(0, 120)}`).join('\n')}`
        : '',
    ).toEqual([]);
  });

  it('actually reads the tree, and its matcher recognises what it forbids', () => {
    expect(classLists().length).toBeGreaterThan(100);
    expect(MARKUP_BAD_FILL.test('w-20 h-20 bg-[color:var(--color-border)]')).toBe(true);
    expect(isImageCell('shrink-0 block w-20 h-20 rounded-[var(--radius)] overflow-hidden')).toBe(true);
    // …and that the legitimate uses of the same colour stay out of its way.
    expect(isImageCell('product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]')).toBe(false);
    expect(isImageCell('mt-3 h-[4px] rounded-full bg-[color:var(--color-bg)] overflow-hidden')).toBe(false);
  });
});
