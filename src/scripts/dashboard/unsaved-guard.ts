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

/** Is this ONE form holding unsaved work right now. */
function isDirty(form: HTMLFormElement): boolean {
  return baselines.has(form) && isLive(form) && baselines.get(form) !== snapshot(form);
}

/** Exported for tab-sync.ts: a live cross-tab refresh must never redraw over work in progress, and this is already the one place that knows what "in progress" means. */
export function hasUnsavedChanges(): boolean {
  return Array.from(document.querySelectorAll<HTMLFormElement>(GUARDED)).some(isDirty);
}

/**
 * A dot on the TAB whose panel is holding unsaved work.
 *
 * Why it exists (reported 2026-08-05): switching tabs loses nothing — panels are hidden, not
 * destroyed, so the values are all still there — but the seller had no way to KNOW that a change was
 * pending once they walked away from the panel. The only signal was `beforeunload`, which speaks at
 * the very end, in the browser's own words, about "changes" it cannot name. That is a warning about
 * losing work, not an answer to "did I save that?". So the answer is now on screen, continuously.
 *
 * Deliberately the same 7px dot the messages tab already uses for "this tab wants you" — the site
 * had settled that treatment, so this is not a new visual idea. `--color-warning`, not `--color-danger`:
 * unsaved is a state, not a failure. Created only when dirty and removed when clean, rather than
 * rendered hidden and toggled — an injected element that starts visible is a flash, and one that
 * lingers empty is a class waiting to be styled wrong.
 */
const DOT_CLASS = 'dash-tab-unsaved';

function markTab(tab: HTMLElement, dirty: boolean): void {
  const existing = tab.querySelector(`.${DOT_CLASS}`);
  if (dirty === !!existing) return;   // no-op interactions must not touch the DOM
  if (!dirty) { existing?.remove(); return; }
  const dot = document.createElement('span');
  dot.className = DOT_CLASS;
  dot.setAttribute('style', 'position:absolute;top:0.45rem;inset-inline-end:0.6rem;width:7px;height:7px;background:var(--color-warning);border-radius:50%');
  // The label carries the meaning; the dot alone is invisible to a screen reader, and a `title`
  // would fight the tooltip layer. Read out as part of the tab's own accessible name.
  const label = document.createElement('span');
  label.className = 'sr-only';
  label.textContent = unsavedLabel();
  dot.appendChild(label);
  tab.appendChild(dot);
}

function unsavedLabel(): string {
  try {
    return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard?.unsavedTabHint
      ?? 'Unsaved changes';
  } catch { return 'Unsaved changes'; }
}

/** Recompute every tab's dot. Cheap — one snapshot per guarded form, and there are three. */
function refreshTabMarkers(): void {
  const dirtyTabs = new Set<string>();
  for (const form of document.querySelectorAll<HTMLFormElement>(GUARDED)) {
    if (!isDirty(form)) continue;
    // `.dash-panel` names its own tab through `aria-labelledby` — the mapping already exists for
    // accessibility, so nothing new has to be kept in sync with the markup.
    const id = form.closest('.dash-panel')?.getAttribute('aria-labelledby');
    if (id) dirtyTabs.add(id);
  }
  for (const tab of document.querySelectorAll<HTMLElement>('.dash-tab')) {
    markTab(tab, dirtyTabs.has(tab.id));
  }
}

/**
 * Announce that a hidden input's value changed under a script's hand.
 *
 * Assigning `.value` fires nothing — no `input`, no `change`, no attribute mutation an observer
 * could see — so a widget that writes a hidden field (the store image cropper, the category
 * pickers) is invisible to every listener on the page unless it says so. A plain bubbling `input`
 * event is the platform's own vocabulary for exactly this, which is why it is used instead of a
 * private one: anything that already listens for edits is served without being taught a new name.
 */
export function announceValueChange(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function initUnsavedGuard(): void {
  document.addEventListener('focusin', (e) => remember(e.target), true);
  document.addEventListener('pointerdown', (e) => remember(e.target), true);

  // Both phases matter: `remember` above runs in CAPTURE, before the value changes, so a baseline
  // exists; these run in BUBBLE, after it changed, so the dot reflects the new state. `input`
  // covers typing and `announceValueChange`; `change` covers a checkbox, a select and a file pick.
  document.addEventListener('input', refreshTabMarkers);
  document.addEventListener('change', refreshTabMarkers);

  window.addEventListener('dash:saved', (e) => {
    const form = (e as CustomEvent<{ form?: HTMLFormElement }>).detail?.form;
    if (form) baselines.set(form, snapshot(form));
    refreshTabMarkers();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
