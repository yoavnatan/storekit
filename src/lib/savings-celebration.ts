/* eslint-disable sonarjs/pseudo-random -- decorative jitter only: the launch angle, flutter and
 * size of confetti pieces. Nothing here is a token, an id or a choice anyone could exploit by
 * predicting it, and a CSPRNG would buy nothing but a slower animation. */
import { roundMoney } from './money.js';

/**
 * The one celebratory moment on the shopping side: the checkout's "חסכת בהזמנה הזו" row, when
 * the shopper actually reaches it.
 *
 * **This is the second attempt, and the first one's failure is the whole design of this one**
 * (owner, 2026-08-20: *"כמעט בלתי נראה, הוא מופיע לשניה בעת הגלילה וזהו, הוא גם די מכוער"*). The
 * first version drew 22 `position:fixed` dots at the row's screen coordinates and let them fall
 * for a second. Three things were wrong with that, and they are worth naming because each has a
 * rule behind it:
 *
 *  1. **`fixed` is the wrong coordinate space for anything anchored to CONTENT.** The trigger is
 *     a scroll, so the page is still moving when it fires: the pieces stayed where the row *had*
 *     been while the row itself slid away, which is exactly the "appears for a second and is
 *     gone" he saw. Everything here is absolutely positioned inside a stage that belongs to the
 *     row's own container, so the confetti travels with the content — it is still falling past
 *     the total when the shopper keeps scrolling.
 *  2. **It fired mid-flick.** An IntersectionObserver fires the instant a threshold is crossed,
 *     including while a fast scroll is carrying the row straight past. The celebration now waits
 *     for the row to SETTLE (`SETTLE_MS`) and cancels if it leaves — and, crucially, does not
 *     unobserve until it has actually fired, so a shopper who flicks past and scrolls back gets
 *     the moment they missed rather than nothing.
 *  3. **Flat rectangles falling straight down do not read as confetti.** Real confetti flutters:
 *     each piece turns edge-on and back, which is what makes it catch the eye. `rotateY` without
 *     a perspective already foreshortens the piece's width by `cos(angle)` — so the flutter is
 *     free, and it is the single biggest difference between this and the first attempt. The
 *     trajectory is a real projectile (`y = At + Bt²`) with a sideways sway, rather than a
 *     two-keyframe lerp, and it lasts ~3s instead of ~1.2s.
 *
 * The moment is three things at once, and they share one clock so they read as one event:
 * the confetti, the count-up on the amount, and a candy-stripe sweep along the rule under the
 * row (his own suggestion, same day). **The stripe animates ONCE and settles back to the plain
 * border** — it is not a barber pole. Ambient looping motion is banned site-wide (never
 * `infinite`), and a permanently animated divider on a checkout would also be exactly the
 * "would it date?" failure the design line's second test exists to catch.
 *
 * Reduced motion turns all three off: the amount is simply correct, the rule is simply a rule.
 */

/** Walked in order, never picked at random, so a burst can never come out all one colour by
 *  chance and no two neighbouring pieces match. The palette itself, and why a celebration may be
 *  many colours where a surface may not, is at `--color-confetti-*` in base/tokens.css. */
const CONFETTI_COLORS = [
  'var(--color-confetti-1)', 'var(--color-confetti-2)', 'var(--color-confetti-3)',
  'var(--color-confetti-4)', 'var(--color-confetti-5)', 'var(--color-confetti-6)',
];

/** Enough that the fall has texture at every moment of its ~3s rather than resolving into a few
 *  countable dots — which is what 22 did. Cheap: transform+opacity only, so every piece is a
 *  compositor animation and the main thread does nothing after the first frame. */
const PIECES = 46;
/** Keyframes per piece. The trajectory is sampled rather than eased, because no single cubic
 *  bezier describes "up, over, and accelerating down while spinning on three axes". */
const SAMPLES = 20;
/** How long the row has to stay on screen before this counts as "the shopper reached it" rather
 *  than "the shopper scrolled past it". Long enough to survive a flick, short enough that it
 *  still feels like a reaction to arriving. */
const SETTLE_MS = 220;

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** One piece's flight, sampled into keyframes. Every value here is per-piece: two pieces that
 *  shared a trajectory would read as a pattern, which is the one thing confetti must not do. */
function pieceKeyframes(i: number): { frames: Keyframe[]; duration: number; delay: number } {
  // Apex early in the flight, so the eye sees a launch and then a long fall — not a lob.
  const apexAt = 0.18 + Math.random() * 0.12;
  const rise = 55 + Math.random() * 95;
  // y(t) = At + Bt², solved so the peak is `rise` above the start at t = apexAt. The fall depth
  // (A + B, roughly 4–6× the rise) then follows from the physics instead of being invented.
  const b = rise / (apexAt * apexAt);
  const a = (-2 * rise) / apexAt;

  const drift = (Math.random() - 0.5) * 240;
  const sway = 6 + Math.random() * 20;
  const swayCycles = 1 + Math.random() * 2;
  const spinZ = (Math.random() - 0.5) * 900;
  // The flutter. Unsigned and always at least a full turn, so every piece turns edge-on more
  // than once during its fall; this is the one value not worth randomising toward zero.
  const spinY = 420 + Math.random() * 900;
  const spinX = (Math.random() - 0.5) * 560;

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
      // Held solid for most of the flight and faded only at the end — a piece that fades from
      // the start never looks like paper, it looks like a particle effect.
      opacity: t < 0.78 ? 1 : Math.max(0, 1 - (t - 0.78) / 0.22),
    });
  }
  return {
    frames,
    duration: 2600 + Math.random() * 900,
    // A stagger, so the group leaves the rule as a scatter rather than as one block.
    delay: (i % 7) * 26 + Math.random() * 140,
  };
}

