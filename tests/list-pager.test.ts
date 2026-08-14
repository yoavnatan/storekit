// @vitest-environment jsdom
/**
 * The dashboard's list pager (products / orders / messages).
 *
 * Three complaints produced it (owner, 2026-08-14, about the products tab), and each one is a
 * property something here has to keep:
 *
 *  1. the pager existed only UNDER the list → every tab renders it twice, and one write fills both;
 *  2. only prev/next existed → the numbers are on screen, first and last always among them;
 *  3. the scroll fired before the rows changed → the scroll waits for `apply()` to resolve.
 *
 * (3) is the one worth a test rather than a read: it was invisible in the source (`apply()` was
 * simply not awaited) and it is the kind of thing a later edit re-introduces by accident.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initListPager, markListBusy, pageWindow, renderListPagers, type PagerLabels } from '../src/scripts/dashboard/list-pager.js';
import { LOADING_CUE_DELAY_MS } from '../src/lib/loading-sweep.js';

const LABELS: PagerLabels = {
  prev: 'prev',
  next: 'next',
  pageInfo: 'page {page} of {total}',
  goToPage: 'go to page {page}',
  jump: 'jump to a page',
};
const labels = (): PagerLabels => LABELS;

/** Both navs of one tab, the way dashboard.astro renders them (top and bottom). */
function mountNavs(name: string, page: number, totalPages: number): HTMLElement[] {
  document.body.innerHTML = `
    <nav data-list-pager="${name}" data-page="${page}" data-total-pages="${totalPages}" hidden></nav>
    <div id="the-list"></div>
    <nav data-list-pager="${name}" data-page="${page}" data-total-pages="${totalPages}" hidden></nav>`;
  return [...document.querySelectorAll<HTMLElement>(`[data-list-pager="${name}"]`)];
}

const numbersIn = (nav: HTMLElement): string[] =>
  [...nav.querySelectorAll('[data-page-go], [aria-current="page"]')].map((el) => el.textContent ?? '');

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  // jsdom lays nothing out, so every element measures 0 and the pager would render its narrowest
  // window everywhere. A desktop width is the honest default for these tests; the width→slots
  // rule itself is exercised through pageWindow's explicit `slots` above.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 900 });
});

describe('which pages are offered', () => {
  it('offers every page when they all fit', () => {
    expect(pageWindow(2, 4, 7)).toEqual([1, 2, 3, 4]);
  });

  it('always keeps the first and the last reachable in one click', () => {
    const w = pageWindow(9, 40, 5);
    expect(w[0]).toBe(1);
    expect(w[w.length - 1]).toBe(40);
  });

  it('centres the window on the page you are on', () => {
    expect(pageWindow(9, 40, 5)).toEqual([1, '…', 8, 9, 10, '…', 40]);
  });

  it('runs the window up against the end rather than past it', () => {
    expect(pageWindow(40, 40, 5)).toEqual([1, '…', 37, 38, 39, 40]);
    expect(pageWindow(1, 40, 5)).toEqual([1, 2, 3, 4, '…', 40]);
  });

  it('never renders a gap marker standing in for a single page', () => {
    // "1 … 3 4 5" hides exactly page 2 behind an ellipsis that is the same width as the number
    // it replaces — a strictly worse pager than showing it.
    for (let page = 1; page <= 12; page++) {
      const w = pageWindow(page, 12, 5);
      w.forEach((cell, i) => {
        if (cell !== '…') return;
        const before = w[i - 1] as number;
        const after = w[i + 1] as number;
        expect(after - before).toBeGreaterThan(2);
      });
    }
  });

  it('holds a floor of three numbers, however narrow the strip claims to be', () => {
    expect(pageWindow(5, 12, 1).filter((c) => c !== '…').length).toBeGreaterThanOrEqual(3);
  });
});

describe('one state, both copies', () => {
  it('writes the top nav and the bottom nav identically', () => {
    const [top, bottom] = mountNavs('products', 3, 9);
    renderListPagers('products', 3, 9, LABELS);
    expect(top!.hidden).toBe(false);
    expect(top!.innerHTML).toBe(bottom!.innerHTML);
    expect(numbersIn(top!)).toEqual(numbersIn(bottom!));
  });

  it('marks the current page as text, not a button — pressing it would move nothing', () => {
    const [top] = mountNavs('products', 3, 9);
    renderListPagers('products', 3, 9, LABELS);
    const current = top!.querySelector('[aria-current="page"]')!;
    expect(current.tagName).toBe('SPAN');
    expect(current.textContent).toBe('3');
    expect(top!.querySelector('[data-page-go="3"]')).toBeNull();
  });

  it('hides itself entirely when there is only one page', () => {
    const [top, bottom] = mountNavs('products', 1, 1);
    renderListPagers('products', 1, 1, LABELS);
    expect(top!.hidden).toBe(true);
    expect(bottom!.innerHTML).toBe('');
  });

  it('keeps the live total on the element, so a filter that shrank the list moves "next" with it', () => {
    const [top] = mountNavs('products', 1, 9);
    renderListPagers('products', 1, 2, LABELS);
    expect(top!.dataset.totalPages).toBe('2');
  });

  it('names itself for a screen reader — the numbers alone do not say what they are', () => {
    const [top] = mountNavs('products', 3, 9);
    renderListPagers('products', 3, 9, LABELS);
    expect(top!.getAttribute('aria-label')).toBe('page 3 of 9');
    expect(top!.querySelector('[data-page-go="4"]')?.getAttribute('aria-label')).toBe('go to page 4');
  });
});

