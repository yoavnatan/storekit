import { roundMoney } from './money.js';

/**
 * The checkout's "חסכת בהזמנה הזו" row: a slow band of colour along the rule beneath it, and the
 * amount counting up the first time the shopper reaches the row.
 *
 * **Four shapes were built and looked at before this one; three were rejected** (owner,
 * 2026-08-20, all in one round). Do not re-propose any of them:
 *
 *  1. A confetti burst drawn in SCREEN coordinates (`position: fixed`). The trigger is a scroll,
 *     so the page was still moving when it fired — the pieces stayed where the row had been while
 *     the row slid away. *"כמעט בלתי נראה, הוא מופיע לשניה בעת הגלילה וזהו, הוא גם די מכוער"*.
 *  2. The same burst fixed and working, full width, plus a candy stripe sweeping the rule. It
 *     worked, and that was the problem: *"כרגע זה יותר מדי אלמנטים"*.
 *  3. A small burst on the number alone, with the rule left plain — the most restrained version
 *     of all, and he preferred what it replaced.
 *
 * What survived is the one he asked for in his own words and then chose again after seeing the
 * alternative: **coloured stripes under the line, drifting slowly, in a loop**, thinner than the
 * first cut of it. Not a burst that demands attention for three seconds; a surface that is quietly
 * alive. The lesson worth keeping is not "smaller is better" — round 3 was the smallest and lost.
 * It is that a decoration anchored to CONTENT is positioned in the content's coordinate space,
 * never the screen's, and that everything else here was taste, which is his.
 *
 * **This is the site's one deliberate exception to "no ambient looping motion".** That ban is his
 * rule and it stands everywhere else — nothing on this site may animate forever to be noticed.
 * The exception is his too, asked for in those words, and it is bounded three ways so it stays an
 * exception rather than a precedent: the band exists ONLY while there is a saving to celebrate
 * (`setActive`), it is PAUSED whenever it is off screen, and it moves at ~9px a second, which is
 * slow enough to read as drift rather than as something trying to be looked at.
 *
 * The motion is a `translateX` on a strip twice the width of its clip, not an animated
 * `background-position` — a transform is the only thing here that runs on the compositor, and an
 * animation that never ends is exactly where "it repaints every frame forever" stops being an
 * academic point and starts being a laptop fan on a checkout page.
 */

/**
 * Three tones of ONE colour — the sale green — not the six confetti hues this started with.
 *
 * He asked the right question about that rainbow (*"יש בכלל צורך בצבע הזה או שזה מכער?"*) and the
 * design line answers it: every accent here has exactly one job, and `--color-sale` already owns
 * "this is what you saved" across the price, the badge and the banner. A band of six unrelated
 * hues under a savings figure spends colour on nothing — it says no more than a grey rule would,
 * while competing with the one number on the page the shopper is actually reading.
 *
 * **The movement was always the nice part, not the palette**, and movement needs only a tonal
 * difference to be visible. So the band keeps its drift and gives up its rainbow: mid, light,
 * deep, blending into each other, which reads as one green line quietly shifting rather than as
 * a decoration laid over the row.
 */
const STRIPE_COLORS = [
  'var(--color-sale)',
  'color-mix(in srgb, var(--color-sale) 38%, white)',
  'color-mix(in srgb, var(--color-sale) 72%, black)',
];
/** Width of one band, and how much of it is spent blending into the next.
 *
 *  Both came out of looking at the first build: hard-edged 14px bands render as a row of coloured
 *  SQUARES — a strip of lego, not a stripe — because nothing connects one band to its neighbour.
 *  A soft hand-off reads as one continuous ribbon instead, which is the difference between a
 *  decoration and a toy. Wider bands now that they are three tones of one colour rather than six
 *  hues: with less contrast between neighbours, a short band would blur into a flat line and the
 *  drift would stop being visible at all. */
const BAND = 22;
const BLEND = 10;
/** One full cycle of the palette, measured ALONG THE GRADIENT LINE. */
const PERIOD = BAND * STRIPE_COLORS.length;

/** The stripe's tilt. Steep enough that the slant is visible at 2px tall — a stripe's edge shifts
 *  sideways by `height / tan(angle)`, and the 55° first tried moved it about two pixels, i.e. an
 *  invisible slant, i.e. a rectangle. */
const ANGLE_DEG = 25;