/** Headroom the stage takes ABOVE its host, in px.
 *
 *  This number is the fix for the second thing that was wrong with the first attempt's successor:
 *  a stage of exactly the host's box clipped the entire launch. The savings row sits at the very
 *  TOP of the checkout summary, and confetti goes UP before it comes down — so with `inset: 0`
 *  every piece spent its rise outside the clip and the whole burst was invisible, even though 46
 *  of them were provably on the page.
 *
 *  Extending UPWARD is free in a way extending downward is not: overflow above the viewport is
 *  never scrollable, so the page cannot grow. Downward the stage still stops at the host's own
 *  bottom edge, which both bounds the document height and gives the fall a natural end — the
 *  pieces disappear behind the bottom of the summary rather than at an arbitrary line. */
const STAGE_HEADROOM = 300;

/** The stage: a clipping box of its own, so nothing else in `host` is clipped — which is why this
 *  is a dedicated layer rather than `overflow` on the host itself (the host holds the shipping
 *  dropdown, and clipping THAT would be a real bug traded for a decoration). */
function makeStage(host: HTMLElement): HTMLElement {
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  Object.assign(stage.style, {
    position: 'absolute',
    insetInline: '0',
    top: `${-STAGE_HEADROOM}px`,
    bottom: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '1',
  });
  host.appendChild(stage);
  return stage;
}

function releaseConfetti(stage: HTMLElement, originTop: number): Promise<void> {
  const width = stage.clientWidth;
  const done: Promise<unknown>[] = [];

  for (let i = 0; i < PIECES; i++) {
    const { frames, duration, delay } = pieceKeyframes(i);
    // Ribbons, not dots: a rectangle roughly 1:2.5 is what reads as a piece of paper once it is
    // turning. Every third piece is round, which keeps the group from looking like a barcode.
    const round = i % 3 === 0;
    const w = round ? 4 + Math.random() * 4 : 3 + Math.random() * 4;
    const h = round ? w : w * (2 + Math.random() * 1.4);

    const piece = document.createElement('span');
    Object.assign(piece.style, {
      position: 'absolute',
      left: `${(width * (i + 0.5)) / PIECES + (Math.random() - 0.5) * 18}px`,
      top: `${originTop}px`,
      width: `${w.toFixed(1)}px`,
      height: `${h.toFixed(1)}px`,
      borderRadius: round ? '50%' : '1px',
      background: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
      willChange: 'transform, opacity',
      opacity: '0',
    });
    stage.appendChild(piece);

    const anim = piece.animate(frames, {
      duration,
      delay,
      // The physics is in the samples; an easing on top of it would be a second, invisible
      // force acting on every piece.
      easing: 'linear',
      fill: 'forwards',
    });
    anim.onfinish = () => piece.remove();
    done.push(anim.finished.catch(() => undefined));
  }
  return Promise.all(done).then(() => undefined);
}

/** The candy stripe along the rule under the row. Drawn OVER the existing border rather than
 *  replacing it, so the resting state of the checkout is byte-for-byte what it was: when this
 *  element goes, the plain 2px border is still underneath, untouched.
 *  Travels toward the inline-start edge — in Hebrew that is left, i.e. the direction text runs,
 *  so the stripe reads as moving along the line rather than against it. */
function sweepCandyRule(row: HTMLElement, duration: number): void {
  // Both numbers were measured against the first try, which came out reading as a DASHED green
  // border rather than as a candy stripe. Two reasons, and they compound: at 2px tall no diagonal
  // is perceivable at all, and the second band was mixed toward `--color-surface` (white) while
  // the page behind it is `--color-bg` (grey) — so the pale band read as a GAP, which is the
  // definition of a dash. 3px gives the slant something to happen in, and the pale band is now a
  // real tint that is visibly a colour rather than an absence.
  const period = 18; // one deep band + one pale band
  const rule = document.createElement('span');
  rule.setAttribute('aria-hidden', 'true');
  Object.assign(rule.style, {
    position: 'absolute',
    insetInline: '0',
    // 4px over the row's own 2px border. Height is what lets the diagonal exist at all: below
    // ~3px a slanted band has nowhere to slant and the whole thing collapses back into dashes.
    top: '-3px',
    height: '4px',
    borderRadius: '2px',
    pointerEvents: 'none',
    // BOTH bands are a real green. The pale one is a mint rather than a near-white, because
    // anything close to the page's own grey reads as a gap and turns the stripe into a dashed
    // border — which is exactly what the first attempt looked like.
    background: `repeating-linear-gradient(55deg,
      var(--color-sale) 0 ${period / 2}px,
      color-mix(in srgb, var(--color-sale) 42%, white) ${period / 2}px ${period}px)`,
    backgroundSize: `${period * 2}px 100%`,
  });
  row.appendChild(rule);

  const dir = getComputedStyle(row).direction === 'rtl' ? 1 : -1;
  const anim = rule.animate(
    [
      { backgroundPosition: '0px 0px', opacity: 0 },
      { backgroundPosition: `${dir * period * 3}px 0px`, opacity: 1, offset: 0.08 },
      { backgroundPosition: `${dir * period * 14}px 0px`, opacity: 1, offset: 0.82 },
      // Settles rather than stops: the stripes decelerate into the last stretch and the whole
      // thing fades out, leaving the border that was there all along.
      { backgroundPosition: `${dir * period * 16}px 0px`, opacity: 0 },
    ],
    { duration, easing: 'cubic-bezier(0.16, 0.7, 0.3, 1)', fill: 'forwards' }
  );
  anim.onfinish = () => rule.remove();
}

