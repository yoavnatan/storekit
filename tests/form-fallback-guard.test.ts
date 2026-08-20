/**
 * @vitest-environment jsdom
 *
 * The guard in components/dashboard/FormFallbackGuard.astro is a safety net: when it breaks it
 * breaks silently, and the symptom only shows up on the day the dashboard's module graph fails —
 * exactly the day nobody is watching. So the test runs the SHIPPED script, pulled out of the
 * .astro file, rather than a copy of it that could drift.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// From cwd, not import.meta.url — under jsdom that URL is an http: one and can't be resolved to a path.
const SOURCE = resolve(process.cwd(), 'src/components/dashboard/FormFallbackGuard.astro');

const MSG = 'saving is unavailable';
const FOUND = 'unsaved changes from last time';
const RESTORE = 'restore';
const DISCARD = 'dismiss';
const NOTICE = 'unsaved work in {section}';
const NOT_ON_PAGE = 'not on this page';

/**
 * The <script is:inline define:vars={…}> body, with its vars bound the way Astro binds them.
 * Installed ONCE, as the page installs it: jsdom keeps one document for the whole file, so a
 * per-test install would leave a second listener behind — and the second copy sees the first
 * one's preventDefault as "a handler took it" and drops the draft that was just written.
 */
function installGuard(): void {
  const file = readFileSync(SOURCE, 'utf8');
  const body = file.match(/<script is:inline define:vars=\{\{[^}]*\}\}>([\s\S]*?)<\/script>/)?.[1];
  if (!body) throw new Error('guard script not found — did the <script is:inline> tag change?');
  new Function('msg', 'draftFound', 'draftRestore', 'draftDiscard', 'draftNotice', 'draftOpenFailed', body)(
    MSG, FOUND, RESTORE, DISCARD, NOTICE, NOT_ON_PAGE,
  );
}
installGuard();

/** Which of the notice's three buttons are currently offered. */
const noticeButtons = (): string[] =>
  ['dash-draft-go', 'dash-draft-restore', 'dash-draft-discard']
    .filter((id) => !document.getElementById(id)!.classList.contains('!hidden'));

// jsdom ships no layout, so it implements neither of these. Every browser does, and the guard's
// restore path ends by putting the form in front of the seller — so without them the tests would be
// asserting against a script that cannot finish.
Element.prototype.scrollIntoView = vi.fn();

/** The floating notice, as the component server-renders it — the script only ever fills it in.
 *  Its two buttons are the same two the in-form bar carries, and they call the same functions. */
const NOTICE_BAR =
  `<div id="dash-draft-bar" class="!hidden bottom-6">` +
  // The sentence is three server-rendered pieces, with the section's NAME as the control between
  // them — there is no "take me there" button beside it any more (owner, סשן א׳ §3).
  `<span id="dash-draft-msg"><span data-notice-pre></span>` +
  `<button type="button" id="dash-draft-go" class="!hidden"></button>` +
  `<span data-notice-post></span></span>` +
  `<button type="button" id="dash-draft-restore" class="!hidden">${RESTORE}</button>` +
  `<button type="button" id="dash-draft-discard" class="!hidden">${DISCARD}</button></div>` +
  // The two mid-task bars it has to stay clear of, in their resting (hidden) state.
  `<div id="dash-unsaved-bar" class="!hidden"></div><div id="dash-stale-bar" class="!hidden"></div>`;

function render(inner: string, attrs = 'id="settings-form" method="POST" action="/api/store"'): HTMLFormElement {
  document.body.innerHTML =
    `<div id="toast-container"></div><div id="upload-config" data-store-id="s1"></div>` + NOTICE_BAR +
    `<form ${attrs}>${inner}<button type="submit"></button></form>`;
  return document.querySelector('form')!;
}

function submit(form: HTMLFormElement): Event {
  const e = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(e);
  return e;
}

/** Re-runs the load-time half against markup as the server would render it fresh. */
function reload(inner: string, attrs?: string): HTMLFormElement {
  const form = render(inner, attrs);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return form;
}

