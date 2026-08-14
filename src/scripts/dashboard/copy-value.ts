/**
 * Behaviour for `components/dashboard/CopyButton.astro` — copy the current text
 * of another element to the clipboard.
 *
 * Delegated on the document and registered exactly once, because these buttons
 * live in two different lifetimes: one is in the dashboard header, rendered with
 * the page, and the rest are inside the settings panel, which is fetched on the
 * click that opens it. Binding per element would need a re-bind on every panel
 * fill; delegation needs none.
 *
 * The tick only appears on an actual successful write. `navigator.clipboard` is
 * undefined on an insecure origin and rejects when the permission is refused,
 * and in both cases nothing reached the clipboard — showing "copied" there would
 * send a seller off to paste an address he does not have.
 */

/** How long the tick stays up. Long enough to register, short enough that a
 *  second copy of a different value can't be read as the first one's tick. */
const TICK_MS = 1500;

const timers = new WeakMap<HTMLElement, number>();

function showCopied(btn: HTMLElement): void {
  // `.hidden` the class, not the attribute — see the note in CopyButton.astro.
  const idle = btn.querySelector<SVGElement>('[data-copy-icon="idle"]');
  const done = btn.querySelector<SVGElement>('[data-copy-icon="done"]');
  const status = btn.querySelector<HTMLElement>('[data-copy-status]');
  const copiedLabel = btn.dataset.copyCopiedLabel ?? '';
  idle?.classList.add('hidden');
  done?.classList.remove('hidden');
  if (status) status.textContent = copiedLabel;
  if (copiedLabel) btn.setAttribute('aria-label', copiedLabel);

  clearTimeout(timers.get(btn));
  timers.set(btn, window.setTimeout(() => {
    idle?.classList.remove('hidden');
    done?.classList.add('hidden');
    if (status) status.textContent = '';
    const label = btn.dataset.copyLabel ?? '';
    if (label) btn.setAttribute('aria-label', label);
  }, TICK_MS));
}

export function initCopyValueButtons(): void {
  document.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLElement>('[data-copy-from]');
    if (!btn) return;
    const source = document.getElementById(btn.dataset.copyFrom ?? '');
    // `textContent`, trimmed: the value is rendered inside a `<code>` that the
    // template may have indented across lines.
    const value = (source?.textContent ?? '').trim();
    if (!value) return;
    // What is copied is exactly what is displayed, character for character. A
    // copy button that quietly adds a scheme (or strips one) hands over a string
    // the seller never saw, and he has no way to tell that it differs from the
    // one he was looking at when he pressed it.
    navigator.clipboard?.writeText(value).then(() => showCopied(btn), () => { /* see header */ });
  });
}