/**
 * How far the strip must travel HORIZONTALLY to land exactly one palette-cycle on from where it
 * started — which is the only distance at which the loop is invisible.
 *
 * **This is the bug the owner saw** (2026-08-20: *"התנועה קופצת ולא רציפה"*). The first version
 * moved by `PERIOD`, on the reasoning that the pattern repeats every `PERIOD`. It does — but along
 * the GRADIENT LINE, not along x, and the two are only the same for an upright stripe. A CSS
 * gradient at angle θ has its line pointing `(sin θ, −cos θ)`, so a purely horizontal shift of Δx
 * advances the pattern by `Δx · sin θ`. At 25° that is 0.42 of the distance moved: travelling
 * `PERIOD` advanced the pattern only two fifths of a cycle, and every iteration boundary snapped
 * the remaining three fifths back in a single frame. Hence a visible jump, once per loop, on an
 * animation whose whole job is to be continuous.
 *
 * Derived rather than measured by eye, because the number is not guessable and the failure is
 * subtle enough to ship: at some angles the mismatch is small enough to read as a stutter rather
 * than a jump, which is worse — it looks like jank rather than like a bug.
 */
const TRAVEL = PERIOD / Math.sin((ANGLE_DEG * Math.PI) / 180);

/** Kept at ~9px a second across every retune of BAND or ANGLE_DEG — slow on purpose: fast enough
 *  to be alive, slow enough that the eye lets it be. Derived from the real travel distance rather
 *  than typed, so a retune cannot silently change the speed. */
const CYCLE_MS = Math.round((TRAVEL / 9) * 1000);
/** 2px, exactly covering the row's own border, so the band reads as that rule having colour
 *  rather than as a second thing added above it (owner, 2026-08-20: *"שיהיה מעט יותר דק"*).
 *
 *  2 is only safe because the bands BLEND. An earlier draft at 2px with hard edges came out as a
 *  dashed line, and the note that produced said "below 3 a slanted band has nowhere to slant" —
 *  which was the wrong diagnosis. What actually failed was the pale band sitting at the page's own
 *  colour, so it read as a gap; with every band a real colour handing off into the next there is
 *  nothing for the eye to read as a dash, and the height is free again. Don't take it below 2:
 *  under one physical pixel on a 1× screen the row starts disappearing on some devices. */
const HEIGHT = 2;
/** How long the row must stay on screen before the count-up counts as "the shopper reached it"
 *  rather than "the shopper scrolled past it". */
const SETTLE_MS = 220;

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * The value to show at progress `t` (0 → 1) of the count-up. Exported and pure so the three
 * things that make it safe on a money surface can be TESTED rather than asserted in a comment
 * (`tests/savings-countup.test.ts`): it lands exactly on the target, it never overshoots it, and
 * it never invents a precision the target does not have.
 *
 * That last one is a real defect, not a nicety: free interpolation turned "80 ₪" into a run of
 * "65.35 ₪" on the way there — agorot on a figure that has none, which reads as a different kind
 * of number rather than as the same one arriving.
 */
export function countUpValue(target: number, t: number): number {
  if (t >= 1) return target;
  // Fast out of the gate and easing into the real figure, so the last digits settle rather than
  // snap. `roundMoney`, never a hand-rolled `Math.round(x * 100) / 100` — this file is on the
  // money surface and that expression is the tree-scanned defect (money-guards).
  const eased = 1 - Math.pow(1 - Math.max(0, t), 3);
  const rounded = roundMoney(target * eased);
  return Number.isInteger(target) ? Math.round(rounded) : rounded;
}

/**
 * Runs the amount from 0 up to the figure that is already correct in the DOM.
 *
 * **It can only ever end on the true number, and it gets out of the way of anything that
 * disagrees with it.** This is a money surface: the cart re-renders on a price refresh, a
 * quantity change or a coupon, and any of those can land mid-count. So every frame checks that
 * the text is still what this function last wrote — if something else has written the amount,
 * the count-up abandons the field and that value stands.
 */
