/**
 * @vitest-environment jsdom
 *
 * "I still cannot move it left and right inside the frame — someone wants their logo flush to the
 * right" (owner, 2026-08-09).
 *
 * The crop tool's pan clamp read `Math.max(0, (image − viewport) / 2)`, which encodes an assumption
 * that was true for every image it had ever been given and false for the first logo: that the image
 * is always BIGGER than the frame. It is, under `cover` — the banner and the avatar both fill their
 * viewport by construction. Under `contain`, a square logo inside the header's 4.4:1 slot is
 * narrower than the frame, the subtraction goes negative, the floor turns it into 0, and the pan is
 * pinned to dead centre. Dragging does nothing. For a photo, centre is the natural place; for a
 * logo it is the one position the seller is least likely to want.
 *
 * This tests the arithmetic rather than a drag, because the arithmetic IS the bug — a jsdom drag
 * would need the modal, an image with `naturalWidth`, and pointer events, to end up asserting the
 * same three numbers.
 */
import { describe, expect, it } from 'vitest';
import { panRange } from '../src/scripts/dashboard/crop-modal.js';

describe('how far the image may travel from centre', () => {
  it('lets a CONTAINED image reach the frame edge — the flush-right case', () => {
    // The header slot at the tool's scale: a 420x95 frame holding a square logo fitted to 95x95.
    // Half the leftover (420 − 95) is what a seller needs to put the mark against either end.
    expect(panRange(95, 420, 1)).toBe(162.5);
    // The old expression answered 0 here, and that zero was the whole complaint.
    expect(Math.max(0, (95 * 1 - 420) / 2)).toBe(0);
  });

  it('is unchanged for a COVERING image — the banner and the avatar move exactly as before', () => {
    // Under `cover` the fit scale is the MAX ratio and zoom is >= 1, so the image is never smaller
    // than the frame on either axis and `abs` and `max(0, …)` are the same number. This is what
    // says the fix could not have disturbed the two widgets that already worked.
    for (const [img, vp, scale] of [[1200, 420, 1], [1200, 420, 2.5], [420, 420, 1]] as const) {
      expect(panRange(img, vp, scale)).toBe(Math.max(0, (img * scale - vp) / 2));
    }
  });

  it('is zero exactly at the crossover, and never negative', () => {
    // The moment the image matches the frame there is nowhere to go, from either direction — a
    // clamp that went negative here would invert its own bounds and make the pan unreachable.
    expect(panRange(420, 420, 1)).toBe(0);
    expect(panRange(210, 420, 2)).toBe(0);
    for (const scale of [0.1, 0.5, 1, 2, 7]) expect(panRange(300, 420, scale)).toBeGreaterThanOrEqual(0);
  });

  it('grows symmetrically as the image shrinks OR grows away from the frame', () => {
    // Half the difference, either way round. Stated as a property because the two regimes are one
    // formula now and a future edit that special-cases one of them should fail here.
    expect(panRange(220, 420, 1)).toBe(panRange(620, 420, 1));
  });
});