describe('FormFallbackGuard — blocking the native submit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('alert', vi.fn());
    localStorage.clear();
  });

  it('blocks a submit that no AJAX handler claimed', () => {
    expect(submit(render('')).defaultPrevented).toBe(true);
  });

  it('leaves a submit alone once an AJAX handler has taken it', () => {
    const form = render('');
    form.addEventListener('submit', (ev) => ev.preventDefault());
    submit(form);
    vi.advanceTimersByTime(500);
    expect(globalThis.alert).not.toHaveBeenCalled();
  });

  it('lets a data-native-submit form post the way the browser would', () => {
    const form = render('', 'method="POST" action="/seller/logout" data-native-submit');
    expect(submit(form).defaultPrevented).toBe(false);
  });

  it('tells the seller — via toast when it lives, via alert when it does not', () => {
    const toasts: string[] = [];
    window.addEventListener('toast:show', (e) => toasts.push((e as CustomEvent).detail.title));

    submit(render(''));
    expect(toasts).toEqual([MSG]);

    // Nothing rendered into #toast-container: the toast module is dead too, so fall back.
    vi.advanceTimersByTime(500);
    expect(globalThis.alert).toHaveBeenCalledWith(MSG);
  });

  it('stays quiet when the toast actually rendered', () => {
    const form = render('');
    window.addEventListener('toast:show', () => {
      document.getElementById('toast-container')!.innerHTML = '<div class="toast-card"></div>';
    });
    submit(form);
    vi.advanceTimersByTime(500);
    expect(globalThis.alert).not.toHaveBeenCalled();
  });
});