function countUp(el: HTMLElement, target: number, format: (n: number) => string): void {
  const DURATION = 1200;
  const start = performance.now();
  let written = el.textContent ?? '';
  const frame = (now: number) => {
    if ((el.textContent ?? '') !== written) return; // renderCart (or a refresh) owns it now
    const t = Math.min(1, (now - start) / DURATION);
    written = format(countUpValue(target, t));
    el.textContent = written;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The band itself: a clip the width of the row, holding an over-wide strip that slides exactly
 *  one palette-cycle (`TRAVEL`) and starts over. The strip overhangs by that same distance at each
 *  end so the travel can never expose an edge — at the end of it the pixel under any point is the
 *  colour it was at the start, which is what makes the loop invisible. */
function buildBand(): { band: HTMLElement; strip: HTMLElement } {
  const band = document.createElement('span');
  band.setAttribute('aria-hidden', 'true');
  Object.assign(band.style, {
    position: 'absolute',
    insetInline: '0',
    top: `${-HEIGHT}px`,
    height: `${HEIGHT}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
    borderRadius: '1px',
  });

  // Each colour holds for BAND - BLEND and then the gradient interpolates across the gap into the
  // next one.
  const stops = STRIPE_COLORS
    .map((c, i) => `${c} ${i * BAND}px ${(i + 1) * BAND - BLEND}px`)
    .join(', ');
  const strip = document.createElement('span');
  Object.assign(strip.style, {
    position: 'absolute',
    insetBlock: '0',
    // Wider than the clip by a whole palette cycle at each end, so the travel never exposes an
    // edge no matter how wide the summary column gets.
    insetInline: `${-TRAVEL}px`,
    // Why this angle, and what it costs the loop, are both at ANGLE_DEG / TRAVEL above — they are
    // one decision, and splitting them is how the travel distance came to disagree with it.
    background: `repeating-linear-gradient(${ANGLE_DEG}deg, ${stops})`,
    willChange: 'transform',
  });
  band.appendChild(strip);
  return { band, strip };
}

export interface SavingsRowMoment {
  /** The savings row — what has to be ON SCREEN before the count-up runs. */
  row: HTMLElement;
  /** The row whose TOP border is the rule under the savings line; the band is mounted on it. */
  ruleRow: HTMLElement;
  /** The element holding the formatted amount, plus the figure and formatter behind it.
   *  `target` is a GETTER: the cart re-renders between mounting this and the shopper reaching the
   *  row, so the figure to count up to is whatever is true at the moment it fires — never the one
   *  that was true when the page loaded. */
  amountEl: HTMLElement;
  target: () => number;
  format: (n: number) => string;
}

export interface SavingsRowHandle {
  /** Call it wherever the savings row itself is shown or hidden. The band is the rule under a
   *  saving; with no saving there is nothing under, and a rainbow along the top of the summary
   *  would be decoration with nothing to say. */
  setActive: (on: boolean) => void;
}

/** Mounts the band and arms the count-up. Safe to call once, at page setup, before the cart has
 *  rendered — nothing is visible until `setActive(true)`. */
export function mountSavingsRowMoment(c: SavingsRowMoment): SavingsRowHandle {
  if (getComputedStyle(c.ruleRow).position === 'static') c.ruleRow.style.position = 'relative';

  const { band, strip } = buildBand();
  band.style.display = 'none';
  c.ruleRow.appendChild(band);

  // Still: the colours are the point, the movement is not, and someone who asked the OS for less
  // motion did not ask for less colour.
  const drift = reduced() ? null : strip.animate(
    [{ transform: 'translateX(0)' }, { transform: `translateX(${TRAVEL}px)` }],
    { duration: CYCLE_MS, iterations: Infinity, easing: 'linear' },
  );
  drift?.pause();

  let active = false;
  let counted = false;
  let settleTimer: number | undefined;

  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    for (const entry of entries) {
      // Nothing moves while nobody is looking. A loop that runs on a backgrounded tab, or three
      // screens above the fold, is the part of "ambient motion" that is a cost rather than a
      // choice — and this is the one animation on the site with no end of its own.
      if (entry.isIntersecting && active) drift?.play(); else drift?.pause();

      if (!counted && entry.isIntersecting) {
        // Not fired on the crossing itself: a fast scroll passes the row on its way somewhere
        // else, and a number that races itself while sliding off screen is worse than a number.
        settleTimer ??= window.setTimeout(() => {
          counted = true;
          if (!reduced()) countUp(c.amountEl, c.target(), c.format);
        }, SETTLE_MS);
      } else if (!entry.isIntersecting) {
        window.clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    }
  }, { threshold: 0.85 });
  observer?.observe(c.row);

  /** The observer only speaks when intersection CHANGES, and the row is usually already where it
   *  is by the time the cart finishes rendering — so switching the band on has to answer "is it
   *  on screen" itself rather than wait for a callback that will not come. */
  const onScreen = () => {
    const r = c.row.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 0);
  };

  return {
    setActive(on: boolean) {
      if (on === active) return;
      active = on;
      band.style.display = on ? 'block' : 'none';
      if (on && onScreen()) drift?.play(); else drift?.pause();
    },
  };
}
