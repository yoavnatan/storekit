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
  };
}
