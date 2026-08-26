/**
 * The מבצעים tab has TWO saves, and each one must say what it saves.
 *
 * **Written because the owner asked the question the markup could not answer (2026-08-09): "if the
 * seller presses שמור שינויים without saving the coupon, is the coupon saved?"** It was not. The
 * panel-head button is `type="submit" form="store-sale-form"` — scoped to the store sale and only
 * it — and that was unambiguous for as long as the tab held one form. The coupon card arrived below
 * it with a save of its own, and a generic "שמור שינויים" at the top of a screen with two save
 * models is the exact shape memory `feedback_ajax_forms` names: the seller fills in a
 * coupon, presses the button at the top because that is the one that looks like it means the page,
 * and the code is gone with no error and nothing to recover.
 *
 * Nothing about that is visible in a diff of the coupon card — the button it breaks lives in
 * another file and did not change. So it is pinned here instead, as source assertions, because the
 * failure is a property of the two files TOGETHER.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const panel = readFileSync(join(ROOT, 'src/components/dashboard/PromotionsPanel.astro'), 'utf8');
const card = readFileSync(join(ROOT, 'src/components/dashboard/CouponsCard.astro'), 'utf8');

describe('two saves on one screen', () => {
  it('still has two of them — the premise of everything below', () => {
    // If this ever goes back to one form in the tab, the rules below stop being requirements and
    // this file should be deleted rather than worked around.
    expect(panel).toContain('<CouponsCard');
    expect(card).toMatch(/<form id="coupon-form"/);
    expect(panel).toMatch(/<form[^>]*id="store-sale-form"/);
  });

  it('never labels the scoped head button with the generic "save changes"', () => {
    const button = /<button[^>]*type="submit"[^>]*form="store-sale-form"[^>]*>([^<]*)</.exec(panel);
    expect(button, 'the store-sale head button moved or lost its form= binding').not.toBeNull();
    // `d.saveChanges` is the whole-form label the settings tab uses, where it is true. Here it would
    // be a promise about a screen this button does not cover.
    expect(button![1]).not.toContain('saveChanges');
    expect(button![1]).toContain('storeSaleSave');
  });

  it('gives the coupon form the same unsaved warning every other dashboard form has', () => {
    // The second half of the answer: naming the buttons stops the wrong one being pressed, and this
    // is what speaks up when neither is. It costs no extra plumbing here — unsaved-guard.ts takes
    // its baseline lazily on first contact and treats a `hidden` ancestor as "not live", so the
    // closed form is clean, an opened edit starts clean, and hideForm() after a save clears it.
    expect(card).toMatch(/<form id="coupon-form"[^>]*data-unsaved-guard/);
  });
});
