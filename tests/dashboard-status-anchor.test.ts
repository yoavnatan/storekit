// @vitest-environment jsdom
/**
 * The dashboard's notice must reach the seller WITHOUT moving the page.
 *
 * Both halves of that sentence are scar tissue. The notice used to be a coloured strip inserted
 * into the panel's flow, anchored to `.products-header` — a class nothing renders any more. `?.`
 * swallowed the miss, so the strip was built, never inserted, and then scrolled to: the page
 * twitched toward a node with no parent and 56 call sites across five modules said nothing at all
 * while every operation behind them succeeded. Fixed by anchoring it properly, it was worse — a
 * strip above a campaign card pushed every card below it down for three seconds. The owner's
 * verdict (2026-08-17) is the contract this file now pins: a notice that reflows the page is the
 * wrong shape wherever it is put, so it is a toast, which floats.
 *
 * The second describe is the half that rots without any test failing: a script anchoring to a
 * class the markup stopped rendering. `.products-header` still exists in `dashboard.css`, so
 * reading the stylesheet would not have revealed the original bug either — only the MARKUP counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const toasts = vi.hoisted(() => ({ ok: [] as string[], errors: [] as string[] }));
vi.mock('../src/lib/toast.js', () => ({
  showToast: (title: string) => { toasts.ok.push(title); },
  showErrorToast: (title: string) => { toasts.errors.push(title); },
  showActionFailedToast: () => { toasts.errors.push('action-failed'); },
}));

const { showStatus } = await import('../src/scripts/dashboard/status.js');

beforeEach(() => { document.body.innerHTML = ''; toasts.ok = []; toasts.errors = []; });

describe('the dashboard notice', () => {
  it('speaks through the one toast surface the rest of the site uses', () => {
    showStatus('נשמר');
    expect(toasts.ok).toEqual(['נשמר']);
    expect(toasts.errors).toEqual([]);
  });

  it('tells an error from a confirmation, because they are not the same event', () => {
    showStatus('שגיאה', true);
    expect(toasts.errors).toEqual(['שגיאה']);
    expect(toasts.ok).toEqual([]);
  });

  it('puts NOTHING into the page — the whole point is that the content does not move', () => {
    document.body.innerHTML = '<main><div id="dash-panel-products">rows</div></main>';
    const before = document.body.innerHTML;
    showStatus('נשמר');
    showStatus('שגיאה', true);
    expect(document.body.innerHTML).toBe(before);
    // Belt and braces: the strip this replaced had a known id, and nothing may bring it back.
    expect(document.getElementById('ajax-status')).toBeNull();
  });

  it('still works on a page with no dashboard markup at all', () => {
    // The old implementation depended on finding an anchor and gave up when it could not, which
    // silently recreated the original bug on any surface shaped differently. A toast has no anchor.
    showStatus('נשמר');
    expect(toasts.ok).toEqual(['נשמר']);
  });

  it('accepts the anchor argument its callers still pass, and needs none', () => {
    document.body.innerHTML = '<main><p id="row">x</p></main>';
    showStatus('נשמר', false, document.getElementById('row'));
    expect(toasts.ok).toEqual(['נשמר']);
    expect(document.getElementById('row')!.previousElementSibling).toBeNull();
  });
});

describe('dashboard scripts anchor to classes the markup actually renders', () => {
  const MARKUP_DIRS = ['src/pages', 'src/components', 'src/layouts'];
  /** Classes written by scripts at runtime rather than rendered by a template. */
  const RUNTIME_ONLY = new Set(['ajax-status', 'dash-error', 'dash-success']);

  function walk(dir: string, test: RegExp, out: string[] = []): string[] {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return out; }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, test, out);
      // A `.ts` under `src/pages` is an ENDPOINT by Astro's routing convention — server code that
      // renders no markup, so it is not a source of classes and its outbound URLs are not the
      // page's business.
      else if (dir.startsWith('src/pages') ? path.endsWith('.astro') : test.test(path)) out.push(path);
    }
    return out;
  }

  it('has no querySelector class that no template renders', () => {
    // A script rendering its own markup with `innerHTML` is a perfectly good source of a class —
    // `orders.ts` both writes and queries `.order-note-del-yes` — and so is `src/lib`, which builds
    // the chart's `.line-dot` and the invoice chip. So the corpus is everything, and what is
    // REMOVED from it is every `querySelector` argument: a class that appears only inside a query
    // is a class nothing renders, which is exactly the failure being hunted. Without that
    // subtraction the test proves only that the string appears somewhere, which it always does.
    const QUERY = /querySelector(?:All)?\(\s*'[^']*'/g;
    const corpus = [
      ...MARKUP_DIRS.flatMap((d) => walk(d, /\.astro$/)),
      ...walk('src/scripts', /\.ts$/),
      ...walk('src/lib', /\.ts$/),
    ].map((f) => readFileSync(f, 'utf8').replace(QUERY, '')).join('\n');

    const missing: string[] = [];
    for (const file of walk('src/scripts/dashboard', /\.ts$/)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/querySelector(?:All)?\(\s*'\.([a-zA-Z0-9_-]+)'/g)) {
        const cls = m[1]!;
        if (RUNTIME_ONLY.has(cls)) continue;
        if (!new RegExp(`[\\s"'\`.]${cls}[\\s"'\`:,)]`).test(corpus)) missing.push(`${file}  →  .${cls}`);
      }
    }
    expect(missing, [
      'A dashboard script queries a CSS class that no template renders.',
      'The query returns null, `?.` swallows it, and the feature does nothing — silently, in the',
      "seller's browser. This is how the status banner went missing for 56 call sites.",
      '',
      ...missing,
    ].join('\n')).toEqual([]);
  });
});

