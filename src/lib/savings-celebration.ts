/* eslint-disable sonarjs/pseudo-random -- decorative jitter only: the launch angle, flutter and
 * size of confetti pieces. Nothing here is a token, an id or a choice anyone could exploit by
 * predicting it, and a CSPRNG would buy nothing but a slower animation. */
import { roundMoney } from './money.js';

/**
 * The checkout's "חסכת בהזמנה הזו" row: the amount counts up, and a small confetti burst goes off
 * ON THE NUMBER, once, the first time the shopper reaches it.
 *
 * **Read the three shapes this went through before changing it, because each one was built,
 * looked at, and rejected on the merits** (owner, 2026-08-20, all in one round):
 *
 *  1. A confetti burst drawn in SCREEN coordinates (`position: fixed`). The trigger is a scroll,
 *     so the page was still moving when it fired — the pieces stayed where the row had been while
 *     the row slid away. *"כמעט בלתי נראה, הוא מופיע לשניה בעת הגלילה וזהו, הוא גם די מכוער"*.
 *  2. A full-width burst falling through the whole summary, plus a candy stripe sweeping the rule
 *     beneath the row. It worked — and that was the problem: *"כרגע זה יותר מדי אלמנטים"*.
 *  3. His own next suggestion, built as asked: the rule under the row became a slow loop of
 *     coloured stripes. *"לא זה מכוער, עזוב. תוריד את הצבע מהקו"*.
 *
 * What is left is the smallest version of the idea, which is where it should have started:
 * **the number, and confetti on the number.** The rule under the row is a plain border again and
 * nothing about the checkout's resting state has been touched. Nothing here loops — the site's
 * ban on ambient looping motion is back in force with no exception.
 *
 * So the two lessons worth keeping if this is ever revisited: a decoration anchored to CONTENT is
 * positioned in the content's coordinate space, never the screen's; and every round of this went
 * the same way — the smaller version was the better one.
 */

/** Walked in order, never picked at random, so a burst can never come out all one colour by
 *  chance and no two neighbouring pieces match. The palette itself, and why a celebration may be
 *  many colours where a surface may not, is at `--color-confetti-*` in base/tokens.css. */
const CONFETTI_COLORS = [
  'var(--color-confetti-1)', 'var(--color-confetti-2)', 'var(--color-confetti-3)',
  'var(--color-confetti-4)', 'var(--color-confetti-5)', 'var(--color-confetti-6)',
];

/** Sized for ONE number rather than for a page. The earlier full-width version used 46 and read as
 *  too much; this is a flourish around a two-digit figure. */
const PIECES = 20;
/** Keyframes per piece. The trajectory is sampled rather than eased, because no single cubic
 *  bezier describes "up, over, and accelerating down while spinning on three axes". */
const SAMPLES = 16;
/** How long the row must stay on screen before this counts as "the shopper reached it" rather
 *  than "the shopper scrolled past it" — long enough to survive a flick past. */
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

/** One piece's flight, sampled into keyframes. Every value is per-piece: two pieces sharing a
 *  trajectory would read as a pattern, which is the one thing confetti must not do. */
function pieceKeyframes(): { frames: Keyframe[]; duration: number; delay: number } {
  // Apex early, so the eye sees a launch and then a fall — not a lob.
  const apexAt = 0.2 + Math.random() * 0.1;
  const rise = 22 + Math.random() * 34;
  // y(t) = At + Bt², solved so the peak is `rise` above the start at t = apexAt; the fall depth
  // then follows from the physics rather than being invented.
  const b = rise / (apexAt * apexAt);
  const a = (-2 * rise) / apexAt;

  const drift = (Math.random() - 0.5) * 110;
  const sway = 3 + Math.random() * 9;
  const swayCycles = 1 + Math.random() * 1.5;
  const spinZ = (Math.random() - 0.5) * 700;
  // The flutter, and the single biggest reason this reads as paper rather than as particles:
  // rotateY without a perspective foreshortens the piece's width by cos(angle), so every piece
  // turns edge-on and back on its way down. Always at least a full turn.
  const spinY = 360 + Math.random() * 720;
  const spinX = (Math.random() - 0.5) * 420;

  const frames: Keyframe[] = [];
  for (let k = 0; k <= SAMPLES; k++) {
    const t = k / SAMPLES;
    const y = a * t + b * t * t;
    const x = drift * t + Math.sin(t * swayCycles * Math.PI * 2) * sway;
    frames.push({
      offset: t,
      transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
        + ` rotateX(${(spinX * t).toFixed(0)}deg)`
        + ` rotateY(${(spinY * t).toFixed(0)}deg)`
        + ` rotateZ(${(spinZ * t).toFixed(0)}deg)`,
      // Held solid for most of the flight and faded only at the end — a piece that fades from the
      // start never looks like paper, it looks like a particle effect.
      opacity: t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3),
    });
  }
  return { frames, duration: 1500 + Math.random() * 600, delay: Math.random() * 120 };
}