describe('FormFallbackGuard — keeping the blocked edit', () => {
  const FIELDS = '<input name="name" value="server" /><input type="checkbox" name="saleActive" checked />';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('alert', vi.fn());
    localStorage.clear();
  });

  it('offers the draft back on the next load, and only once accepted', () => {
    const typed = render(FIELDS);
    typed.querySelector<HTMLInputElement>('[name="name"]')!.value = 'what he typed';
    typed.querySelector<HTMLInputElement>('[name="saleActive"]')!.checked = false;
    submit(typed);

    // Reload: the server renders its own values again — nothing is overwritten behind his back.
    const fresh = reload(FIELDS);
    expect(fresh.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('server');

    const bar = fresh.querySelector('[role="status"]')!;
    expect(bar.textContent).toContain(FOUND);

    Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();
    expect(fresh.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('what he typed');
    // The unchecked box comes back unchecked — a checkbox the seller cleared is absent from a
    // FormData snapshot, which would silently re-check it.
    expect(fresh.querySelector<HTMLInputElement>('[name="saleActive"]')!.checked).toBe(false);
    expect(fresh.querySelector('[role="status"]')).toBeNull();
  });

  it('fires input+change so the preview and the unsaved-changes baseline follow', () => {
    const typed = render(FIELDS);
    typed.querySelector<HTMLInputElement>('[name="name"]')!.value = 'x';
    submit(typed);

    const fresh = reload(FIELDS);
    const seen: string[] = [];
    fresh.addEventListener('input', () => seen.push('input'));
    fresh.addEventListener('change', () => seen.push('change'));
    Array.from(fresh.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();
    expect(seen).toContain('input');
    expect(seen).toContain('change');
  });

  it('forgets the draft when dismissed', () => {
    const typed = render(FIELDS);
    typed.querySelector<HTMLInputElement>('[name="name"]')!.value = 'x';
    submit(typed);

    const fresh = reload(FIELDS);
    Array.from(fresh.querySelectorAll('button')).find((b) => b.textContent === DISCARD)!.click();
    expect(reload(FIELDS).querySelector('[role="status"]')).toBeNull();
  });

  it('drops the draft as soon as a real AJAX save takes over', () => {
    const typed = render(FIELDS);
    typed.querySelector<HTMLInputElement>('[name="name"]')!.value = 'x';
    submit(typed);

    const alive = render(FIELDS);
    alive.addEventListener('submit', (ev) => ev.preventDefault());  // handlers attached again
    submit(alive);

    expect(reload(FIELDS).querySelector('[role="status"]')).toBeNull();
  });

  it('does not prompt when the draft matches what the server rendered', () => {
    submit(render(FIELDS));  // blocked without anything being typed
    expect(reload(FIELDS).querySelector('[role="status"]')).toBeNull();
  });

  it('keeps two products’ editors apart', () => {
    const a = '<input type="hidden" name="productId" value="p1" /><input name="name" value="server" />';
    const b = '<input type="hidden" name="productId" value="p2" /><input name="name" value="server" />';
    const attrs = 'method="POST" action="/api/product"';

    const typed = render(a, attrs);
    typed.querySelector<HTMLInputElement>('[name="name"]')!.value = 'p1 draft';
    submit(typed);

    expect(reload(b, attrs).querySelector('[role="status"]')).toBeNull();
    expect(reload(a, attrs).querySelector('[role="status"]')).not.toBeNull();
  });

  it('never writes a password or file field to storage', () => {
    const form = render('<input type="password" name="pw" /><input name="name" value="server" />');
    form.querySelector<HTMLInputElement>('[name="pw"]')!.value = 'hunter2';
    form.querySelector<HTMLInputElement>('[name="name"]')!.value = 'x';
    submit(form);

    expect(JSON.stringify(localStorage)).not.toContain('hunter2');
  });
});

/**
 * The accident this actually protects against. A blocked submit is the rare one — a closed tab, a
 * crashed browser and a machine that lost power are the common ones, and none of them run a line of
 * our code on the way out. So the draft has to already be on disk before the page goes.
 */
describe('FormFallbackGuard — drafting while the seller types', () => {
  const GUARDED = 'id="settings-form" method="POST" action="/api/store" data-unsaved-guard';
  const FIELDS = '<input name="name" value="server" /><input type="hidden" name="logo" value="a.jpg" />';

  /** What a keystroke actually is to this script: a value, then a bubbling input event. */
  function type(form: HTMLFormElement, name: string, value: string): void {
    const el = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function stored(): string[] {
    return Object.keys(localStorage).filter((k) => k.indexOf('dz-draft:') === 0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('alert', vi.fn());
    localStorage.clear();
  });

  it('keeps typing that was never submitted, and offers it on the next load', () => {
    const form = reload(FIELDS, GUARDED);
    type(form, 'name', 'typed, never saved');
    vi.advanceTimersByTime(1000);   // …and here the machine dies

    const fresh = reload(FIELDS, GUARDED);
    expect(fresh.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('server');
    const bar = fresh.querySelector('[role="status"]')!;
    expect(bar.textContent).toContain(FOUND);

    Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();
    expect(fresh.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('typed, never saved');
  });

  it('restores a HIDDEN field and tells the widget that paints from it to repaint', () => {
    // The image cards keep their URL in a `type="hidden"` input by design, so a restore that only
    // wrote the value put the picture back in the form and nothing back on screen — the preview
    // stayed empty and the next save would have written a logo the seller could not see (owner,
    // 2026-08-09: "כשאני לוחץ שחזר התמונה לא חוזרת"). The value is half the job; the event is the
    // other half, and every widget drawing from a field listens for it.
    const form = reload(FIELDS, GUARDED);
    type(form, 'logo', 'https://cdn/new-logo.png');
    vi.advanceTimersByTime(1000);

    const fresh = reload(FIELDS, GUARDED);
    const repaints: string[] = [];
    fresh.addEventListener('dash:fieldsrewritten', () => repaints.push('paint'));
    Array.from(fresh.querySelector('[role="status"]')!.querySelectorAll('button'))
      .find((b) => b.textContent === RESTORE)!.click();

    expect(fresh.querySelector<HTMLInputElement>('[name="logo"]')!.value).toBe('https://cdn/new-logo.png');
    expect(repaints).toEqual(['paint']);
  });

  it('scrolls to what CAME BACK, never to the form, and not at all with nothing to show', () => {
    // A confident scroll to a place with nothing to see reads as "we put it here" and teaches the
    // seller to distrust the restore (owner, 2026-08-09: "הגלילה מרגישה כאילו היא מגיעה לשינוי
    // שאני אמור לראות בעוד שלא בטוח שהוא במעלה הדף"). The settings form IS the whole tab, so
    // centring it landed near its midpoint — reliably not where the restored field is.
    const seen: Element[] = [];
    (window as unknown as { __dashScrollTo?: (el: Element) => void }).__dashScrollTo = (el) => { seen.push(el); };

    const form = reload(FIELDS, GUARDED);
    type(form, 'logo', 'https://cdn/new-logo.png');
    vi.advanceTimersByTime(1000);

    const fresh = reload(FIELDS, GUARDED);
    // Off-screen, which is the branch that scrolls at all: jsdom gives every element a zero rect,
    // so `onScreen` is false and the restore is the "he pressed it from somewhere else" path.
    Array.from(fresh.querySelector('[role="status"]')!.querySelectorAll('button'))
      .find((b) => b.textContent === RESTORE)!.click();

    // A bare hidden input with no labelled container of its own: there is nothing to show, so the
    // page does not move. Falling back to the form is the behaviour being removed.
    expect(seen).toEqual([]);

    // Wrapped in the `.card` the real settings tab puts it in, the same restore scrolls — to the
    // card, which is what the seller actually has to look at.
    localStorage.clear();
    const carded = '<div class="card"><input type="hidden" name="logo" value="a.jpg" /></div><input name="name" value="server" />';
    const f2 = reload(carded, GUARDED);
    type(f2, 'logo', 'https://cdn/other.png');
    vi.advanceTimersByTime(1000);
    const f3 = reload(carded, GUARDED);
    Array.from(f3.querySelector('[role="status"]')!.querySelectorAll('button'))
      .find((b) => b.textContent === RESTORE)!.click();
    expect(seen).toHaveLength(1);
    expect((seen[0] as HTMLElement).className).toBe('card');
    delete (window as unknown as { __dashScrollTo?: unknown }).__dashScrollTo;
  });

  it('debounces — a burst of keystrokes is one write, and nothing is written before it settles', () => {
    const form = reload(FIELDS, GUARDED);
    type(form, 'name', 'a');
    vi.advanceTimersByTime(300);
    expect(stored()).toEqual([]);          // still typing: nothing on disk yet

    type(form, 'name', 'ab');
    vi.advanceTimersByTime(300);
    expect(stored()).toEqual([]);          // the timer restarted, as it should

    vi.advanceTimersByTime(500);
    expect(stored()).toHaveLength(1);
    expect(JSON.stringify(localStorage)).toContain('ab');
  });

  it('flushes what is still pending when the tab is hidden', () => {
    const form = reload(FIELDS, GUARDED);
    type(form, 'name', 'half a word');
    vi.advanceTimersByTime(100);           // well inside the debounce

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(JSON.stringify(localStorage)).toContain('half a word');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('drafts nothing for a form that is not guarded', () => {
    const form = reload(FIELDS, 'id="filters" method="POST" action="/api/x"');
    type(form, 'name', 'a search term');
    vi.advanceTimersByTime(1000);
    expect(stored()).toEqual([]);
  });

  it('forgets the draft the moment the save actually lands', () => {
    const form = reload(FIELDS, GUARDED);
    type(form, 'name', 'x');
    vi.advanceTimersByTime(1000);
    expect(stored()).toHaveLength(1);

    window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form } }));
    expect(stored()).toEqual([]);
  });

  it('forgets the draft when the seller discards on purpose', () => {
    const form = reload(FIELDS, GUARDED);
    type(form, 'name', 'x');
    vi.advanceTimersByTime(1000);

    // unsaved-guard.ts fires this only for a confirmed "discard changes" — never for a restore.
    form.dispatchEvent(new CustomEvent('dash:discarded', { bubbles: true }));
    expect(stored()).toEqual([]);
  });

  it('re-protects the values it just restored', () => {
    const first = reload(FIELDS, GUARDED);
    type(first, 'name', 'recovered');
    vi.advanceTimersByTime(1000);

    const fresh = reload(FIELDS, GUARDED);
    Array.from(fresh.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();
    vi.advanceTimersByTime(1000);
    // Restoring is not saving. A second crash must not be the one that finally loses it.
    expect(JSON.stringify(localStorage)).toContain('recovered');
  });

  it('puts back only the fields he edited — never the rest of the photograph', () => {
    // A dashboard form submits every field it owns, so a draft is a picture of ALL of them. He
    // edits `name` here; meanwhile another tab (or his phone) changes `tagline` and saves.
    const first = reload('<input name="name" value="server" /><input name="tagline" value="old" />', GUARDED);
    type(first, 'name', 'his edit');
    vi.advanceTimersByTime(1000);

    const fresh = reload('<input name="name" value="server" /><input name="tagline" value="from the other tab" />', GUARDED);
    Array.from(fresh.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();

    expect(fresh.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('his edit');
    // The lost update this guards: restoring the whole photograph would put `old` back and the next
    // save would write it, silently undoing the other tab — exactly what lib/record-rev.ts prevents
    // on the server, arriving through a door its per-field merge cannot see.
    expect(fresh.querySelector<HTMLInputElement>('[name="tagline"]')!.value).toBe('from the other tab');
  });

  it('offers nothing when the only difference is a field he never touched', () => {
    const first = reload('<input name="name" value="server" /><input name="tagline" value="old" />', GUARDED);
    type(first, 'name', 'x');
    vi.advanceTimersByTime(1000);

    // He saved `name` from another tab too, so the only thing left differing is `tagline` —
    // which he never edited. There is nothing here to ask him about.
    const fresh = reload('<input name="name" value="x" /><input name="tagline" value="changed elsewhere" />', GUARDED);
    expect(fresh.querySelector('[role="status"]')).toBeNull();
    expect(stored()).toEqual([]);
  });

  /**
   * The bug the owner reported on 2026-08-07: "לערוך משהו ואז השחזור ימחק את מה שהיוזר עשה".
   * The offer's payload was decided at load and applied verbatim, so an older value could land on
   * top of something he had typed while the bar sat there. Newest wins, field by field.
   */
  it('never writes an offered value over something he typed after the offer appeared', () => {
    const first = reload(FIELDS, GUARDED);
    type(first, 'name', 'from the crashed session');
    vi.advanceTimersByTime(1000);

    const fresh = reload(FIELDS, GUARDED);
    type(fresh, 'name', 'what he is typing now');
    Array.from(fresh.querySelectorAll('button')).find((b) => b.textContent === RESTORE)?.click();

    expect(fresh.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('what he is typing now');
  });

  it('takes the offer away once his own typing has answered all of it', () => {
    const first = reload(FIELDS, GUARDED);
    type(first, 'name', 'from the crashed session');
    vi.advanceTimersByTime(1000);

    const fresh = reload(FIELDS, GUARDED);
    expect(fresh.querySelector('[role="status"]')).not.toBeNull();
    type(fresh, 'name', 'he is redoing it himself');
    // A restore button that would now put nothing back is a control teaching him it does nothing.
    expect(fresh.querySelector('[role="status"]')).toBeNull();
  });

  it('does not let his new typing evict the work the bar is still offering', () => {
    const first = reload('<input name="name" value="server" /><input name="tagline" value="old" />', GUARDED);
    type(first, 'name', 'crashed session');
    vi.advanceTimersByTime(1000);

    // The offer for `name` is on screen and unanswered. He starts on a DIFFERENT field — which
    // rewrites the stored draft. Before the union write, that write was the whole form as it stood
    // NOW, so it deleted `name`'s recovered value and the next crash lost it for good.
    const fresh = reload('<input name="name" value="server" /><input name="tagline" value="old" />', GUARDED);
    type(fresh, 'tagline', 'and now this');
    vi.advanceTimersByTime(1000);

    const again = reload('<input name="name" value="server" /><input name="tagline" value="old" />', GUARDED);
    Array.from(again.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();
    expect(again.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('crashed session');
    expect(again.querySelector<HTMLInputElement>('[name="tagline"]')!.value).toBe('and now this');
  });

  it('tells the widgets that paint from a hidden field to repaint', () => {
    const first = reload(FIELDS, GUARDED);
    type(first, 'logo', 'cropped.jpg');   // the cropper writes its hidden input this way
    vi.advanceTimersByTime(1000);

    const fresh = reload(FIELDS, GUARDED);
    let repainted = 0;
    fresh.addEventListener('dash:fieldsrewritten', () => { repainted++; });
    Array.from(fresh.querySelectorAll('button')).find((b) => b.textContent === RESTORE)!.click();
    // Without this the seller sees the old picture above a field holding the new one.
    expect(repainted).toBe(1);
  });
});

/**
 * "אפשר לפספס את זה" (owner, 2026-08-07). The bar lives at the top of the form it belongs to, and
 * that form is usually in a panel he is not looking at — panels are hidden, not destroyed, so an
 * offer in Settings was announced to nobody while he stood in Products.
 */
describe('FormFallbackGuard — the floating notice for an offer he cannot see', () => {
  const FIELDS = '<input name="name" value="server" />';

  /** The dashboard's tab shell, cut down to what the notice actually reads: a tab that names
   *  itself, and a panel that points back at it through `aria-labelledby`. */
  function renderPanels(panels: { tab: string; label: string; open: boolean; form: string }[]): void {
    document.body.innerHTML =
      `<div id="toast-container"></div><div id="upload-config" data-store-id="s1"></div>` + NOTICE_BAR +
      `<div class="dash-tabs">` +
      panels.map((p) => `<button role="tab" id="${p.tab}" data-panel="${p.tab}">${p.label}</button>`).join('') +
      `</div>` +
      panels.map((p) =>
        `<div class="dash-panel" aria-labelledby="${p.tab}"${p.open ? '' : ' hidden'}>${p.form}</div>`).join('');
  }

  function type(name: string, value: string, root: ParentNode = document): void {
    const el = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const noticeText = (): string => document.getElementById('dash-draft-msg')!.textContent ?? '';
  const noticeShown = (): boolean => !document.getElementById('dash-draft-bar')!.classList.contains('!hidden');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('alert', vi.fn());
    localStorage.clear();
    // jsdom does no layout, so `getClientRects()` is empty for every element — which this script
    // reads as "in a closed panel". That is the case under test; the one test that needs the
    // opposite stubs it explicitly.
  });

  /** Leave a draft behind for the settings form, the way a crash would. */
  function leaveDraft(): void {
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'never saved');
    vi.advanceTimersByTime(1000);
  }

  it('names the other tab and LEADS him there — it never answers for a form he cannot see', () => {
    leaveDraft();
    renderPanels([
      { tab: 'tab-products', label: 'Products', open: true, form: '' },
      { tab: 'tab-settings', label: 'Store settings', open: false,
        form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` },
    ]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(noticeShown()).toBe(true);
    expect(noticeText()).toBe('unsaved work in Store settings');
    // Restoring into a closed panel would be a change with nothing on screen to show for it, so
    // the only control out is the section's own name.
    expect(noticeButtons()).toEqual(['dash-draft-go']);
    expect(document.getElementById('dash-draft-go')!.textContent).toBe('Store settings');

    let opened = '';
    document.getElementById('tab-settings')!.addEventListener('click', () => { opened = 'tab-settings'; });
    document.getElementById('dash-draft-go')!.click();

    expect(opened).toBe('tab-settings');
    // It carried him and stopped. The bar he can now see is the one that asks, and it is focused.
    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('server');
    expect(document.activeElement?.textContent).toBe(RESTORE);
  });

  /**
   * The notice's own button used to do NOTHING on a form with no `id` (owner, 2026-08-15: "ההודעה
   * התחתונה לא באמת משחזרת").
   *
   * Its handler recomputes the key at click time, and the key fell back to the form's FIELD NAMES
   * when there was no id — a set that moves, because a product's editor grows named inputs as its
   * gallery, variant rows and tag editor wire themselves up. So the offer was filed under one key
   * and looked up under another: `offers[key]` missed, the handler returned, and the button
   * answered nothing. The same drift wrote the seller's draft under a third key.
   *
   * The form here has no id and gains a field between the scan and the press, which is exactly
   * that sequence.
   */
  const NO_ID = 'method="POST" action="/api/product" data-unsaved-guard';
  const PRODUCT_FIELDS = '<input type="hidden" name="productId" value="p1" /><input name="name" value="server" />';

  it('restores from the notice even after the form has grown a field', () => {
    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form ${NO_ID}>${PRODUCT_FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'never saved');
    vi.advanceTimersByTime(1000);

    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form ${NO_ID}>${PRODUCT_FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(noticeShown()).toBe(true);
    expect(noticeButtons()).toContain('dash-draft-restore');

    // A widget wires itself up after the scan and adds its own named input — the drift.
    const form = document.querySelector('form')!;
    form.insertAdjacentHTML('beforeend', '<input type="hidden" name="images" value="" />');

    document.getElementById('dash-draft-restore')!.click();

    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('never saved');
    // ...and it closed itself, rather than sitting there having done nothing.
    expect(noticeShown()).toBe(false);
    expect(document.querySelector('form [role="status"]')).toBeNull();
  });

  it('gives two same-shaped editors their own draft', () => {
    // Two product rows open at once post to the same endpoint; the record id is what separates
    // them, and where even that repeats an ordinal does.
    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form ${NO_ID}><input type="hidden" name="productId" value="p1" /><input name="name" value="server" /></form>`
          + `<form ${NO_ID}><input type="hidden" name="productId" value="p2" /><input name="name" value="server" /></form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const [a, b] = Array.from(document.querySelectorAll('form'));
    expect(a!.dataset.draftKey).not.toBe(b!.dataset.draftKey);
  });

  it('names the tab without its count bubble', () => {
    // "יש שינויים שלא שמרת במוצרים 3" (owner, 2026-08-15). A tab carries a badge — stock alerts on
    // Products, new orders on Orders — and `textContent` swallows the number along with the label.
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'never saved');
    vi.advanceTimersByTime(1000);

    renderPanels([
      { tab: 'tab-products', label: 'Products', open: true, form: '' },
      { tab: 'tab-settings', label: 'Store settings', open: false,
        form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` },
    ]);
    document.getElementById('tab-settings')!.insertAdjacentHTML('beforeend', '<span class="dash-tab-badge">3</span>');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(noticeText()).toBe('unsaved work in Store settings');
  });

  it('forgets a draft the seller cancelled', () => {
    // Pressing "בטל" in a product's editor is him answering the question already; offering the
    // change back on the next load is the page arguing with him (owner, 2026-08-15). The cancel
    // button announces `dash:discarded`, which is the site's existing word for it.
    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form ${NO_ID}>${PRODUCT_FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'never saved');
    vi.advanceTimersByTime(1000);

    const form = document.querySelector('form')!;
    form.dispatchEvent(new CustomEvent('dash:discarded', { bubbles: true }));

    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form ${NO_ID}>${PRODUCT_FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.querySelector('form [role="status"]')).toBeNull();
    expect(noticeShown()).toBe(false);
  });

  it('says nothing at all on the ordinary load, where there is no draft', () => {
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(noticeShown()).toBe(false);
  });

  it('answers one offer at a time, and the next one takes its place', () => {
    leaveDraft();
    // A second draft, for a product editor — a different form, a different key.
    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form method="POST" action="/api/product" data-unsaved-guard>` +
            `<input type="hidden" name="productId" value="p1" />${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'also never saved');
    vi.advanceTimersByTime(1000);

    const products = { tab: 'tab-products', label: 'Products', open: false,
      form: `<form method="POST" action="/api/product" data-unsaved-guard>` +
            `<input type="hidden" name="productId" value="p1" />${FIELDS}</form>` };
    const settings = { tab: 'tab-settings', label: 'Store settings', open: false,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` };
    renderPanels([products, settings]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Never "in several places": the notice acts on ONE offer, so it needs one subject.
    expect(noticeText()).toBe('unsaved work in Products');

    // He goes to Products and says no there, on that form's own bar. The remaining offer moves up.
    const productsBar = document.querySelector('.dash-panel[aria-labelledby="tab-products"] form [role="status"]')!;
    Array.from(productsBar.querySelectorAll('button')).find((b) => b.textContent === DISCARD)!.click();
    expect(noticeText()).toBe('unsaved work in Store settings');
  });

  it('restores from the bottom bar itself when the form is in the tab he is in', () => {
    leaveDraft();
    // Same tab, scrolled past the bar: nothing to lead him to, so it IS the bar — same words, same
    // buttons, and pressing one performs the act rather than travelling to it.
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(noticeButtons()).toEqual(['dash-draft-restore', 'dash-draft-discard']);
    document.getElementById('dash-draft-restore')!.click();

    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('never saved');
    expect(noticeShown()).toBe(false);
  });

  /**
   * Where the bar SITS stopped being this script's business on 2026-08-20: it reserved a slot per
   * bar, which put a bar's worth of empty air in the stack whenever the reserved slot below it was
   * unfilled (owner, סשן א׳ §3). `scripts/dashboard/bar-stack.ts` computes the offsets from what is
   * actually on screen; this file must not fight it by toggling a position class of its own.
   */
  it('leaves its own position alone — bar-stack.ts owns where it sits', () => {
    leaveDraft();
    renderPanels([
      { tab: 'tab-products', label: 'Products', open: true, form: '' },
      { tab: 'tab-settings', label: 'Store settings', open: false,
        form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` },
    ]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const notice = document.getElementById('dash-draft-bar')!;
    expect(notice.classList.contains('bottom-6')).toBe(true);

    document.getElementById('dash-unsaved-bar')!.classList.remove('!hidden');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    // Still the markup's resting class, untouched — the stack moves it with an inline offset.
    expect(notice.classList.contains('bottom-6')).toBe(true);
    expect(notice.className).not.toContain('9.5rem');
  });

  it('leaves the values alone when he says no from the bottom bar', () => {
    leaveDraft();
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.getElementById('dash-draft-discard')!.click();

    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('server');
    expect(noticeShown()).toBe(false);
    // Gone for good, and not offered again on the next load — the same statement the in-form
    // "delete them" makes, because it is the same function.
    expect(Object.keys(localStorage).filter((k) => k.startsWith('dz-draft:'))).toEqual([]);
  });

  it('drops the section name when the offer is in the tab he is already standing in', () => {
    leaveDraft();
    // Open tab, but scrolled past the bar (jsdom reports no boxes, i.e. not on screen) — so the
    // notice is up. Telling him it is "in Store settings" would name where he already is.
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(noticeShown()).toBe(true);
    expect(noticeText()).toBe(FOUND);   // word for word what the bar inside the form says
  });

  it('does not move the page when he answers the bar he is looking at', () => {
    leaveDraft();
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    const rect = { top: 300, bottom: 340, left: 0, right: 100, width: 100, height: 40, x: 0, y: 300 };
    Element.prototype.getClientRects = function () { return [rect] as unknown as DOMRectList; };
    Element.prototype.getBoundingClientRect = function () { return rect as DOMRect; };
    const scrolled = vi.fn();
    window.__dashScrollTo = scrolled;
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // He pressed the in-form bar, which he was reading. Everything it changed is already in front
    // of him, so nothing may move (AI_INSTRUCTIONS → no-op interactions must be invisible).
    document.querySelector<HTMLButtonElement>(`form [role="status"] button`)!.click();
    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('never saved');
    expect(scrolled).not.toHaveBeenCalled();

    delete window.__dashScrollTo;
    delete (Element.prototype as Partial<Element>).getClientRects;
    delete (Element.prototype as Partial<Element>).getBoundingClientRect;
  });

  it('keeps quiet about an offer that is already in front of him', () => {
    leaveDraft();
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    // Give the bar a real box in the middle of a viewport with no pinned chrome: a notice about
    // the thing he is looking at is noise, and a notice that is sometimes noise gets ignored always.
    const rect = { top: 300, bottom: 340, left: 0, right: 100, width: 100, height: 40, x: 0, y: 300 };
    Element.prototype.getClientRects = function () { return [rect] as unknown as DOMRectList; };
    Element.prototype.getBoundingClientRect = function () { return rect as DOMRect; };
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(document.querySelector('form [role="status"]')).not.toBeNull();
    expect(noticeShown()).toBe(false);
    delete (Element.prototype as Partial<Element>).getClientRects;
    delete (Element.prototype as Partial<Element>).getBoundingClientRect;
  });
});
