import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A horizontal carousel must not swallow the page's vertical scroll.
 *
 * `touch-action: pan-x` tells the browser that this element handles horizontal panning and NOTHING
 * else — so a finger that lands on it and drags upward moves nothing at all. Five carousels carried
 * it (the product card's photo strip, its slides, the store modal's, the product page's main image,
 * the quick view's), and between them they cover most of the surface of a phone screen: the store
 * page simply refused to scroll wherever a picture was under the thumb (owner, 2026-08-28, found on
 * the live demonstration).
 *
 * Naming both axes lets the browser keep driving the snap carousel horizontally while a vertical
 * drag scrolls the page behind it. `pinch-zoom` is kept so a photo can still be magnified.
 *
 * A source scan and not a browser test: the failure is a missing token in a declaration, it is a
 * statement about every carousel in the tree rather than one render, and reproducing it needs real
 * touch events — the drive that found it could see the CSS but could not have felt it.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(css|astro|ts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('touch-action on a horizontal carousel', () => {
  it('never says pan-x without pan-y', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Both spellings: the CSS declaration and Tailwind's bracket form, where the value's
        // spaces are underscores.
        const css = /touch-action:\s*([^;"'\]}]+)/.exec(line)?.[1];
        const util = /\[touch-action:([^\]]+)\]/.exec(line)?.[1]?.replace(/_/g, ' ');
        for (const value of [css, util]) {
          if (!value) continue;
          if (!value.includes('pan-x')) continue;
          if (value.includes('pan-y')) continue;
          offenders.push(`${file.replace(SRC, '')}:${i + 1} → ${value.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'A carousel with `pan-x` and no `pan-y` eats the page\'s vertical scroll on a phone:\n'
      + 'a finger landing on it can only move sideways. Use `pan-x pan-y pinch-zoom`.\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });
});