/**
 * The burst, centred on `el` and emitted into `stageHost`.
 *
 * No clipping box, deliberately: the whole point of the rejected versions was that they were too
 * big, so this one is small enough that it never needs one. Every piece stays within ~60px above
 * and ~150px below the number, which on this page is still inside the summary — so nothing is cut
 * off and, equally, the document's scroll height cannot grow under it.
 */
function burstOnNumber(stageHost: HTMLElement, el: HTMLElement): void {
  const hostRect = stageHost.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const cx = rect.left - hostRect.left + rect.width / 2;
  const cy = rect.top - hostRect.top + rect.height / 2;

  const layer = document.createElement('span');
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1' });
  stageHost.appendChild(layer);

  let alive = PIECES;
  for (let i = 0; i < PIECES; i++) {
    const { frames, duration, delay } = pieceKeyframes();
    // Ribbons, not dots: a rectangle roughly 1:2.5 is what reads as a piece of paper once it is
    // turning. Every third piece is round, which keeps the group from looking like a barcode.
    const round = i % 3 === 0;
    const w = round ? 3 + Math.random() * 3 : 2.5 + Math.random() * 2.5;
    const h = round ? w : w * (2 + Math.random() * 1.2);

    const piece = document.createElement('span');
    Object.assign(piece.style, {
      position: 'absolute',
      // Spread across the number's own width, not out of a single point — a radial burst from the
      // centre of a two-digit figure reads as an explosion inside the text.
      left: `${cx + (Math.random() - 0.5) * (rect.width + 12)}px`,
      top: `${cy}px`,
      width: `${w.toFixed(1)}px`,
      height: `${h.toFixed(1)}px`,
      borderRadius: round ? '50%' : '1px',
      background: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
      willChange: 'transform, opacity',
      opacity: '0',
    });
    layer.appendChild(piece);

    // The physics is in the samples; an easing on top would be a second, invisible force acting
    // on every piece.
    const anim = piece.animate(frames, { duration, delay, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => {
      piece.remove();
      // The layer goes with the last piece — a stray absolutely-positioned element left on a
      // checkout is the kind of thing that quietly changes a layout six months later.
      if (--alive === 0) layer.remove();
    };
  }
}

export interface SavingsRowMoment {
  /** The savings row — what has to be ON SCREEN, and the positioning context for the burst. */
  row: HTMLElement;
  /** The element holding the formatted amount: the count-up's target and the burst's centre.
   *  `target` is a GETTER, because the cart re-renders between arming this and the shopper
   *  reaching the row — the figure is whatever is true at the moment it fires, never the one that
   *  was true at page load. */
  amountEl: HTMLElement;
  target: () => number;
  format: (n: number) => string;
}

/**
 * Arms the moment. Nothing else has to check whether there IS a saving: the row is `display:none`
 * when there isn't, and a `display:none` element never intersects.
 *
 * Fires ONCE, and does not stop watching until it has — so a shopper who flicks past the row and
 * scrolls back gets the moment they missed rather than nothing.
 */
export function armSavingsRowMoment(c: SavingsRowMoment): void {
  if (reduced() || typeof IntersectionObserver === 'undefined') return;

  let settleTimer: number | undefined;
  let fired = false;

  const fire = () => {
    if (fired) return;
    fired = true;
    observer.disconnect();
    if (getComputedStyle(c.row).position === 'static') c.row.style.position = 'relative';
    countUp(c.amountEl, c.target(), c.format);
    burstOnNumber(c.row, c.amountEl);
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        // Not fired on the crossing itself: a fast scroll crosses this threshold on its way past,
        // and a celebration for a row the shopper never stopped at is the first version's
        // "appears for a second" complaint in a different costume.
        settleTimer ??= window.setTimeout(fire, SETTLE_MS);
      } else {
        window.clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    }
  }, { threshold: 0.85 });
  observer.observe(c.row);
}
