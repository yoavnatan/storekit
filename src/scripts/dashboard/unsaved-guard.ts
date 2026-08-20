/**
 * Unsaved work in the seller dashboard: knowing about it, being told about it, and getting back.
 *
 * Panels are swapped client-side (ui.ts toggles [hidden], no navigation), so moving between tabs
 * never drops anything — the only way typed-but-unsaved input disappears is the document itself
 * going away: tab closed, reloaded, or navigated off.
 *
 * Dirty = a guarded form's current field values differ from the baseline taken the moment the seller
 * first touched it. Diffing (rather than "an input event fired") means typing something and undoing
 * it leaves no warning behind. A form opts in with `data-unsaved-guard`. How each goes clean again:
 *  - product inline edit / add product: a successful save closes the surface, and a hidden surface is
 *    skipped below — the same reason Cancel needs no signal here.
 *  - settings: the form stays on screen after saving, so its save path fires `dash:saved` with the
 *    form and the baseline is retaken.
 *
 * Three things come out of that one piece of knowledge, and they answer different questions:
 *  1. `beforeunload` — "you are about to LOSE this". Last resort, fires once, and the browser insists
 *     on its own generic wording; a custom message is not possible, which is why it cannot be the
 *     whole answer.
 *  2. The floating notice — "did I save that?", answered continuously and in words, but only for a
 *     section that is off screen (see `refreshUnsavedNotice`).
 *  3. `discardChanges` — "how do I get back?", which had no answer at all before 2026-08-05 except
 *     reloading the page.
 */

import { scrollRowBackIntoView } from './scroll-utils.js';

const GUARDED = 'form[data-unsaved-guard]';

/** One field as it stood at the last save: enough to compare against, and enough to put back. */
interface FieldState { name: string; type: string; value: string; checked: boolean; }

/**
 * Each guarded form's last-saved state, FIELD BY FIELD rather than as one comparable string.
 *
 * It used to be the string alone, which is all "are we dirty" needs. "Discard changes" has to write
 * the values back, and the obvious way — `form.reset()` — turns out to restore nothing that matters
 * here: a `type="hidden"` input has value mode "default", so assigning `.value` writes the content
 * attribute too and its `defaultValue` moves with it. The image cropper and both category pickers
 * keep everything they own in hidden inputs. Caught by a test on 2026-08-05, not in production.
 */
const baselines = new WeakMap<HTMLFormElement, FieldState[]>();

/**
 * A value as the save would actually store it, so an edit that changes nothing real
 * raises nothing. Text is trimmed because every API behind these forms trims it too
 * (api/store.ts, api/product.ts) — a stray trailing space saves the identical record,
 * and warning about that is the kind of false alarm that gets the whole prompt ignored.
 * Numbers are compared numerically, so 10 → 10.0 is not "a change" either.
 */
function fieldValue(f: { type: string; value: string }): string {
  const v = f.value.trim();
  if (f.type !== 'number' || v === '') return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : String(n);
}

/** Every named, enabled field's RAW state, in document order. Raw, because this is also what gets
 *  written back on discard — the normalising that comparison needs must never reach the DOM. */
function capture(form: HTMLFormElement): FieldState[] {
  const out: FieldState[] = [];
  for (const el of Array.from(form.elements)) {
    const f = el as HTMLInputElement;
    if (!f.name || f.disabled) continue;
    // A File cannot be serialised or restored, so it is tracked by count only — and re-picking the
    // same file is not a change worth a prompt either way.
    out.push({
      name: f.name, type: f.type, checked: f.checked,
      value: f.type === 'file' ? String(f.files?.length ?? 0) : f.value,
    });
  }
  return out;
}

/** The comparable form of a capture — where trimming and numeric equality live. */
function serialize(states: FieldState[]): string {
  return states
    .map((f) => (f.type === 'checkbox' || f.type === 'radio' ? `${f.name}=${f.checked}` : `${f.name}=${fieldValue(f)}`))
    .join('\x01');
}

function snapshot(form: HTMLFormElement): string {
  return serialize(capture(form));
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
  if (form && !baselines.has(form)) baselines.set(form, capture(form));
}

