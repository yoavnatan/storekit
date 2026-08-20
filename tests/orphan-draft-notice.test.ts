// @vitest-environment jsdom
/**
 * A draft whose form is not on the page — the product editor, which is closed by default.
 *
 * Everything else the draft guard does assumes the form is here to be offered into: the settings
 * form sits in its panel, the add-product box sits in its. A PRODUCT edit row does not. It is one
 * row of a table, built only when the seller opens it, so a reload left his typing in localStorage
 * with nothing on the page to hand it back — and he met it again only if he happened to reopen that
 * exact product (owner, 2026-08-20: *"אי אפשר לדעת בעצם אחרי ריענון מה היה פתוח קודם"*).
 *
 * **The cost was the reason it had not been done, and it is what these tests pin.** The obvious
 * implementation — open every product's editor to see whether one has a draft — is fifty forms
 * built to ask fifty questions (his own worry, the same day). Nothing is opened: the draft carries
 * the product's name in its own `base`, so the scan is one pass over localStorage and no DOM, and a
 * single row is built when he presses the name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve(process.cwd(), 'src/components/dashboard/FormFallbackGuard.astro');
const FOUND = 'draft found';
const NOTICE = 'unsaved work in {section}';
const NOT_ON_PAGE = 'not on this page';
const MORE_ONE = ' and one more';
const MORE_N = ' and {count} more';

function installGuard(): void {
  const file = readFileSync(SOURCE, 'utf8');
  const body = file.match(/<script is:inline define:vars=\{\{[^}]*\}\}>([\s\S]*?)<\/script>/)?.[1];
  if (!body) throw new Error('guard script not found — did the <script is:inline> tag change?');
  new Function('msg', 'draftFound', 'draftRestore', 'draftDiscard', 'draftNotice', 'draftOpenFailed', 'draftNoticeMoreOne', 'draftNoticeMore', body)(
    'blocked', FOUND, 'restore', 'discard', NOTICE, NOT_ON_PAGE, MORE_ONE, MORE_N,
  );
}
Element.prototype.scrollIntoView = vi.fn();
installGuard();

const key = (id: string): string => `dz-draft:s1:/api/product:${id}`;
const noticeShown = (): boolean => !document.getElementById('dash-draft-bar')!.classList.contains('!hidden');
const noticeText = (): string =>
  (document.getElementById('dash-draft-msg')!.textContent ?? '').replace(/\s+/g, ' ').trim();
const link = (): HTMLElement => document.getElementById('dash-draft-go')!;

/** A dashboard sitting on some other tab: the Products panel exists but has never been filled. */
function render(): void {
  document.body.innerHTML =
    `<div id="toast-container"></div><div id="upload-config" data-store-id="s1"></div>` +
    `<div id="dash-draft-bar" class="!hidden"><span id="dash-draft-msg"><span data-notice-pre></span>` +
    `<button id="dash-draft-go" class="!hidden"></button><span data-notice-post></span></span>` +
    `<button id="dash-draft-restore" class="!hidden">restore</button>` +
    `<button id="dash-draft-discard" class="!hidden">discard</button></div>` +
    `<div id="dash-unsaved-bar" class="!hidden"></div><div id="dash-stale-bar" class="!hidden"></div>` +
    `<div class="dash-tabs"><button role="tab" data-panel="overview" aria-selected="true">Overview</button>` +
    `<button role="tab" id="tab-products" data-panel="products" aria-selected="false">Products</button></div>` +
    `<div id="dash-panel-products" class="dash-panel" aria-labelledby="tab-products" data-lazy hidden></div>`;
}

/** What a page life leaves behind when the seller edited a product and never saved. */
function leaveProductDraft(id: string, name: string, typed: string): void {
  localStorage.setItem(key(id), JSON.stringify({
    at: Date.now(),
    values: { 'name#0': { v: typed } },
    base: { 'name#0': { v: name } },
  }));
}

const load = (): void => { document.dispatchEvent(new Event('DOMContentLoaded')); };

