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

import { scrollRowBackIntoView } from './scroll-utils.js';

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
 * The floating "you haven't saved this" notice — a SENTENCE, naming the section it means.
 *
 * Why it exists (reported 2026-08-05): switching tabs loses nothing — panels are hidden, not
 * destroyed, so every value is still sitting in its form — and that is exactly why nothing spoke up.
 * The seller had no way to KNOW a change was pending once they walked away from the panel. The only
 * signal was `beforeunload`: once, at the very end, in the browser's own words, about "changes" it
 * cannot name. That warns about losing work; it does not answer "did I save that".
 *
 * **A marker was tried first and rejected by the owner, and the reason is the design rule here:** a
 * coloured dot on the tab collided with the dot the messages tab already uses for unread messages,
 * so it read as "something is waiting for you", and a seller who has never met an editor's
 * unsaved-document convention cannot learn what a second dot means. Words, or nothing.
 *
 * The section's name is the TAB'S OWN LABEL, read at runtime. No panel needs a second name in
 * `translations.ts` that could drift from the tab it describes — and a section renamed in one place
 * is renamed here too, for free.
 */
function i18nDash(key: string, fallback: string): string {
  try {
    return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard?.[key] ?? fallback;
  } catch { return fallback; }
}

/** The visible text of a tab button — its icon is an <svg>, so `textContent` is already the label. */
function tabLabel(tab: Element): string {
  return (tab.textContent ?? '').trim();
}

/** Where the notice sends the seller: the panel holding the FIRST unsaved form, in tab order. */
let noticeTarget: HTMLElement | null = null;

/**
 * Recompute the notice. Cheap — one snapshot per guarded form, and there are three of them.
 *
 * Only ever writes when something actually changed, so a keystroke that leaves the state alone
 * doesn't rewrite a live region a screen reader is watching (`aria-live="polite"` would re-announce
 * an identical sentence) or re-run layout on a fixed element.
 */
function refreshUnsavedNotice(): void {
  const bar = document.getElementById('dash-unsaved-bar');
  const msgEl = document.getElementById('dash-unsaved-msg');
  if (!bar || !msgEl) return;

  const dirtyTabs: HTMLElement[] = [];
  for (const tab of document.querySelectorAll<HTMLElement>('.dash-tab')) {
    // `.dash-panel` names its own tab through `aria-labelledby` — the mapping already exists for
    // accessibility, so nothing new has to be kept in sync with the markup.
    const panel = document.querySelector<HTMLElement>(`.dash-panel[aria-labelledby="${tab.id}"]`);
    if (panel && Array.from(panel.querySelectorAll<HTMLFormElement>(GUARDED)).some(isDirty)) dirtyTabs.push(tab);
  }

  noticeTarget = dirtyTabs[0] ?? null;
  const message = !noticeTarget ? ''
    : dirtyTabs.length > 1
      ? i18nDash('unsavedNoticeMany', 'You have unsaved changes in more than one place')
      : i18nDash('unsavedNotice', 'You have unsaved changes in {section}')
          .replace('{section}', tabLabel(noticeTarget));

  if (msgEl.textContent !== message) msgEl.textContent = message;
  bar.classList.toggle('!hidden', !message);
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
  // exists; these run in BUBBLE, after it changed, so the notice reflects the new state. `input`
  // covers typing and `announceValueChange`; `change` covers a checkbox, a select and a file pick.
  document.addEventListener('input', refreshUnsavedNotice);
  document.addEventListener('change', refreshUnsavedNotice);

  // Take the seller to the section, and to the button — but never press it for them. A floating
  // control that submitted a form they cannot see would be the opposite of the clarity this is for.
  document.getElementById('dash-unsaved-go')?.addEventListener('click', () => {
    const tab = noticeTarget;
    if (!tab) return;
    tab.click();   // the tab's own handler owns panel switching (ui.ts) — don't reimplement it
    const panel = document.querySelector<HTMLElement>(`.dash-panel[aria-labelledby="${tab.id}"]`);
    const submit = panel?.querySelector<HTMLElement>('form[data-unsaved-guard] [type="submit"]');
    if (!submit) return;
    // The house helper, not `scrollIntoView`: it accounts for the fixed header (which would
    // otherwise cover the button it just scrolled to) and it does NOTHING when the button is
    // already fully on screen — pressing a notice about the section you are looking at must not
    // move the page. `animateScrollTo` underneath it, because the root's smooth scroll-behavior
    // breaks rAF scrolling (scroll-utils.ts owns both facts).
    scrollRowBackIntoView(submit);
    submit.focus();
  });

  window.addEventListener('dash:saved', (e) => {
    const form = (e as CustomEvent<{ form?: HTMLFormElement }>).detail?.form;
    if (form) baselines.set(form, snapshot(form));
    refreshUnsavedNotice();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