/** Is this ONE form holding unsaved work right now. */
function isDirty(form: HTMLFormElement): boolean {
  const base = baselines.get(form);
  return !!base && isLive(form) && serialize(base) !== snapshot(form);
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
/**
 * A tab's NAME — not everything inside it.
 *
 * `textContent` swept up the alert badge too, so with six stock alerts the notice read
 * "יש שינויים שלא שמרת במוצרים6" (owner, 2026-08-20). The badge is a `<span>` and the name is a
 * bare text node, so taking only the direct text children is exact rather than a list of things to
 * exclude — which matters because the badges arrived after this function did, and the next one to
 * be added would have re-broken an exclusion list without touching this file.
 */
function tabLabel(tab: Element): string {
  const own = [...tab.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
  // A tab that wraps its label in an element instead has nothing to take here; the whole
  // textContent is still a better answer than an empty notice.
  return own || (tab.textContent ?? '').trim();
}

/** Where the notice sends the seller: the panel holding the FIRST unsaved form, in tab order. */
let noticeTarget: HTMLElement | null = null;

/** Everything that answers "is there unsaved work, and where" — the notice and the way back.
 *  One entry point so no trigger can update half the answer. */
function refreshState(): void {
  refreshUnsavedNotice();
  refreshDiscardButtons();
}

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
    // **Only a panel the seller cannot currently see.** Standing in the section, looking at the form
    // and its own save button, a floating bar announcing that section is noise — it tells them what
    // is already in front of them, and a notice that is sometimes noise gets dismissed as noise
    // always. The gap this exists for is the OTHER case: the edit that is real but off-screen.
    // (`hasUnsavedChanges` below deliberately does NOT filter this way — `beforeunload` must still
    // speak for the panel the seller is looking at.)
    if (!panel?.hidden) continue;
    if (Array.from(panel.querySelectorAll<HTMLFormElement>(GUARDED)).some(isDirty)) dirtyTabs.push(tab);
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
 * Put a form back to what was last SAVED, and tell the page it happened.
 *
 * Asked for on 2026-08-05: the notice said "you have unsaved changes" and there was no way back
 * except reloading the page, which no seller is going to guess is the answer.
 *
 * Writes the remembered state back field by field. `form.reset()` was the obvious implementation and
 * is the wrong one — see `baselines`: it cannot restore a `type="hidden"` input, which is where the
 * image cropper and both category pickers keep everything they own. The baseline is re-taken on
 * `dash:saved`, so "discard" always means "back to the last save", never "back to how the page
 * loaded" — which would quietly undo a save made minutes ago and then write the stale values back.
 *
 * Matched by NAME through a queue rather than by position, so a form that gained or lost a field
 * since the baseline was taken restores what it can instead of writing values into the wrong inputs.
 *
 * Two events go out, and they are not the same statement:
 *  - `dash:fieldsrewritten` — "this form's fields were replaced under you, repaint". Widgets that
 *    paint from a field (the image cropper, both category pickers) redraw from this. It is fired
 *    here AND by the draft-restore in FormFallbackGuard.astro, which does the same thing for a
 *    different reason, so the widgets serve both without knowing either.
 *  - `dash:discarded` — "the seller threw this work away on purpose", which only makes sense here.
 *    FormFallbackGuard listens for it to delete its stored copy: a draft offered back after an
 *    explicit, confirmed discard would be the page arguing with a decision the seller just made.
 *
 * Both fire AFTER the values are back — unlike the native `reset` event, which fires BEFORE and
 * would show every listener the values it is about to replace.
 */
export function discardChanges(form: HTMLFormElement): void {
  const base = baselines.get(form);
  if (!base) return;
  const queue = new Map<string, FieldState[]>();
  for (const f of base) {
    const list = queue.get(f.name);
    if (list) list.push(f); else queue.set(f.name, [f]);
  }
  for (const el of Array.from(form.elements)) {
    const f = el as HTMLInputElement;
    if (!f.name || f.disabled || f.type === 'file') continue;
    const want = queue.get(f.name)?.shift();
    if (!want || want.type !== f.type) continue;
    if (f.type === 'checkbox' || f.type === 'radio') f.checked = want.checked;
    else f.value = want.value;
  }
  form.dispatchEvent(new CustomEvent('dash:fieldsrewritten', { bubbles: true }));
  form.dispatchEvent(new CustomEvent('dash:discarded', { bubbles: true }));
  refreshState();
}

/** Offer the way back only while there IS one: a "discard" that discards nothing is a control that
 *  teaches the seller its button does nothing. Disabled rather than hidden, so it does not shift the
 *  save button beside it and so its existence is discoverable before it is needed. */
function refreshDiscardButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-discard][form]')) {
    const form = document.getElementById(btn.getAttribute('form')!) as HTMLFormElement | null;
    btn.disabled = !form || !isDirty(form);
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
  // Published for the ONE caller that cannot import it: the inline draft guard
  // (components/dashboard/FormFallbackGuard.astro), whose whole contract is running on a load where
  // this module never arrived. Same seam, and the same reason, as __dashTabActivate — it falls back
  // to a plain scrollIntoView when this is absent, and takes the chrome-aware version when it is
  // not, rather than carrying a second copy of scroll-utils' measurements inline.
  window.__dashScrollTo = (el: HTMLElement): void => scrollRowBackIntoView(el);

  document.addEventListener('focusin', (e) => remember(e.target), true);
  document.addEventListener('pointerdown', (e) => remember(e.target), true);

  // Both phases matter: `remember` above runs in CAPTURE, before the value changes, so a baseline
  // exists; these run in BUBBLE, after it changed, so the notice reflects the new state. `input`
  // covers typing and `announceValueChange`; `change` covers a checkbox, a select and a file pick.
  document.addEventListener('input', refreshState);
  document.addEventListener('change', refreshState);

  // A panel becoming visible is the other half of "is this section on screen" (DashTabsBoot fires
  // `dashtab:show` on the panel it just revealed, and hides the rest synchronously before that). It
  // fires no input event, so without this the notice would neither appear on walking AWAY from an
  // edited section nor clear on walking back into it.
  document.addEventListener('dashtab:show', refreshState);

  // Delegated at the document rather than bound per button, and that became load-bearing on
  // 2026-08-11: a panel is filled on the click that opens it now, so a "discard" button inside one
  // does not exist when this runs — and a per-button pass would have to be re-run after every fill,
  // which is how a button ends up armed twice and asks twice.
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-discard][form]');
    if (btn) {
      const form = document.getElementById(btn.getAttribute('form')!) as HTMLFormElement | null;
      if (!form || !isDirty(form)) return;
      // Confirmed, because this throws away work the seller typed — and through the site's own
      // modal, never `confirm()`, which is banned here (lib/toast.ts records why).
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: i18nDash('discardTitle', 'Discard changes?'),
          message: i18nDash('discardMsg', 'Everything you changed since the last save will be undone.'),
          okLabel: i18nDash('discardOk', 'Discard'),
          onConfirm: () => discardChanges(form),
        },
      }));
    }
  });

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
    // What was just written IS the state a later "discard" has to come back to.
    if (form) baselines.set(form, capture(form));
    refreshState();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
