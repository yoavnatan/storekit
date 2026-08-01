// @vitest-environment jsdom
//
// An arrow key names a direction ON SCREEN. The site renders RTL, so a row runs
// right→left and ArrowRight has to walk BACKWARD through the source order to
// reach the item that is actually to the right. Written the obvious way it
// looks correct in review and moves the wrong way in Hebrew — which is how it
// shipped on the homepage tab strip (owner, 2026-08-01), and how it was still
// sitting in two lightboxes after the product page had already solved it
// inline. lib/arrow-step.ts is the one copy.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { arrowStep, wrapIndex } from '../src/lib/arrow-step.js';

const SRC = join(process.cwd(), 'src');

describe('arrowStep', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('dir', 'ltr');
    document.body.innerHTML = '<div id="row"><button id="a"></button></div>';
  });

  it('walks forward on ArrowRight in LTR', () => {
    expect(arrowStep('ArrowRight', document.getElementById('a'))).toBe(1);
    expect(arrowStep('ArrowLeft', document.getElementById('a'))).toBe(-1);
  });

  it('mirrors the pair in RTL — ArrowRight walks BACKWARD through the DOM', () => {
    document.documentElement.setAttribute('dir', 'rtl');
    expect(arrowStep('ArrowRight', document.getElementById('a'))).toBe(-1);
    expect(arrowStep('ArrowLeft', document.getElementById('a'))).toBe(1);
  });

  it('reads direction from the element, not the document', () => {
    // A single LTR island on an RTL page (a code block, an embedded widget)
    // must still move the way its own pixels run.
    document.documentElement.setAttribute('dir', 'rtl');
    const row = document.getElementById('row') as HTMLElement;
    row.style.direction = 'ltr';
    expect(arrowStep('ArrowRight', document.getElementById('a'))).toBe(1);
  });

  it('ignores every other key, so a caller can use 0 as "not mine"', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Escape', 'Enter', 'Tab', 'a', ' ']) {
      expect(arrowStep(key, document.getElementById('a')), key).toBe(0);
    }
  });

  it('falls back to the document when given no element', () => {
    document.documentElement.setAttribute('dir', 'rtl');
    expect(arrowStep('ArrowRight')).toBe(-1);
  });
});

describe('wrapIndex', () => {
  it('wraps at both ends', () => {
    expect(wrapIndex(0, -1, 4)).toBe(3);
    expect(wrapIndex(3, 1, 4)).toBe(0);
    expect(wrapIndex(1, 1, 4)).toBe(2);
  });
});

describe('the rule has one copy', () => {
  function walk(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, acc);
      else if (/\.(ts|astro)$/.test(name)) acc.push(full);
    }
    return acc;
  }

  it('no file compares against ArrowRight/ArrowLeft without going through arrowStep()', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join('lib', 'arrow-step.ts')))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /['"]Arrow(Right|Left)['"]/.test(src) && !src.includes('arrowStep');
      })
      .map((f) => relative(process.cwd(), f));

    expect(
      offenders,
      'A horizontal arrow handler must use arrowStep() (src/lib/arrow-step.ts) so it mirrors ' +
        'in RTL. Writing the comparison inline is how the homepage tab strip and two lightboxes ' +
        'each ended up moving the wrong way in Hebrew.',
    ).toEqual([]);
  });
});
