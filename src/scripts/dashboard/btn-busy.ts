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

/** The label text with any trailing ellipsis removed, so a percentage can be appended without
 *  producing "מסיר רקע… 40%". */
function stem(label: string): string {
  return label.replace(/[.…]+$/, '').trimEnd();
}

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
  // `role="status"` on the dots and an aria-label carrying the action: a screen reader hears what
  // is happening, and the percentage below updates the same live region rather than a second one.
  btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.5em">`
    + `<span data-busy-label>${label}</span>`
    + `<span class="dot-pulse" role="status" aria-label="${label}">`
    + `<span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span>`
    + `</span></span>`;

  const base = stem(label);
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