describe('pressing a page', () => {
  /** Wires a pager whose apply() resolves only when the returned `resolve` is called. */
  function wire(totalPages = 9) {
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

  it('goes straight to a number that is not adjacent', () => {
    const w = wire();
    document.querySelector<HTMLButtonElement>('[data-page-go="5"]')!.click();
    expect(w.page()).toBe(5);
    expect(w.applied).toEqual([5]);
  });

  it('steps with prev/next', () => {
    const w = wire();
    document.querySelector<HTMLButtonElement>('[data-page-next]')!.click();
    expect(w.page()).toBe(2);
  });

  it('repaints the pressed number BEFORE the fetch answers', () => {
    wire();
    document.querySelector<HTMLButtonElement>('[data-page-go="5"]')!.click();
    // Still awaiting apply() here — and page 5 is already the marked one, which is the only
    // acknowledgement the seller gets while the rows underneath are still the old page's.
    const nav = document.querySelector<HTMLElement>('[data-list-pager="products"]')!;
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('5');
  });

  it('does not scroll until the new rows are actually on screen', async () => {
    const w = wire();
    document.querySelector<HTMLButtonElement>('[data-page-go="5"]')!.click();
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

  it('ignores a press that changes nothing', () => {
    const w = wire();
    const nav = document.querySelector<HTMLElement>('[data-list-pager="products"]')!;
    nav.querySelector<HTMLElement>('[aria-current="page"]')!.click();
    nav.querySelector<HTMLButtonElement>('[data-page-prev]')!.click(); // disabled on page 1
    expect(w.apply).not.toHaveBeenCalled();
  });
});

describe('the gap is the way to a page the window is hiding', () => {
  /** Same harness as above, at a page count big enough to hide pages behind a marker. */
  function wire(totalPages = 40) {
    mountNavs('products', 9, totalPages);
    let page = 9;
    const applied: number[] = [];
    const apply = vi.fn(() => { applied.push(page); return Promise.resolve(); });
    initListPager({
      name: 'products',
      labels,
      getPage: () => page,
      setPage: (p) => { page = p; },
      apply,
      scrollTarget: () => null,
    });
    renderListPagers('products', page, totalPages, LABELS);
    return { applied, page: () => page };
  }
  const gap = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-page-jump]')!;
  const field = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('[data-page-jump-input]');
  const press = (el: Element, key: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); };

  it('says which pages it stands for', () => {
    wire();
    // Page 9 of 40 at 7 slots renders `1 … 7 8 9 10 11 … 40`, so the first marker is pages 2-6.
    expect(gap().dataset.jumpFrom).toBe('2');
    expect(gap().dataset.jumpTo).toBe('6');
    expect(gap().getAttribute('aria-label')).toBe('jump to a page');
  });

  it('opens a field carrying that range, and lands anywhere in one action', () => {
    const w = wire();
    gap().click();
    expect(field()!.placeholder).toBe('2–6');
    field()!.value = '33';
    press(field()!, 'Enter');
    expect(w.page()).toBe(33);
    expect(w.applied).toEqual([33]);
    expect(field()).toBeNull();
  });

  it('clamps a page that does not exist instead of asking for a valid one', () => {
    // A field that rejects rather than corrects makes the seller guess the ceiling.
    const w = wire(40);
    gap().click();
    field()!.value = '999';
    press(field()!, 'Enter');
    expect(w.page()).toBe(40);
  });

  it('does nothing at all on Escape, or on nonsense', () => {
    const w = wire();
    gap().click();
    field()!.value = '12';
    press(field()!, 'Escape');
    expect(field()).toBeNull();
    expect(w.page()).toBe(9);

    gap().click();
    field()!.value = 'abc';
    press(field()!, 'Enter');
    expect(w.page()).toBe(9);
    expect(w.applied).toEqual([]);
  });

  it('is not offered when nothing is hidden', () => {
    mountNavs('products', 2, 4);
    renderListPagers('products', 2, 4, LABELS);
    expect(document.querySelector('[data-page-jump]')).toBeNull();
  });
});

describe('there is one pager, not one per tab', () => {
  // The three tabs each had their own copy, and all three carried all three complaints above —
  // which is the point: a duplicated control accumulates a duplicated bug list. A tree scan, not a
  // file list, so a fourth paged tab is covered the day it exists.
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
        return /data-page-prev\s*[$>"']/.test(src) || /data-page-go=/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it('scanned a set that actually contains the pager tabs', () => {
    // Guards the guard: a renamed directory would otherwise make the scan above vacuously pass.
    expect(files).toContain('src/scripts/dashboard/products.ts');
    expect(files).toContain('src/scripts/dashboard/orders.ts');
    expect(files).toContain('src/scripts/dashboard/messages.ts');
  });
});

describe('the wait is not silent', () => {
  it('says busy immediately and dims only once the wait is worth showing', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    const end = markListBusy(el);
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.className).toBe('');
    // Still nothing at the moment before the site's one threshold — the constant is the source,
    // so this cannot drift into a second answer if the number is ever re-measured.
    vi.advanceTimersByTime(LOADING_CUE_DELAY_MS - 1);
    expect(el.className).toBe('');
    vi.advanceTimersByTime(2);
    expect(el.className).not.toBe('');
    end();
    expect(el.className).toBe('');
    expect(el.hasAttribute('aria-busy')).toBe(false);
  });

  it('never dims for a fetch that answered quickly', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    markListBusy(el)();
    vi.advanceTimersByTime(1000);
    expect(el.className).toBe('');
  });
});