describe('a draft with no form on the page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    render();
    delete (window as unknown as { __dashOpenProductEdit?: unknown }).__dashOpenProductEdit;
  });

  it('says so at load, naming the product — without opening a single editor', () => {
    leaveProductDraft('p1', 'כיסא עץ', 'כיסא עץ מלא');
    const built = vi.fn();
    document.addEventListener('click', built);
    load();

    expect(noticeShown()).toBe(true);
    // The name is what the SERVER had, not what the half-finished edit renamed it to: the sentence
    // says where the work belongs, and the seller recognises the product by the name he knows.
    expect(noticeText()).toBe('unsaved work in כיסא עץ');
    expect(link().textContent).toBe('כיסא עץ');
    expect(built).not.toHaveBeenCalled();
    document.removeEventListener('click', built);
  });

  it('reads localStorage once and touches no DOM per draft — fifty drafts, no fifty forms', () => {
    for (let i = 0; i < 50; i++) leaveProductDraft(`p${i}`, `product ${i}`, `edited ${i}`);
    load();
    // One sentence, one product. The rest are still there and take their turn as each is answered.
    expect(noticeShown()).toBe(true);
    expect(document.querySelectorAll('form').length).toBe(0);
    expect(document.querySelectorAll('#dash-panel-products *').length).toBe(0);
  });

  it('stays quiet about a draft that changed nothing', () => {
    // A draft is a photograph of the WHOLE form, so most of what is stored is what the page already
    // had. Measured against its own `base`, this one holds no edit at all.
    leaveProductDraft('p1', 'כיסא עץ', 'כיסא עץ');
    load();
    expect(noticeShown()).toBe(false);
  });

  it('stays quiet about a draft too old to be worth offering', () => {
    localStorage.setItem(key('p1'), JSON.stringify({
      at: Date.now() - 8 * 24 * 60 * 60 * 1000,
      values: { 'name#0': { v: 'edited' } },
      base: { 'name#0': { v: 'original' } },
    }));
    load();
    expect(noticeShown()).toBe(false);
    // And it is cleared out rather than left to be re-read on every load for ever.
    expect(localStorage.getItem(key('p1'))).toBe(null);
  });

  it('opens the products tab and that one row when the name is pressed', () => {
    leaveProductDraft('p1', 'כיסא עץ', 'כיסא עץ מלא');
    load();

    let openedTab = false;
    document.querySelector('[role="tab"][data-panel="products"]')!
      .addEventListener('click', () => { openedTab = true; });
    const open = vi.fn(() => true);
    (window as unknown as { __dashOpenProductEdit: unknown }).__dashOpenProductEdit = open;

    link().click();
    expect(openedTab).toBe(true);
    expect(open).toHaveBeenCalledWith('p1');
    // It opens the row and stops. The bar inside that form is what asks — the same rule as an offer
    // sitting in another tab, and for the same reason.
    expect(document.getElementById('dash-draft-restore')!.classList.contains('!hidden')).toBe(true);
  });

  it('waits for a panel that is still being fetched before giving up on the row', () => {
    leaveProductDraft('p1', 'כיסא עץ', 'כיסא עץ מלא');
    load();
    // The Products panel has never been filled, so neither the row nor the opener exists yet.
    link().click();
    vi.advanceTimersByTime(300);

    const open = vi.fn(() => true);
    (window as unknown as { __dashOpenProductEdit: unknown }).__dashOpenProductEdit = open;
    vi.advanceTimersByTime(200);
    expect(open).toHaveBeenCalledWith('p1');
  });

  it('says the product is not on this page rather than failing silently', () => {
    leaveProductDraft('p1', 'כיסא עץ', 'כיסא עץ מלא');
    load();
    // The panel is here, the product is three pages away: the opener answers false, for ever.
    (window as unknown as { __dashOpenProductEdit: unknown }).__dashOpenProductEdit = (): boolean => false;
    const toasts: string[] = [];
    window.addEventListener('toast:show', (e) => toasts.push((e as CustomEvent).detail.title));

    link().click();
    vi.advanceTimersByTime(6000);
    expect(toasts).toEqual([NOT_ON_PAGE]);
    // Nothing was thrown away — the draft is still there for the load that does show that row.
    expect(localStorage.getItem(key('p1'))).not.toBe(null);
  });

  it('says how many others are waiting, so the count is not something he has to count', () => {
    leaveProductDraft('p1', '\u05db\u05d9\u05e1\u05d0 \u05e2\u05e5', 'edited');
    leaveProductDraft('p2', 'shirt', 'edited');
    leaveProductDraft('p3', 'hat', 'edited');
    load();
    // One is named — that is the one the press opens — and the rest are a number, because the marks
    // that show WHICH ones live in the products table and he may be reading this from any tab.
    expect(noticeText().endsWith(MORE_N.replace('{count}', '2').trim())).toBe(true);
  });

  it('says "one more" rather than "1 more" — a count of one is not a plural', () => {
    leaveProductDraft('p1', '\u05db\u05d9\u05e1\u05d0 \u05e2\u05e5', 'edited');
    leaveProductDraft('p2', 'shirt', 'edited');
    load();
    expect(noticeText().endsWith(MORE_ONE.trim())).toBe(true);
  });

  it('adds nothing when only one product is waiting', () => {
    leaveProductDraft('p1', '\u05db\u05d9\u05e1\u05d0 \u05e2\u05e5', 'edited');
    load();
    expect(noticeText()).toBe('unsaved work in \u05db\u05d9\u05e1\u05d0 \u05e2\u05e5');
  });

  it('hands the ids to the products table so it can mark the rows', () => {
    leaveProductDraft('p1', 'a', 'edited');
    leaveProductDraft('p2', 'b', 'edited');
    load();
    const w = window as unknown as { __dashDraftProducts?: () => string[] };
    expect((w.__dashDraftProducts?.() ?? []).sort()).toEqual(['p1', 'p2']);
  });

  it('reads localStorage ONCE per load, not once per row the seller opens', () => {
    // The cost he was right to be afraid of. Opening rows is what a seller does all afternoon, and
    // re-parsing every stored draft on each of them is the shape that turns a feature into a
    // stutter — so the arrival path only forgets what is now claimed, it does not re-read.
    for (let i = 0; i < 20; i++) leaveProductDraft(`p${i}`, `product ${i}`, `edited ${i}`);
    load();
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    const row = document.createElement('div');
    row.innerHTML =
      '<form data-unsaved-guard method="POST" action="/api/product">' +
      '<input type="hidden" name="productId" value="p1"><input name="name" value="product 1"></form>';
    document.getElementById('dash-panel-products')!.append(row);
    (window as unknown as { __dashScanDrafts: (r: ParentNode) => void }).__dashScanDrafts(row);
    // One read: the draft belonging to the form that just arrived. Not twenty.
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });

  it('hands over to the form the moment that form arrives', () => {
    leaveProductDraft('p1', 'כיסא עץ', 'כיסא עץ מלא');
    load();
    expect(link().textContent).toBe('כיסא עץ');

    // products.ts builds the row and hands it over — the ordinary path takes the draft from here.
    const row = document.createElement('div');
    row.innerHTML =
      '<form data-unsaved-guard method="POST" action="/api/product">' +
      '<input type="hidden" name="productId" value="p1"><input name="name" value="כיסא עץ"></form>';
    document.getElementById('dash-panel-products')!.append(row);
    (window as unknown as { __dashScanDrafts: (r: ParentNode) => void }).__dashScanDrafts(row);

    // One subject, never two: the bar in the form now owns the offer, so the notice stops naming it
    // from the outside and asks instead.
    expect(row.textContent).toContain(FOUND);
    // The Products panel is still closed, so the notice does what it does for any offer in another
    // tab: it names the SECTION and leads him there, and the bar in the form does the asking.
    expect(noticeText()).toBe('unsaved work in Products');
    expect(link().textContent).toBe('Products');
    expect(document.getElementById('dash-draft-restore')!.classList.contains('!hidden')).toBe(true);
  });
});
