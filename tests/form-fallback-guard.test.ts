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
const NOTICE_MANY = 'unsaved work in several places';

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
  new Function('msg', 'draftFound', 'draftRestore', 'draftDiscard', 'draftNotice', 'draftNoticeMany', body)(
    MSG, FOUND, RESTORE, DISCARD, NOTICE, NOTICE_MANY,
  );
}
installGuard();

/** The floating notice, as the component server-renders it — the script only ever fills it in. */
const NOTICE_BAR =
  `<div id="dash-draft-bar" class="!hidden"><span id="dash-draft-msg"></span>` +
  `<button type="button" id="dash-draft-go"></button></div>`;

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
    Element.prototype.scrollIntoView = vi.fn();
  });

  /** Leave a draft behind for the settings form, the way a crash would. */
  function leaveDraft(): void {
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'never saved');
    vi.advanceTimersByTime(1000);
  }

  it('names the section holding the work, using the tab’s own label', () => {
    leaveDraft();
    renderPanels([
      { tab: 'tab-products', label: 'Products', open: true, form: '' },
      { tab: 'tab-settings', label: 'Store settings', open: false,
        form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` },
    ]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(noticeShown()).toBe(true);
    expect(noticeText()).toBe('unsaved work in Store settings');
  });

  it('says nothing at all on the ordinary load, where there is no draft', () => {
    renderPanels([{ tab: 'tab-settings', label: 'Store settings', open: true,
      form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(noticeShown()).toBe(false);
  });

  it('stops naming one section once a second one is holding work too', () => {
    leaveDraft();
    // A second draft, for a product editor — a different form, a different key.
    renderPanels([{ tab: 'tab-products', label: 'Products', open: true,
      form: `<form method="POST" action="/api/product" data-unsaved-guard>` +
            `<input type="hidden" name="productId" value="p1" />${FIELDS}</form>` }]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    type('name', 'also never saved');
    vi.advanceTimersByTime(1000);

    renderPanels([
      { tab: 'tab-products', label: 'Products', open: false,
        form: `<form method="POST" action="/api/product" data-unsaved-guard>` +
              `<input type="hidden" name="productId" value="p1" />${FIELDS}</form>` },
      { tab: 'tab-settings', label: 'Store settings', open: false,
        form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` },
    ]);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(noticeText()).toBe(NOTICE_MANY);
  });

  it('opens the tab and lands the keyboard on the decision — but never makes it', () => {
    leaveDraft();
    renderPanels([
      { tab: 'tab-products', label: 'Products', open: true, form: '' },
      { tab: 'tab-settings', label: 'Store settings', open: false,
        form: `<form id="settings-form" method="POST" action="/api/store" data-unsaved-guard>${FIELDS}</form>` },
    ]);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    let opened = '';
    document.getElementById('tab-settings')!.addEventListener('click', () => { opened = 'tab-settings'; });
    document.getElementById('dash-draft-go')!.click();

    expect(opened).toBe('tab-settings');
    // The button carries him to the offer; the value is still the server's until HE restores it.
    expect(document.activeElement?.textContent).toBe(RESTORE);
    expect(document.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('server');
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
