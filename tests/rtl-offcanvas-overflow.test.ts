import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/source-guard.js';

/**
 * Nothing may sit past the START edge of a right-to-left page.
 *
 * **Why this is a class and not one bug.** The site is RTL, so the inline start edge is the RIGHT
 * one — and a browser does not clip overflow on the start side, it makes it SCROLLABLE. So anything
 * parked or stretched past that edge turns every page into one that can be dragged sideways and
 * landed with its edge cut. In LTR the identical declaration is harmless, which is why both
 * instances below survived: they are invisible in English, in a default locale, and to any tool
 * that does not run the site in Hebrew.
 *
 * Two were found on 2026-08-28, from one report ("אי התאמה בין הרוחב של האתר לרוחב של ההדר", with a
 * photograph):
 *
 *   · `.skip-link` hid itself at `inset-inline-start: -999px` — 999px past the right edge of every
 *     page on the site.
 *   · the store page's "save this shop" tooltip was `position: absolute` with `white-space: nowrap`
 *     and no cap, so its one unbreakable line ran 17px past the edge. It is laid out at
 *     `opacity: 0`, so it did this while invisible.
 *
 * The header was blamed twice and was innocent both times. What isolated it was measuring five
 * pages signed in and signed out in the same context: only the two store pages, and only signed in,
 * came back non-zero.
 *
 * The two rules below are the two shapes, and both are cheap to state and impossible to argue with.
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

const FILES = walk(SRC);

describe('right-to-left overflow', () => {
  it('nothing is hidden by parking it off the inline edge', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      // Comments stripped: the fix's own explanation quotes the declaration it replaced, and a
      // guard that its own reasoning trips is a guard somebody deletes.
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        // A large negative inline offset is the "hide it off-canvas" idiom. `inset-inline-start`
        // and `right` both land on the start side here; a negative `left` is the end side, which
        // browsers do clip, so it is not caught.
        const m = /(inset-inline-start|inset-inline|right)\s*:\s*(-\d{3,})/.exec(line);
        if (!m) return;
        offenders.push(`${file.replace(SRC, '')}:${i + 1} → ${m[1]}: ${m[2]}px`);
      });
    }
    expect(
      offenders,
      'Parking an element past the inline START edge makes an RTL page horizontally scrollable —\n'
      + 'the browser clips the end side and not this one. Hide it with a 1px box and\n'
      + '`clip-path: inset(50%)` instead, which displaces nothing.\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('an absolutely-positioned bubble that cannot wrap declares a max-width', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, 'utf8'));
      // Inline `style="…"` blocks only: this is the shape the tooltip had, and a stylesheet rule
      // has its selector's own context to reason about.
      for (const m of text.matchAll(/style="([^"]*position:\s*absolute[^"]*)"/g)) {
        const style = m[1]!;
        if (!/white-space:\s*nowrap/.test(style)) continue;
        if (/max-width/.test(style)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${file.replace(SRC, '')}:${line}`);
      }
    }
    expect(
      offenders,
      'An absolutely-positioned box with `white-space: nowrap` and no `max-width` is as wide as its\n'
      + 'longest sentence, wherever that lands — and on a phone that is past the page edge. It is\n'
      + 'laid out even at `opacity: 0`, so it does this while invisible. Cap it.\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });
});
