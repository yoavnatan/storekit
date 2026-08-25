import { busyLabel } from '../../lib/busy-label.js';

/**
 * A button that is WORKING — the one in-flight treatment for the dashboard's image actions.
 *
 * The recipe is the project's own (`components/buttons.css`): three pulsing dots, never a spinner,
 * plus `.btn--busy` for `cursor: progress` — which says "busy" rather than "disabled", and is the
 * distinction that stylesheet's header draws. What this module adds is a PERCENTAGE, because the
 * two actions it serves are the only ones here that can run for tens of seconds: the first
 * background removal downloads a multi-megabyte model, and a blind wait that long reads as a hang
 * rather than as work.
 *
 * It is a module because the same eight lines already existed privately inside `store-image.ts` and
 * were about to exist again, differently, inside `header-logo.ts` — the shape this repo has been
 * bitten by before (safe-redirect, secret-compare: correct in most places, missing from one). One
 * definition, and the dots, the cursor and the percent arrive together or not at all.
 */


export interface BusyButton {
  /** 0–1. Rounded to whole percent, appended to the label. Called as often as the worker reports;
   *  writing the same text twice is free, so callers do not have to throttle. */
  setProgress(fraction: number): void;
  /** Restore the button exactly as it was — label, icon, and its own previous disabled state.
   *  Idempotent, so a `finally` that runs after an early return cannot double-restore. */
  done(): void;
  /**
   * Say it WORKED, in the button, and settle back.
   *
   * The alternative is a toast, and for an action the person is looking straight at that means
   * travelling to the corner of the screen to report something that happened under their cursor
   * (owner, 2026-08-25, about the payout form). `.btn--confirmed` is this project's existing
   * recipe for a disabled state that is really a brief success — `components/buttons.css` names it
   * beside the rule that a plain disabled look is the wrong one here.
   *
   * Idempotent with `done()`: whichever runs first wins, so a `finally { done() }` after a
   * confirm does not snatch the confirmation away.
   */
  confirm(label: string, holdMs?: number): void;
}

/**
 * Put `btn` into its busy state and hand back the two controls for it.
 *
 * The whole `innerHTML` is captured and restored rather than just the text: these buttons carry an
 * inline SVG icon, and a text-only restore would silently strip it the first time the action ran.
 */
export function busyButton(btn: HTMLButtonElement, label: string): BusyButton {
  const before = btn.innerHTML;
  const wasDisabled = btn.disabled;
  let restored = false;

  btn.disabled = true;
  btn.classList.add('btn--busy');

  /* Built with DOM calls rather than an `innerHTML` string, for two reasons that were both wrong in
     the version this replaced.
     (1) `label` went into `aria-label="${label}"` unescaped. Every caller today passes a dictionary
         constant so nothing was exploitable, but this module exists to be THE definition every
         dashboard button uses, its parameter is an ordinary `string`, and a later caller passing a
         store or product name would have had an attribute breakout. This repo's own review list
         names that exact shape — an escaper missing inside `attr="…"` — and its history is a rule
         that was right everywhere but one place. `textContent` cannot have the bug at all, so the
         sink is removed rather than escaped.
     (2) `role="status"` sat on the DOTS while the percentage was written to a SIBLING span, so the
         live region announced nothing when progress changed — the previous comment claimed the
         opposite and the tests only checked the text, so it passed while being false. The region is
         now the wrapper, which CONTAINS the label, so an update to the percentage is what the
         screen reader hears. The dots become decorative: the words beside them already say it. */
  const live = document.createElement('span');
  live.style.cssText = 'display:inline-flex;align-items:center;gap:0.5em';
  live.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.setAttribute('data-busy-label', '');
  // `busyLabel`, not the raw one: the dots below animate three of their own, and every caller's
  // dictionary entry ("מסיר רקע…") writes an ellipsis. This used to strip it only for `base`
  // further down, i.e. only once a percentage arrived — so the seconds BEFORE the first progress
  // report, which is most of a short run, showed six dots. See lib/busy-label.ts.
  text.textContent = busyLabel(label);

  const dots = document.createElement('span');
  dots.className = 'dot-pulse';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot-pulse__dot';
    dots.appendChild(dot);
  }

  live.append(text, dots);
  btn.replaceChildren(live);

  const base = busyLabel(label);
  return {
    setProgress(fraction: number): void {
      if (restored) return;
      const el = btn.querySelector<HTMLElement>('[data-busy-label]');
      if (!el) return;
      const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      // `dir="ltr"` on the number: a percentage beside Hebrew is a Latin run, and left to the
      // paragraph direction the sign lands on the wrong side of the digits.
      el.textContent = `${base} `;
      const num = document.createElement('span');
      num.dir = 'ltr';
      num.textContent = `${pct}%`;
      el.appendChild(num);
    },
    done(): void {
      if (restored) return;
      restored = true;
      btn.classList.remove('btn--busy');
      btn.disabled = wasDisabled;
      btn.innerHTML = before;
    },
    confirm(label: string, holdMs = 1800): void {
      if (restored) return;
      restored = true;
      btn.classList.remove('btn--busy');
      btn.classList.add('btn--confirmed');
      // Disabled DURING the confirmation on purpose: the action just succeeded, so a second press
      // in that second would be a duplicate submit of the same form. `.btn--confirmed` is what
      // keeps it from reading as the ordinary greyed-out disabled (buttons.css).
      btn.disabled = true;
      const tick = document.createElement('span');
      tick.style.cssText = 'display:inline-flex;align-items:center;gap:0.4em';
      tick.setAttribute('role', 'status');
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('width', '15');
      mark.setAttribute('height', '15');
      mark.setAttribute('viewBox', '0 0 24 24');
      mark.setAttribute('fill', 'none');
      mark.setAttribute('stroke', 'currentColor');
      mark.setAttribute('stroke-width', '2.5');
      mark.setAttribute('stroke-linecap', 'round');
      mark.setAttribute('stroke-linejoin', 'round');
      mark.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      path.setAttribute('points', '20 6 9 17 4 12');
      mark.appendChild(path);
      const words = document.createElement('span');
      // `textContent`, never an interpolated string — the same reason the busy label is built with
      // DOM calls: this module is the definition every dashboard button uses, and a later caller
      // passing a store name into an attribute is the breakout its header already argues about.
      words.textContent = label;
      tick.append(mark, words);
      btn.replaceChildren(tick);
      window.setTimeout(() => {
        btn.classList.remove('btn--confirmed');
        btn.disabled = wasDisabled;
        btn.innerHTML = before;
      }, holdMs);
    },
  };
}
