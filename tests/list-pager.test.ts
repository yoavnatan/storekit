// @vitest-environment jsdom
/**
 * The dashboard's list pager (products / orders / messages / the buyer's orders).
 *
 * Four complaints from the owner produced what it is, and each one is a property something here
 * has to keep:
 *
 *  1. the pager existed only UNDER the list → every tab renders it twice, and one write fills both;
 *  2. only prev/next existed → there is a page selector, and every page is one action away;
 *  3. the scroll fired before the rows changed → the scroll waits for `apply()` to resolve;
 *  4. paging fast rewound the list → only the newest request may write (`createFetchGate`).
 *
 * (3) and (4) are the two worth testing rather than reading: both were invisible in the source —
 * an `apply()` that was simply not awaited, and an answer allowed to land out of order — and both
 * are the kind of thing a later edit re-introduces by accident.
 *
 * What is NOT here any more, deliberately: the windowed strip of page numbers with `…` markers,
 * thrown out on 2026-08-15 ("זה מסובך מדי למשתמש"). Its window algorithm, per-width slot count and
 * jump field went with it, and so did their tests — a test for a mechanism nobody ships is a
 * mechanism nobody deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFetchGate, initListPager, markListBusy, renderListPagers, type PagerLabels } from '../src/scripts/dashboard/list-pager.js';

const LABELS: PagerLabels = { prev: 'prev', next: 'next', pageInfo: 'page {page} of {total}' };
const labels = (): PagerLabels => LABELS;

/** Both navs of one tab, the way dashboard.astro renders them (top and bottom). */
function mountNavs(name: string, page: number, totalPages: number): HTMLElement[] {
  document.body.innerHTML = `
    <nav data-list-pager="${name}" data-page="${page}" data-total-pages="${totalPages}" hidden></nav>
    <div id="the-list"></div>
    <nav data-list-pager="${name}" data-page="${page}" data-total-pages="${totalPages}" hidden></nav>`;
  return [...document.querySelectorAll<HTMLElement>(`[data-list-pager="${name}"]`)];
}

const pageSelect = (root: ParentNode = document): HTMLSelectElement =>
  root.querySelector<HTMLSelectElement>('[data-page-select]')!;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('one control, every page', () => {
  it('offers every page, not a window over them', () => {
    mountNavs('products', 3, 12);
    renderListPagers('products', 3, 12, LABELS);
    const options = [...pageSelect().options].map((o) => o.value);
    expect(options).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(pageSelect().value).toBe('3');
  });

  it('looks the same at 3 pages and at 40 — nothing about the shape depends on the count', () => {
    mountNavs('products', 1, 3);
    renderListPagers('products', 1, 3, LABELS);
    const small = document.querySelector('[data-list-pager]')!.children.length;
    renderListPagers('products', 20, 40, LABELS);
    expect(document.querySelector('[data-list-pager]')!.children.length).toBe(small);
    expect(pageSelect().options.length).toBe(40);
  });

  it('puts the dropdown INSIDE the translated sentence rather than beside it', () => {
    // The label is a template: the words either side of the control are the translation's own, so
    // a language that words it differently is not left with an English-shaped row.
    const [top] = mountNavs('products', 3, 12);
    renderListPagers('products', 3, 12, LABELS);
    expect(top!.textContent).toContain('page');
    expect(top!.querySelector('[data-pager-after]')!.textContent).toBe('of 12');
  });

  it('names the whole thing for a screen reader — a bare number says nothing', () => {
    const [top] = mountNavs('products', 3, 12);
    renderListPagers('products', 3, 12, LABELS);
    expect(pageSelect().getAttribute('aria-label')).toBe('page 3 of 12');
    expect(top!.getAttribute('aria-label')).toBe('page 3 of 12');
  });

  it('stops "previous" at the first page and "next" at the last', () => {
    mountNavs('products', 1, 12);
    renderListPagers('products', 1, 12, LABELS);
    expect(document.querySelector<HTMLButtonElement>('[data-page-prev]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-page-next]')!.disabled).toBe(false);
    renderListPagers('products', 12, 12, LABELS);
    expect(document.querySelector<HTMLButtonElement>('[data-page-prev]')!.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-page-next]')!.disabled).toBe(true);
  });
});