/**
 * Runs the amount from 0 up to the figure that is already correct in the DOM.
 *
 * **It can only ever end on the true number, and it gets out of the way of anything that
 * disagrees with it.** This is a money surface: the cart re-renders on a price refresh, a
 * quantity change or a coupon, and any of those can land mid-count. So every frame checks that
 * the text is still what this function last wrote — if something else has written the amount,
 * the count-up abandons the field and that value stands. The final frame always writes
 * `format(target)` exactly, never an interpolated value rounded to look like it.
 */
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
  const clamped = Math.max(0, t);
  // Fast out of the gate and easing into the real figure, so the last digits settle rather than
  // snap.
  const eased = 1 - Math.pow(1 - clamped, 3);
  // `roundMoney`, never a hand-rolled `Math.round(x * 100) / 100` — this file is on the money
  // surface and that expression is the tree-scanned defect (money-guards). It also literally
  // misbehaves here: rounding 9.03 by hand yields 9.029999999999999, which the whole-shekel
  // clamp below would then have to defend against for the wrong reason.
  const rounded = roundMoney(target * eased);
  return Number.isInteger(target) ? Math.round(rounded) : rounded;
}

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

export interface SavingsCelebration {
  /** The savings row itself — the trigger, and where the confetti launches from. */
  row: HTMLElement;
  /** The block the confetti falls through; gets `position:relative` if it has none. In the
   *  checkout this is the whole summary footer, so the pieces fall past the total and the pay
   *  button before the stage clips them. */
  host: HTMLElement;
  /** The row whose TOP border is the rule under the savings line. */
  ruleRow: HTMLElement;
  /** The element holding the formatted amount, and the figure + formatter behind it.
   *  A GETTER, not a number: the cart re-renders between arming this and the shopper reaching
   *  the row (a price refresh, a quantity change, a coupon), so the figure to count up to is
   *  whatever is true at the moment it fires — never the one that was true when the page
   *  loaded. Getting that wrong would put a stale amount on screen on a money surface. */
  amountEl: HTMLElement;
  target: () => number;
  format: (n: number) => string;
}

/**
 * Arms the moment. Returns a function that cancels the pending trigger — call it if the row
 * stops being celebratory (the saving drops to zero) before it ever fired.
 *
 * The caller does NOT have to check whether the row is visible or whether there is anything to
 * celebrate: a `display:none` element never intersects, so a cart with no saving silently never
 * fires this and needs no second condition anywhere.
 */
export function armSavingsCelebration(c: SavingsCelebration): () => void {
  if (reduced() || typeof IntersectionObserver === 'undefined') return () => undefined;

  let settleTimer: number | undefined;
  let fired = false;

  const fire = () => {
    if (fired) return;
    fired = true;
    observer.disconnect();

    if (getComputedStyle(c.host).position === 'static') c.host.style.position = 'relative';
    if (getComputedStyle(c.ruleRow).position === 'static') c.ruleRow.style.position = 'relative';

    const stage = makeStage(c.host);
    // Relative to the STAGE, not the host — the stage now starts above the host, and measuring
    // against the wrong box is exactly how the launch ended up outside the clip once already.
    const stageTop = stage.getBoundingClientRect().top;
    const rowRect = c.row.getBoundingClientRect();
    const originTop = rowRect.top - stageTop + rowRect.height / 2;

    sweepCandyRule(c.ruleRow, 2600);
    countUp(c.amountEl, c.target(), c.format);
    void releaseConfetti(stage, originTop).then(() => stage.remove());
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        // Not fired here: a fast scroll crosses this threshold on its way past, and a
        // celebration for a row the shopper never stopped at is the "appears for a second"
        // complaint in a different costume.
        settleTimer ??= window.setTimeout(fire, SETTLE_MS);
      } else {
        window.clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    }
  }, { threshold: 0.85 });
  observer.observe(c.row);

  return () => {
    window.clearTimeout(settleTimer);
    observer.disconnect();
  };
}