describe('the ✓ hold does not resize the button it lands on', () => {
  it('pins both dimensions while the tick shows, and releases them after', async () => {
    // The owner's correction (2026-08-17): the ✓ replaces a line of TEXT, so without a pinned
    // height the button collapses to the icon's own 13px and the whole row of controls jumps —
    // twice, once each way. Width was already pinned; height is the one that shows.
    const { flashConfirmed } = await import('../src/scripts/dashboard/btn-confirm.js');
    document.body.innerHTML = '<button id="b" class="btn">השהה</button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    // jsdom reports 0 for every box, so this asserts WHAT was pinned rather than a real size.
    Object.defineProperty(btn, 'offsetWidth', { value: 88, configurable: true });
    Object.defineProperty(btn, 'offsetHeight', { value: 32, configurable: true });

    flashConfirmed(btn, { holdMs: 20 });
    expect(btn.style.minWidth).toBe('88px');
    expect(btn.style.height).toBe('32px');
    expect(btn.classList.contains('btn--confirmed')).toBe(true);

    await new Promise((r) => { setTimeout(r, 60); });
    expect(btn.style.minWidth).toBe('');
    expect(btn.style.height).toBe('');
    expect(btn.textContent).toBe('השהה');
    expect(btn.classList.contains('btn--confirmed')).toBe(false);
  });

  it('leaves the button alone when its list was redrawn under it', async () => {
    // The card is replaced by the refetch, so the restore must not write to a detached element.
    const { flashConfirmed } = await import('../src/scripts/dashboard/btn-confirm.js');
    document.body.innerHTML = '<button id="b" class="btn">השהה</button>';
    const btn = document.getElementById('b') as HTMLButtonElement;
    Object.defineProperty(btn, 'offsetHeight', { value: 32, configurable: true });
    flashConfirmed(btn, { holdMs: 20 });
    btn.remove();
    await new Promise((r) => { setTimeout(r, 60); });
    // Still holding the pinned size — untouched, because nothing may be written to a node the
    // page no longer contains. (In the browser this element is already garbage; what matters is
    // that the timer did not throw trying to restore it.)
    expect(btn.style.height).toBe('32px');
  });
});

/* MOVED, 2026-08-18 → tests/busy-label.test.ts.
   Two cases lived here and both were shape assertions: one checked that the string
   `workingLabel.replace(` appeared in ConfirmModal, the other that the same line still matched a
   regex. Neither ever read a CALL SITE, despite the second one being named
   "leaves no confirm caller passing a label the dots will duplicate" — so when the bulk delete
   composed `"מוחק... (3)"`, which the end-anchored strip could not touch, both stayed green while
   the six dots were back on screen (owner, 2026-08-18). A guard that asserts a line exists cannot
   fail for the reason its name promises. The replacement tests the behaviour and scans the
   callers. */
