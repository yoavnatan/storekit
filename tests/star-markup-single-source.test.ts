import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STAR_PATH, starRowHtml } from '../src/lib/star-html.js';

/**
 * There is ONE star on this site, and it is `lib/star-html.ts`'s.
 *
 * A tree scan rather than a list of files, for the reason every guard here is: the failure it
 * prevents is a NEW file, and a list only ever covers the ones that already existed. This project's
 * own history is the argument — twenty hand-written HTML escapers that did not agree, two spellings
 * of the campaign budget rule, three copies of the tracked-tab list. A star is a shape and a colour
 * repeated a dozen times per page across five surfaces; the second copy is not wrong on the day it
 * is written, it is wrong the day one of them is nudged.
 *
 * Two things are checked, and the second is the one that would actually rot: that nobody re-types
 * the path, and that nobody builds a star row out of `starFills` without going through the shared
 * renderer — the display stars, the picker in `ReviewForm.astro`, and the admin takedown list all
 * have to draw the same thing.
 */

const SRC = path.join(process.cwd(), 'src');
const OWNER = path.join('src', 'lib', 'star-html.ts');
/** Where the fills rule is DEFINED — the one other file allowed to name it. */
const RULE = path.join('src', 'lib', 'reviews.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|astro)$/.test(entry) ? [full] : [];
  });
}

const files = walk(SRC).map((full) => ({
  rel: path.relative(process.cwd(), full),
  text: readFileSync(full, 'utf8'),
}));

describe('the half star is CLIPPED, not shrunk', () => {
  // The bug this pins, reported by the owner on 2026-08-17: `reset.css` sets
  // `svg { max-width:100%; height:auto }` site-wide, and that beats the width/height ATTRIBUTES.
  // Inside the 50%-wide clipping box the overlay obeyed `max-width` and became a small whole star
  // sitting on top of a big one — a half star that was not half of anything. Memory
  // `project_svg_height_auto_trap` already described the class; this is the guard it never had.
  const half = starRowHtml(3.5, { px: 15 });

  it('pins width, height AND max-width inline on every star svg', () => {
    const svgs = half.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg, 'a bare width/height attribute is overridden by reset.css').toContain('width:15px');
      expect(svg).toContain('height:15px');
      expect(svg, 'without max-width:none the clipping box shrinks the star instead of cutting it').toContain('max-width:none');
    }
  });

  it('clips the filled layer to half its width', () => {
    expect(half).toContain('overflow:hidden;width:50%');
  });

  it('uses the rating tokens and not a borrowed accent', () => {
    // `--color-warning` was the first cut and is spoken for by "something needs attention".
    expect(half).toContain('var(--color-rating-from)');
    expect(half).toContain('var(--color-rating-to)');
    expect(half).toContain('var(--color-rating-empty)');
    expect(half).not.toContain('--color-warning');
  });

  it('walks the gradient across the row rather than painting five identical stars', () => {
    const row = starRowHtml(5, { px: 15 });
    // First star sits at the `from` end, last at the `to` end. If someone replaces the walk with a
    // single colour this fails, and the row silently stops being the site's own gradient.
    expect(row).toContain('var(--color-rating-to) 0%');
    expect(row).toContain('var(--color-rating-to) 100%');
  });
});

describe('the star is drawn in exactly one place', () => {
  it('nowhere re-types the outline', () => {
    // The first 12 characters are enough to identify it and short enough that a reformat of the
    // rest of the path does not make this stop asserting anything.
    const signature = STAR_PATH.slice(0, 12);
    const offenders = files
      .filter((f) => f.rel !== OWNER && f.text.includes(signature))
      .map((f) => f.rel);
    expect(
      offenders,
      `import STAR_PATH from lib/star-html.ts instead of re-typing the outline. Found in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('nowhere builds its own row out of the fills', () => {
    // `starFills` is the half-star RULE; turning it into markup is `star-html.ts`'s job. A caller
    // that maps over it is writing a second renderer, which is how the picker and the score it
    // produces come to draw different stars.
    const offenders = files
      .filter((f) => f.rel !== OWNER && f.rel !== RULE && /starFills\s*\(/.test(f.text))
      .map((f) => f.rel)
      // The tests are allowed to assert on the rule itself.
      .filter((rel) => !rel.startsWith('tests'));
    expect(
      offenders,
      `render stars through starRowHtml / cardStarRowHtml / StarRating.astro. Found starFills() in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
