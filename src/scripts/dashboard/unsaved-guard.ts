/**
 * One "you have unsaved changes" prompt for the whole seller dashboard.
 *
 * Panels are swapped client-side (ui.ts toggles [hidden], no navigation), so moving
 * between tabs never drops anything — the only way typed-but-unsaved input disappears
 * is the document itself going away: tab closed, reloaded, or navigated off. That is
 * exactly what `beforeunload` covers. It has to stay silent unless something really is
 * unsaved: a prompt on every exit trains the seller to dismiss it without reading.
 *
 * Dirty = a guarded form's current field values differ from the baseline taken the
 * moment the seller first touched it. Diffing (rather than "an input event fired")
 * means typing something and undoing it leaves no warning behind.
 *
 * A form opts in with `data-unsaved-guard`. How each one goes clean again:
 *  - product inline edit / add product: a successful save closes the surface, and a
 *    hidden surface is skipped below — the same reason Cancel needs no signal here.
 *  - settings: the form stays on screen after saving, so its save path fires
 *    `dash:saved` with the form and the baseline is retaken.
 *
 * The browser shows its own generic wording; a custom message is not possible.
 */

const GUARDED = 'form[data-unsaved-guard]';

const baselines = new WeakMap<HTMLFormElement, string>();

/**
 * A value as the save would actually store it, so an edit that changes nothing real
 * raises nothing. Text is trimmed because every API behind these forms trims it too
 * (api/store.ts, api/product.ts) — a stray trailing space saves the identical record,
 * and warning about that is the kind of false alarm that gets the whole prompt ignored.
 * Numbers are compared numerically, so 10 → 10.0 is not "a change" either.
 */
function fieldValue(f: HTMLInputElement): string {
  const v = f.value.trim();
  if (f.type !== 'number' || v === '') return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : String(n);
}

/** Field values as one comparable string. Files are compared by count only — a File can't be serialised, and re-picking the same file is not a change worth a prompt. */
function snapshot(form: HTMLFormElement): string {
  const parts: string[] = [];
  for (const el of Array.from(form.elements)) {
    const f = el as HTMLInputElement;
    if (!f.name || f.disabled) continue;
    if (f.type === 'file') parts.push(`${f.name}=${f.files?.length ?? 0}`);
    else if (f.type === 'checkbox' || f.type === 'radio') parts.push(`${f.name}=${f.checked}`);
    else parts.push(`${f.name}=${fieldValue(f)}`);
  }
  return parts.join('\x01');
}

/**
 * A form only holds unsaved work while its own surface is open. A collapsed edit row
 * or add-product box keeps its markup in the DOM but its edits are discarded anyway,
 * so a hidden ancestor means "not live" — except `.dash-panel`, which is hidden merely
 * because another tab is active: settings edited under one tab must still warn from another.
 */
function isLive(form: HTMLFormElement): boolean {
  for (let el: HTMLElement | null = form; el; el = el.parentElement) {
    if (el.hidden && !el.classList.contains('dash-panel')) return false;
  }
  return true;
}

/** Baselines are taken lazily on first contact: edit rows are built on demand (products.ts), and both events land BEFORE the value they are about to change — including on widgets that write to a hidden input without ever focusing it. */
function remember(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const form = target.closest(GUARDED) as HTMLFormElement | null;
  if (form && !baselines.has(form)) baselines.set(form, snapshot(form));
}

/** Exported for tab-sync.ts: a live cross-tab refresh must never redraw over work in progress, and this is already the one place that knows what "in progress" means. */
export function hasUnsavedChanges(): boolean {
  return Array.from(document.querySelectorAll<HTMLFormElement>(GUARDED)).some(
    (form) => baselines.has(form) && isLive(form) && baselines.get(form) !== snapshot(form),
  );
}

export function initUnsavedGuard(): void {
  document.addEventListener('focusin', (e) => remember(e.target), true);
  document.addEventListener('pointerdown', (e) => remember(e.target), true);

  window.addEventListener('dash:saved', (e) => {
    const form = (e as CustomEvent<{ form?: HTMLFormElement }>).detail?.form;
    if (form) baselines.set(form, snapshot(form));
  });

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
