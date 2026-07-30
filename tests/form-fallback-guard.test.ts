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
  new Function('msg', 'draftFound', 'draftRestore', 'draftDiscard', body)(MSG, FOUND, RESTORE, DISCARD);
}
installGuard();

function render(inner: string, attrs = 'id="settings-form" method="POST" action="/api/store"'): HTMLFormElement {
  document.body.innerHTML =
    `<div id="toast-container"></div><div id="upload-config" data-store-id="s1"></div>` +
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
