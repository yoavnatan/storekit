/**
 * @vitest-environment jsdom
 *
 * A button that is working, and the two things that made it worth extracting from `store-image.ts`
 * rather than copied into `header-logo.ts`.
 *
 * **It restores `innerHTML`, not text.** These buttons now carry an inline SVG icon, and the
 * obvious version of this helper — save `textContent`, put it back — strips the icon the first time
 * the action runs. Nothing throws; the button simply loses its icon and never gets it back until
 * the page reloads, which is exactly the kind of defect a diff review reads straight past.
 *
 * **It reports a percentage.** Background removal downloads a multi-megabyte model on its first
 * run, so this is the one dashboard action that can sit for tens of seconds, and a silent wait that
 * long reads as a hang.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { busyButton } from '../src/scripts/dashboard/btn-busy.js';

const ICON = '<svg aria-hidden="true"><path d="M1 1"></path></svg>';
let btn: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = `<button class="btn btn--sm">${ICON}התאם תמונה</button>`;
  btn = document.querySelector('button')!;
});

describe('busyButton', () => {
  it('shows the dots and marks the button busy rather than merely disabled', () => {
    busyButton(btn, 'מסיר רקע…');
    expect(btn.disabled).toBe(true);
    // `cursor: progress`, per buttons.css — "busy" and "disabled" are different states and the
    // stylesheet distinguishes them.
    expect(btn.classList.contains('btn--busy')).toBe(true);
    expect(btn.querySelectorAll('.dot-pulse__dot')).toHaveLength(3);
    expect(btn.querySelector('.dot-pulse')?.getAttribute('role')).toBe('status');
  });

  it('puts the ICON back, not just the words', () => {
    const before = btn.innerHTML;
    const job = busyButton(btn, 'טוען…');
    expect(btn.innerHTML).not.toContain('<svg');
    job.done();
    expect(btn.innerHTML).toBe(before);
    expect(btn.innerHTML).toContain('<svg');
  });

  it('appends a whole percent, and keeps the digits running left-to-right', () => {
    const job = busyButton(btn, 'מסיר רקע…');
    job.setProgress(0.4237);
    const label = btn.querySelector<HTMLElement>('[data-busy-label]')!;
    expect(label.textContent).toBe('מסיר רקע 42%');
    // A Latin run inside a Hebrew sentence: without `dir`, the paragraph direction puts the sign on
    // the wrong side of the number.
    expect(label.querySelector('span')?.getAttribute('dir')).toBe('ltr');
    // The ellipsis is stripped so it cannot read "מסיר רקע… 42%".
    expect(label.textContent).not.toContain('…');
  });

  it('clamps a progress report that is out of range instead of printing it', () => {
    const job = busyButton(btn, 'טוען…');
    job.setProgress(1.4);
    expect(btn.querySelector('[data-busy-label]')!.textContent).toBe('טוען 100%');
    job.setProgress(-2);
    expect(btn.querySelector('[data-busy-label]')!.textContent).toBe('טוען 0%');
  });

  it('restores the button\'s OWN previous disabled state, not a blanket enable', () => {
    // A button that was already disabled — hidden behind a missing image, say — must not come back
    // clickable just because an action finished on it.
    btn.disabled = true;
    const job = busyButton(btn, 'טוען…');
    job.done();
    expect(btn.disabled).toBe(true);
  });

  it('is idempotent, and deaf after it is done', () => {
    // `done()` runs in a `finally` that can follow an early return, so a second call must not
    // restore stale markup over whatever the caller re-rendered — and a late progress report from
    // an abandoned worker must not write into a button that has moved on.
    const job = busyButton(btn, 'טוען…');
    job.done();
    btn.innerHTML = 'משהו אחר';
    job.done();
    job.setProgress(0.9);
    expect(btn.innerHTML).toBe('משהו אחר');
  });
});