describe('one state, both copies', () => {
  it('writes the top nav and the bottom nav identically', () => {
    const [top, bottom] = mountNavs('products', 3, 9);
    renderListPagers('products', 3, 9, LABELS);
    expect(top!.hidden).toBe(false);
    expect(pageSelect(top!).value).toBe(pageSelect(bottom!).value);
    expect(top!.getAttribute('aria-label')).toBe(bottom!.getAttribute('aria-label'));
  });

  it('empties itself when there is only one page', () => {
    // Emptied, not merely `hidden`: the `hidden` attribute loses to the `flex` class on these navs,
    // so a `:empty` rule is what actually hides them.
    const [top, bottom] = mountNavs('products', 1, 1);
    renderListPagers('products', 1, 1, LABELS);
    expect(top!.children.length).toBe(0);
    expect(bottom!.children.length).toBe(0);
  });

  it('comes back when a list grows past one page again', () => {
    mountNavs('products', 1, 1);
    renderListPagers('products', 1, 1, LABELS);
    renderListPagers('products', 1, 4, LABELS);
    expect(pageSelect().options.length).toBe(4);
  });

  it('keeps the live total on the element, so a filter that shrank the list moves "next" with it', () => {
    const [top] = mountNavs('products', 1, 9);
    renderListPagers('products', 1, 2, LABELS);
    expect(top!.dataset.totalPages).toBe('2');
    expect(pageSelect(top!).options.length).toBe(2);
  });
});

