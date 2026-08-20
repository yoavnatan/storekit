// @vitest-environment jsdom
/**
 * Restoring a draft puts unsaved work into a form — and the dashboard has to KNOW that.
 *
 * Reported by the owner (סשן א׳ §1): edit a product, reload without saving, reopen the row, accept
 * the offer — "and then it does not tell me there are unsaved changes in that tab".
 *
 * The two halves are owned by two files that cannot import each other, which is why this test exists
 * as a pair rather than inside either one's own suite:
 *  - `components/dashboard/FormFallbackGuard.astro` is INLINE (it has to survive the module graph
 *    dying) and it is what writes the recovered values into the fields;
 *  - `scripts/dashboard/unsaved-guard.ts` is what answers "is anything unsaved", and it takes a
 *    form's baseline lazily, on the first focus or pointer press INSIDE that form.
 *
 * A restore pressed on the floating notice is neither: the press lands on an element outside the
 * form, so no baseline was ever taken, so `isDirty` answered false about a form that had just been
 * filled with a previous session's typing. The seller then walked to another tab in silence — the
 * one case the whole notice exists for. `dash:willrewritefields` is the seam: fired before the
 * write, so the baseline captured is still what the server rendered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasUnsavedChanges, initUnsavedGuard } from '../src/scripts/dashboard/unsaved-guard.js';

const SOURCE = resolve(process.cwd(), 'src/components/dashboard/FormFallbackGuard.astro');
const FOUND = 'draft found';
const RESTORE = 'restore';
const DISCARD = 'discard';
const NOTICE = 'unsaved work in {section}';
const NOT_ON_PAGE = 'not on this page';

/** The shipped inline script, with its vars bound the way Astro binds them — never a copy. */
function installGuard(): void {
  const file = readFileSync(SOURCE, 'utf8');
  const body = file.match(/<script is:inline define:vars=\{\{[^}]*\}\}>([\s\S]*?)<\/script>/)?.[1];
  if (!body) throw new Error('guard script not found — did the <script is:inline> tag change?');
  new Function('msg', 'draftFound', 'draftRestore', 'draftDiscard', 'draftNotice', 'draftOpenFailed', body)(
    'blocked', FOUND, RESTORE, DISCARD, NOTICE, NOT_ON_PAGE,
  );
}
Element.prototype.scrollIntoView = vi.fn();
installGuard();
initUnsavedGuard();

const KEY = 'dz-draft:s1:/api/product:p1';
const shown = (): boolean => !document.getElementById('dash-unsaved-bar')!.classList.contains('!hidden');
const noticeText = (): string =>
  (document.getElementById('dash-unsaved-msg')!.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The products tab with one open inline edit row, plus the tab the seller walks off to. */
function render(): void {
  document.body.innerHTML = `
    <script type="application/json" id="i18n-data">${JSON.stringify({
    dashboard: { unsavedNotice: 'unsaved in {section}' },
  })}</script>
    <div id="upload-config" data-store-id="s1"></div>
    <div class="dash-tabs">
      <button class="dash-tab" role="tab" id="tab-products">Products</button>
      <button class="dash-tab" role="tab" id="tab-settings">Settings</button>
    </div>
    <div id="dash-panel-products" class="dash-panel" aria-labelledby="tab-products"></div>
    <div id="dash-panel-settings" class="dash-panel" aria-labelledby="tab-settings" hidden></div>
    <div id="dash-draft-bar" class="!hidden"><span id="dash-draft-msg"><span data-notice-pre></span><button id="dash-draft-go" class="!hidden"></button><span data-notice-post></span></span>
      <button id="dash-draft-restore" class="!hidden">${RESTORE}</button>
      <button id="dash-draft-discard" class="!hidden">${DISCARD}</button></div>
    <div id="dash-unsaved-bar" class="!hidden"><span id="dash-unsaved-msg"><span data-notice-pre></span><button id="dash-unsaved-go"></button><span data-notice-post></span></span></div>
    <div id="dash-stale-bar" class="!hidden"></div>`;
}

/**
 * The row the seller reopens after the reload. It is built on demand (products.ts) and handed to
 * the inline guard through `__dashScanDrafts` — which is why the form is absent from `render`:
 * at load there is nothing here for a draft to be offered into, and that is the real sequence.
 */
function openEditRowWithDraft(typed = 'what he typed'): HTMLFormElement {
  localStorage.setItem(KEY, JSON.stringify({
    at: Date.now(),
    values: { 'name#0': { v: typed } },
    base: { 'name#0': { v: 'server name' } },
  }));
  const row = document.createElement('div');
  row.innerHTML =
    '<form data-unsaved-guard method="POST" action="/api/product">' +
    '<input type="hidden" name="productId" value="p1">' +
    '<input name="name" value="server name">' +
    '<button type="submit">save</button></form>';
  document.getElementById('dash-panel-products')!.append(row);
  (window as unknown as { __dashScanDrafts: (r: ParentNode) => void }).__dashScanDrafts(row);
  return row.querySelector('form')!;
}

/** He leaves the Products tab. A tab switch fires no input event — `dashtab:show` is the trigger. */
function walkAway(): void {
  document.getElementById('dash-panel-products')!.hidden = true;
  const settings = document.getElementById('dash-panel-settings')!;
  settings.hidden = false;
  settings.dispatchEvent(new CustomEvent('dashtab:show', { bubbles: true }));
}

describe('a restored draft is unsaved work, and the notice has to know it', () => {
  beforeEach(() => {
    localStorage.clear();
    render();
    // The load itself: it wires the floating notice's buttons and takes the baseline of everything
    // already on the page. The edit row is not on the page yet — that is the point.
    document.dispatchEvent(new Event('DOMContentLoaded'));
  });

  it('announces it after a restore pressed on the FLOATING notice — no press ever touched the form', () => {
    const form = openEditRowWithDraft();
    expect(form.textContent).toContain(FOUND);
    // The bar inside the form is off screen (jsdom lays nothing out, which reads as exactly that),
    // so the floating notice carries the offer — and pressing it is a press on `document.body`.
    document.getElementById('dash-draft-restore')!.click();

    expect(form.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('what he typed');
    expect(hasUnsavedChanges()).toBe(true);
    walkAway();
    expect(shown()).toBe(true);
    expect(noticeText()).toBe('unsaved in Products');
  });

  it('still announces it after a further edit on top of the restore', () => {
    const form = openEditRowWithDraft();
    document.getElementById('dash-draft-restore')!.click();
    const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
    name.dispatchEvent(new Event('focusin', { bubbles: true }));
    name.value = 'what he typed, then more';
    name.dispatchEvent(new Event('input', { bubbles: true }));

    walkAway();
    expect(shown()).toBe(true);
  });

  it('takes the baseline from BEFORE the restore, so the way back is the last SAVE', () => {
    // The order is the whole point: capture after the write and the recovered values would look
    // like the saved ones, which is silence again — this time permanent.
    const form = openEditRowWithDraft();
    document.getElementById('dash-draft-restore')!.click();
    const discard = document.createElement('button');
    discard.setAttribute('data-discard', '');
    discard.setAttribute('form', 'x');
    form.id = 'x';
    document.body.append(discard);
    form.dispatchEvent(new Event('input', { bubbles: true }));   // refreshes the discard button
    expect(discard.disabled).toBe(false);
  });

  it('says nothing when the offer had nothing left to put back', () => {
    // Same values as the server rendered: the offer is dropped unasked, and no baseline is taken
    // for a form nobody has touched — a notice here would be about work that does not exist.
    openEditRowWithDraft('server name');
    walkAway();
    expect(shown()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });
});
