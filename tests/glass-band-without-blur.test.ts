/**
 * The pinned category bar must still be a bar when the browser does not draw its blur.
 *
 * The bug (owner, 2026-08-21, with a screen recording). `.store-controls::before` is a full-bleed
 * band carrying `backdrop-filter: blur(14px)`. Chrome rasterises a backdrop-filter on the
 * compositor, and during a fast flick over a band this wide it stops re-rastering and draws the
 * raw backdrop instead, catching up only once the scroll stops. In consecutive frames of that
 * recording the prices behind the chips are legible and razor-sharp *through* the bar, and blurred
 * again a frame later. That is a browser guarantee we do not have, not a bug in this page: the
 * class toggling was measured stable at 1x, 4x and 6x CPU, at three widths, in Chromium and WebKit.
 *
 * So the tint underneath has to hold the bar up on its own, and the blur is a bonus. It was 50%,
 * which is nothing: with the blur gone the shopper scrolled product photos straight through the
 * category row. Four levels were rendered on the live page over real photos with the blur forced
 * off; the owner picked 78%.
 *
 * This guards the FLOOR, not the exact number — a later design pass may take it up, and a taste
 * call to take it back down toward "more glassy" is exactly the change that silently restores the
 * bug, because on a still page (which is where anyone judges a tint) every value looks fine.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STORE_CSS = readFileSync(fileURLToPath(new URL('../src/styles/pages/store.css', import.meta.url)), 'utf8');

/** Below this the band stops reading as a surface once the blur is not drawn — measured, not taste. */
const MIN_TINT_PERCENT = 75;

/** The `.store-controls::before` block, comments stripped so this file's own prose can't match. */
function glassBlock(): string {
  const withoutComments = STORE_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const start = withoutComments.indexOf('.store-controls::before');
  expect(start, '.store-controls::before rule not found in store.css').toBeGreaterThan(-1);
  const open = withoutComments.indexOf('{', start);
  const close = withoutComments.indexOf('}', open);
  return withoutComments.slice(open, close);
}

describe('the pinned category bar without its blur', () => {
  it('is tinted enough to read as a surface on its own', () => {
    const block = glassBlock();
    const match = /background:\s*color-mix\(in srgb,\s*var\(--color-bg\)\s*(\d+)%/.exec(block);
    expect(match, `expected a color-mix tint on --color-bg in:\n${block}`).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_TINT_PERCENT);
  });

  it('still asks for the blur — it is a bonus, not something to delete', () => {
    // The other direction of the same rule: the fix was to stop DEPENDING on the blur, not to
    // drop it. On a still page, and on any GPU that keeps up, it is the whole look.
    const block = glassBlock();
    expect(block).toMatch(/backdrop-filter:\s*blur\(/);
    expect(block).toMatch(/-webkit-backdrop-filter:\s*blur\(/);
  });
});