describe('choosing a page', () => {
  /** Wires a pager whose apply() resolves only when the returned `release` is called. */
  function wire(totalPages = 12) {
    mountNavs('products', 1, totalPages);
    let page = 1;
    let release: () => void = () => {};
    const applied: number[] = [];
    const apply = vi.fn(() => new Promise<void>((resolve) => {
      applied.push(page);
      release = resolve;
    }));
    const scrolled: string[] = [];
    initListPager({
      name: 'products',
      labels,
      getPage: () => page,
      setPage: (p) => { page = p; },
      apply,
      scrollTarget: () => { scrolled.push('asked'); return null; },
    });
    renderListPagers('products', page, totalPages, LABELS);
    return { applied, scrolled, apply, release: () => release(), page: () => page };
  }

  const choose = (value: string): void => {
    const select = pageSelect();
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('goes straight to any page in one action', () => {
    const w = wire();
    choose('9');
    expect(w.page()).toBe(9);
    expect(w.applied).toEqual([9]);
  });

  it('steps with prev/next', () => {
    const w = wire();
    document.querySelector<HTMLButtonElement>('[data-page-next]')!.click();
    expect(w.page()).toBe(2);
  });

  it('cannot be asked for a page that does not exist', () => {
    // Worth stating because it is what the numbers strip could NOT promise: it had a free-text jump
    // field, so it needed a clamp and a rule about what to do with nonsense. A select only ever
    // offers real pages, and that whole branch stopped existing.
    const w = wire(12);
    expect([...pageSelect().options].map((o) => Number(o.value))).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    choose('999'); // a select refuses a value it has no option for
    expect(w.page()).toBe(1);
  });

  it('shows the chosen page BEFORE the fetch answers', () => {
    wire();
    choose('9');
    // Still awaiting apply() here — and the control already reads 9, which is the only
    // acknowledgement the seller gets while the rows underneath are still the old page's.
    expect(pageSelect().value).toBe('9');
  });

  it('does not scroll until the new rows are actually on screen', async () => {
    const w = wire();
    choose('9');
    await Promise.resolve();
    // The bug this replaces: the old handler called apply() without awaiting it and scrolled on
    // the very next line, so the page jumped to the top of a list still showing the page the
    // seller had just left.
    expect(w.scrolled).toEqual([]);
    w.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(w.scrolled).toEqual(['asked']);
  });

  it('ignores a choice that changes nothing', () => {
    const w = wire();
    choose('1');
    document.querySelector<HTMLButtonElement>('[data-page-prev]')!.click(); // disabled on page 1
    expect(w.apply).not.toHaveBeenCalled();
  });
});

describe('paging fast cannot rewind the list', () => {
  /**
   * The reported bug (owner, 2026-08-15): pressing next quickly went 2 → 3 → back to 2. Every
   * press fires its own request, each answer wrote `currentPage = data.page` and repainted the
   * control, so the LAST answer to arrive won — and a slow page 2 landing after a fast page 3
   * rewound both the number and the rows. The clicks were never the problem; the network was being
   * allowed to decide the order.
   */
  it('lets only the newest request write, whatever order the answers arrive in', () => {
    const gate = createFetchGate();
    const first = gate.begin();   // "next" → page 2
    const second = gate.begin();  // "next" again, before page 2 answered → page 3
    // Page 2 answers LAST. It must not be allowed to touch anything.
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('aborts the request it supersedes rather than leaving it to finish', () => {
    // A browser caps parallel connections to one origin, so an answer nobody will read is not
    // free — it is holding a slot the press the seller is waiting on could be using.
    const gate = createFetchGate();
    const first = gate.begin();
    expect(first.signal.aborted).toBe(false);
    const second = gate.begin();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('does not slow a press down — each one claims the list immediately', () => {
    // Guards against "fixing" this with a debounce, which is the one thing that was ruled out:
    // a seller sometimes wants to page quickly, and a delay is exactly what that would cost.
    const gate = createFetchGate();
    const presses = Array.from({ length: 5 }, () => gate.begin());
    expect(presses.map((p) => p.isCurrent())).toEqual([false, false, false, false, true]);
  });

  it('leaves the dim to whichever request is still running', () => {
    const el = document.createElement('div');
    const endFirst = markListBusy(el);
    const endSecond = markListBusy(el);
    // The superseded caller's cleanup must not lift the dim of the one that replaced it — that is
    // a list that looks settled while it is still loading...
    endFirst();
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.className).not.toBe('');
    // ...and the newest one still ends it cleanly.
    endSecond();
    expect(el.className).toBe('');
    expect(el.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('the wait is not silent', () => {
  it('dims the outgoing rows immediately, not after a threshold', () => {
    // Owner, 2026-08-15: with the dim behind the site's 450ms cue threshold it never appeared at
    // all, because these fetches answer inside it — "עכשיו סתם מחכים". A dim is not a skeleton:
    // nothing appears and nothing is displaced, so a short one costs a fade rather than a flicker.
    const el = document.createElement('div');
    const end = markListBusy(el);
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.className).not.toBe('');
    end();
    expect(el.className).toBe('');
    expect(el.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('there is one pager, not one per tab', () => {
  // The three tabs each had their own copy, and all three carried the same complaints — which is
  // the point: a duplicated control accumulates a duplicated bug list. A tree scan, not a file
  // list, so a fourth paged tab is covered the day it exists.
  const ROOTS = ['src/scripts/dashboard', 'src/scripts', 'src/pages/seller', 'src/pages/buyer', 'src/components/dashboard'];
  const files: string[] = [];
  for (const root of ROOTS) {
    for (const name of readdirSync(join(process.cwd(), root), { withFileTypes: true })) {
      if (name.isFile() && /\.(ts|astro)$/.test(name.name)) files.push(join(root, name.name));
    }
  }

  it('leaves the pager markup to list-pager.ts alone', () => {
    const offenders = files
      .filter((f) => !f.endsWith('list-pager.ts'))
      .filter((f) => {
        const src = readFileSync(join(process.cwd(), f), 'utf8');
        // The BUTTONS, not the container: dashboard.astro legitimately renders the empty <nav>s.
        return /data-page-prev\s*[$>"']/.test(src) || /data-page-select/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it('scanned a set that actually contains the pager tabs', () => {
    // Guards the guard: a renamed directory would otherwise make the scan above vacuously pass.
    expect(files).toContain('src/scripts/dashboard/products.ts');
    expect(files).toContain('src/scripts/dashboard/orders.ts');
    expect(files).toContain('src/scripts/dashboard/messages.ts');
  });

  /**
   * A tab's fetch gate must exist before the tab can be asked to apply an intent.
   *
   * `onPanelIntent(panel, apply)` DRAINS a waiting intent synchronously (`panel-intent.ts`), so the
   * applier can run on the very line that registers it — while the rest of the init function is
   * still executing. The orders tab declared `const ordersFetchGate = createFetchGate()` twenty-odd
   * lines BELOW that registration, and the applier re-fetches the list, so following a return chip
   * into an orders panel that had not been opened yet threw
   * `Cannot access 'ordersFetchGate' before initialization` **inside the applier**: the search box
   * was filled in, the list was never re-fetched, and the seller read a query over the wrong rows
   * with nothing on screen saying so. It only ever happened on the FIRST visit to the tab, which is
   * why it lived through every later press working perfectly.
   *
   * Position in the file is the whole rule, so position is what this checks.
   */
  it('declares every fetch gate before the intent that can use it', () => {
    const offenders: string[] = [];
    let examined = 0;
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      // Anchored to the start of a line, so the prose above each of these — which names both — is
      // not mistaken for a call. Comments explaining a rule must not be able to break it.
      const intent = /^\s*onPanelIntent\(/m.exec(src)?.index;
      if (intent === undefined) continue;
      examined++;
      for (const m of src.matchAll(/^\s*(?:const|let)\s+\w+\s*=\s*createFetchGate\(\)/gm)) {
        if (m.index! > intent) offenders.push(`${f}: a fetch gate is declared after onPanelIntent()`);
      }
    }
    // Guards the guard: if the call ever stops matching, the loop above skips every file and this
    // passes while checking nothing — the same way the bug survived every later press working.
    expect(examined, 'no file matched onPanelIntent() — the scan checked nothing').toBeGreaterThan(2);
    expect(
      offenders,
      'onPanelIntent drains a waiting intent synchronously, so anything the applier touches must\n'
      + 'already be initialised. Move the gate to module scope, as products.ts and orders.ts do.',
    ).toEqual([]);
  });
});
