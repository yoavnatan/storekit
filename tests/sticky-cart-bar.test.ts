/**
 * The product page's sticky add-to-cart bar: its CONTENTS may only change while it cannot be seen.
 *
 * **The bug (owner, 2026-08-25).** Scroll a long product page down until the bar shows its
 * thumbnail and price, then flick back up: for an instant the bar collapses to a bare
 * "הוסף לעגלה", and only then fades out. Two IntersectionObservers on two different trigger
 * elements, and the page fixes their order — the add-to-cart button sits BELOW the product name,
 * so scrolling up re-enters the button first (the bar starts its 240ms fade) and the name a moment
 * later (the summary collapses over 200ms). The collapse therefore always landed inside the fade.
 * Measured in a browser before the fix: the state flipped at opacity **0.53**.
 *
 * **The first fix was wrong, and that is why this file asserts a MECHANISM and not just an
 * outcome.** Queueing the change and flushing it after the fade looks right and fails on a jump:
 * observer callbacks for one scroll arrive in a single batch whose order this code does not
 * control, so a jump to the foot of the page — an anchor, scroll restoration, "back to top" — can
 * deliver the visibility change first, and the bar then appears showing the *previous* contents
 * with the correct ones stuck in a queue until the next hide. A flicker traded for a bar that is
 * simply wrong. It was caught by the harness reporting `collapsed: true` at the bottom of a page
 * whose thumbnail should have been showing.
 *
 * So the rule the code follows, and the one asserted here: **recompute from the DOM at the two
 * instants a change is invisible** — immediately before the bar is turned on (opacity still 0),
 * and once it has finished fading out. Never remember an answer from the other observer.
 *
 * There is no unit test for the timing itself; it needs a real browser and a real scroll. The
 * harness that measured it is a one-off Playwright script (the Playwright rule in
 * `AI_INSTRUCTIONS.md`): sample every animation frame through a fast scroll to the top and count
 * frames where the collapsed flag flipped while the bar's opacity was still above 0. Before the
 * fix: 1. After: 0, with the flip moved past the end of the fade.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(import.meta.dirname, '..', 'src/pages/[storeSlug]/[productSlug].astro'),
  'utf8',
);

/** The file with its COMMENTS removed.
 *
 *  Not a slice of it: the two observers sit either side of the helpers they share, so any single
 *  cut point drops one of them — the first version of this test started at
 *  `updateStickyBarSoloWidth` and silently could not see the visibility observer above it, which
 *  made two assertions pass on absence. Comments have to go for the opposite reason: the prose
 *  explaining this rule necessarily quotes every identifier the rule is about. A block comment
 *  opens after whitespace or `{`, never mid-token — `accept="image/*"` is why that anchor matters
 *  (`tests/accessibility-guards.test.ts` has the worked case). */
const SCRIPT = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1 ')
  .replace(/^\s*\/\/.*$/gm, ' ');

describe('the sticky bar changes its contents only where they cannot be seen', () => {
  it('recomputes the collapsed state from the DOM rather than trusting the other observer', () => {
    // The ordering bug in one assertion: a remembered answer is an answer from a callback whose
    // position in the batch is not ours to choose.
    expect(SCRIPT, 'syncCollapse must read the heading geometry itself').toContain('nameStillOnScreen');
    expect(SCRIPT).toMatch(/getBoundingClientRect\(\)/);
  });

  it('fixes the contents BEFORE the bar is turned on, while opacity is still 0', () => {
    const observer = SCRIPT.slice(SCRIPT.indexOf('.observe(addBtn)') - 1200, SCRIPT.indexOf('.observe(addBtn)'));
    const sync = observer.indexOf('syncCollapse()');
    const toggle = observer.indexOf("classList.toggle('is-visible'");
    expect(sync, 'the show path must sync the contents').toBeGreaterThan(-1);
    expect(toggle, 'the bar must still toggle its visibility class').toBeGreaterThan(-1);
    expect(sync, 'syncing AFTER the class flips is the visible change this exists to prevent')
      .toBeLessThan(toggle);
  });

  it('and again once it has finished fading out', () => {
    const settle = SCRIPT.slice(SCRIPT.indexOf('function settleBar'));
    const body = settle.slice(0, settle.indexOf('\n  }'));
    expect(body, 'the far side of the fade is the other safe instant').toContain('syncCollapse()');
    expect(body, 'only when it ended up HIDDEN — a visible bar is never the moment')
      .toContain("is-visible");
  });

  it('never lets the summary observer act while the bar is on screen or mid-transition', () => {
    const obs = SCRIPT.slice(SCRIPT.indexOf('.observe(productNameHeading)') - 700, SCRIPT.indexOf('.observe(productNameHeading)'));
    expect(obs, 'this observer must be gated, or it reintroduces the flicker directly')
      .toMatch(/barSettled/);
    expect(obs).toContain("is-visible");
  });

  it('cancels the previous transition\'s fallback timer', () => {
    // Found reviewing this change, not by a symptom. An uncancelled timer from an EARLIER toggle
    // fires part-way through a LATER one and settles it early — and settling early is precisely
    // when `syncCollapse` runs against a bar still on screen, i.e. the glitch coming back through
    // its own safety net. Reachable any time two toggles land under 400ms apart, which a flick up
    // and straight back down does easily.
    expect(SCRIPT, 'the timer id must be held so it can be cleared').toMatch(/barSettleTimer/);
    expect(SCRIPT, 'and cleared before a new one is armed').toMatch(/clearTimeout\(barSettleTimer\)/);
  });

  it('states the header inset once, not once per reader', () => {
    // The two observers and the geometry check must answer the same question; the literal 56 was
    // written three times, which is two chances to change one of them and have the bar disagree
    // with the observer that woke it.
    expect(SCRIPT).toContain('STICKY_TOP_INSET');
    expect(SCRIPT.match(/rootMargin: STICKY_ROOT_MARGIN/g) ?? [], 'both observers read the constant')
      .toHaveLength(2);
    expect(SCRIPT, 'no hand-written -56px left').not.toMatch(/rootMargin: '-\d+px/);
  });

  it('has a timeout fallback, because a transitionend is not guaranteed', () => {
    // `prefers-reduced-motion`, or a browser dropping the transition under load, fires no event —
    // and a bar that never settles is a bar whose contents stop updating for the rest of the page.
    expect(SCRIPT).toMatch(/setTimeout\(settleBar/);
    expect(SCRIPT).toContain("transitionend");
  });
});
