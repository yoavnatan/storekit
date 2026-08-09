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
  });

  it('announces through a region that CONTAINS the label, so progress is heard', () => {
    // `role="status"` used to sit on the dots, with the percentage written to a sibling span — so
    // the live region's own contents never changed and a screen reader announced nothing after the
    // first render. The dots are decorative; the words are the message.
    const job = busyButton(btn, 'מסיר רקע…');
    const region = btn.querySelector('[role="status"]')!;
    expect(region.querySelector('[data-busy-label]')).not.toBeNull();
    expect(btn.querySelector('.dot-pulse')?.getAttribute('aria-hidden')).toBe('true');
    job.setProgress(0.5);
    expect(region.textContent).toContain('50%');
  });

  it('cannot break out of an attribute, whatever the label contains', () => {
    // Every caller today passes a dictionary constant, so this was never live — but this module is
    // the one definition every dashboard button uses and its parameter is a plain string. The
    // version that built its markup with `innerHTML` put the label into `aria-label="${label}"`
    // unescaped, which is the exact shape this repo's review list calls out.
    const hostile = '" onfocus="alert(1)" x="';
    const job = busyButton(btn, hostile);
    expect(btn.querySelector('[data-busy-label]')!.textContent).toBe(hostile);
    expect(btn.querySelector('[onfocus]')).toBeNull();
    // Ask the DOM, not the serialized string. `innerHTML` escapes `&`, `<` and `>` in a text node
    // but leaves `"` alone — it does not need escaping there — so a hostile label round-tripping
    // correctly as TEXT still puts the characters `onfocus="alert(1)"` in that string while being
    // completely inert. Substring-matching the serialization therefore fails on the implementation
    // that is actually safe, and would pass on an escaped-but-still-interpolated one. What "cannot
    // break out" means is that no ELEMENT gained an attribute, so that is what gets asserted — and
    // over every handler attribute rather than the one this payload happens to use.
    const attrs = [...btn.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name));
    expect(attrs.filter((n) => n.startsWith('on'))).toEqual([]);
    job.done();
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
