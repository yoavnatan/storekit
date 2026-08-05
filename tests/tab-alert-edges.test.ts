// @vitest-environment jsdom
//
// A tab strip that overflows hides its own markers. On a phone the seller's
// Messages tab is off the right edge, and the red unread dot on it is off the
// edge with it — so "you have unread messages" was information the strip had
// and could not show (owner, 2026-08-05). initTabAlertEdges puts a dot of the
// marker's own colour on the fade at the edge you'd have to scroll toward.
//
// Two things here are worth a test rather than a read-through: the RTL mapping
// (a marker off the VISUAL left is off the LOGICAL *end* in Hebrew — get it
// backwards and the beacon points the wrong way, which is worse than none), and
// the contract that every marker declares its own severity, since five marker
// sites across three modules is exactly the shape that grows a sixth without it.
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initTabAlertEdges } from '../src/scripts/dashboard/tab-alert-edges.js';

// jsdom has no layout — every rect is 0×0 — so the geometry is stubbed. The
// strip is the window [0,300]; each tab is placed by the test.
function rect(left: number, right: number): DOMRect {
  return { left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

function place(el: Element, left: number, right: number): void {
  el.getBoundingClientRect = () => rect(left, right);
}

/** jsdom reports every scroll dimension as 0, which reads as "fits". */
function overflow(el: HTMLElement, on: boolean): void {
  Object.defineProperty(el, 'scrollWidth', { value: on ? 800 : 300, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true });
}

let strip: HTMLElement;

/** A strip of three tabs; only the ones named here carry a marker. */
function build(markers: Array<{ tab: number; severity: string; left: number; right: number; hidden?: boolean }>): HTMLElement {
  document.body.innerHTML = `
    <div class="dash-tabs">
      <button role="tab" data-panel="a"></button>
      <button role="tab" data-panel="b"></button>
      <button role="tab" data-panel="c"></button>
    </div>`;
  const el = document.querySelector<HTMLElement>('.dash-tabs')!;
  place(el, 0, 300);
  overflow(el, true);
  const tabs = el.querySelectorAll('[role="tab"]');
  for (const m of markers) {
    const span = document.createElement('span');
    span.setAttribute('data-tab-alert', m.severity);
    if (m.hidden) span.hidden = true;
    place(span, m.left, m.right);
    tabs[m.tab].appendChild(span);
  }
  return el;
}

describe('tab-strip off-screen marker beacon', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('flags nothing while every marker is inside the strip', () => {
    strip = build([{ tab: 1, severity: 'danger', left: 140, right: 150 }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertStart).toBeUndefined();
    expect(strip.dataset.alertEnd).toBeUndefined();
  });

  it('LTR: a marker past the right edge is at the logical END', () => {
    strip = build([{ tab: 2, severity: 'danger', left: 310, right: 320 }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBe('danger');
    expect(strip.dataset.alertStart).toBeUndefined();
  });

  it('LTR: a marker past the left edge is at the logical START', () => {
    strip = build([{ tab: 0, severity: 'warning', left: -20, right: -10 }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertStart).toBe('warning');
    expect(strip.dataset.alertEnd).toBeUndefined();
  });

  it('RTL: the sides swap — visual left is the logical END', () => {
    // The whole point of the mapping. The fades are placed with
    // inset-inline-start/end, so in Hebrew the "start" fade is on the RIGHT;
    // a beacon that skipped this would light the fade the seller is already
    // looking at and stay dark on the one hiding the marker.
    strip = build([
      { tab: 0, severity: 'danger', left: -20, right: -10 },
      { tab: 2, severity: 'warning', left: 310, right: 320 },
    ]);
    strip.style.direction = 'rtl';
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBe('danger');
    expect(strip.dataset.alertStart).toBe('warning');
  });

  it('a partly-clipped marker still counts — half a badge is not a readable one', () => {
    strip = build([{ tab: 2, severity: 'danger', left: 295, right: 315 }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBe('danger');
  });

  it('ignores a hidden marker — a zeroed count must not keep the beacon lit', () => {
    // Every marker but the seller's orders badge stays in the DOM at count 0 and
    // is toggled with `hidden` (products.ts, admin tab-nav.ts, admin-messages.ts).
    strip = build([{ tab: 2, severity: 'danger', left: 310, right: 320, hidden: true }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBeUndefined();
  });

  it('danger outranks warning on the same side', () => {
    strip = build([
      { tab: 1, severity: 'warning', left: 310, right: 320 },
      { tab: 2, severity: 'danger', left: 330, right: 340 },
    ]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBe('danger');
  });

  it('ignores an unknown severity rather than painting a transparent dot', () => {
    strip = build([{ tab: 2, severity: 'shout', left: 310, right: 320 }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBeUndefined();
  });

  it('finds a marker declared on the tab button itself, not only inside it', () => {
    strip = build([]);
    const tab = strip.querySelectorAll('[role="tab"]')[2] as HTMLElement;
    tab.setAttribute('data-tab-alert', 'danger');
    place(tab, 310, 400);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBe('danger');
  });

  it('clears the beacon once the strip stops overflowing', () => {
    // A resize (or a tab removed) can put a marker back in plain sight without
    // the marker itself changing — the early "it fits" exit must still fall
    // through to the write, or the beacon points at nothing forever.
    strip = build([{ tab: 2, severity: 'danger', left: 310, right: 320 }]);
    const sync = initTabAlertEdges(strip);
    sync();
    expect(strip.dataset.alertEnd).toBe('danger');
    overflow(strip, false);
    sync();
    expect(strip.dataset.alertEnd).toBeUndefined();
  });

  it('re-syncs on its own when a marker changes — no writer has to call back', () => {
    // The counts are live (orders.ts rebuilds its badge, products.ts flips
    // `hidden`, messages.ts polls, admin's tab-nav clears a count on leaving a
    // tab). A "and now re-sync" call handed to each is the shape that rots.
    strip = build([{ tab: 2, severity: 'danger', left: 310, right: 320 }]);
    initTabAlertEdges(strip)();
    expect(strip.dataset.alertEnd).toBe('danger');

    strip.querySelector('[data-tab-alert]')!.remove();
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(strip.dataset.alertEnd).toBeUndefined();
        resolve();
      });
    });
  });
});

describe('the marker contract', () => {
  // A comment may legitimately quote the very string a guard forbids — that is
  // how these checks fail on the note explaining themselves.
  // Both directions matter: a comment may quote the very string a guard forbids
  // (that is how these checks fail on the note explaining themselves), and a
  // comment mentioning `data-tab-alert` beside a badge would satisfy the guard
  // after the real attribute was deleted.
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

  it('every .dash-tab-badge that gets CREATED declares its severity', () => {
    // A new badge without data-tab-alert is invisible to the beacon and nothing
    // else complains. Creation sites only — a querySelector that reads one back
    // needs nothing.
    const files = ['src/pages/seller/dashboard.astro', 'src/scripts/dashboard/orders.ts'];
    for (const rel of files) {
      const src = read(rel);
      for (const match of src.matchAll(/(?:class="|className\s*=\s*')dash-tab-badge/g)) {
        // Same element: either side of the class in markup, or the next couple
        // of lines in JS where the attribute is set after the assignment.
        const around = src.slice(Math.max(0, match.index - 400), match.index + 400);
        expect(around, `${rel}: a .dash-tab-badge with no data-tab-alert`).toContain('data-tab-alert');
      }
    }
  });

  it('the Messages tab dot is found by its severity attribute, not by "a span with a label"', () => {
    // `#tab-messages span[aria-label]` named no particular element and would
    // claim any labelled span the tab grew later; it also let the SSR dot and
    // the polled one drift apart (one drew --color-danger, the other #ef4444).
    const src = read('src/scripts/dashboard/messages.ts');
    expect(src).not.toContain('span[aria-label]');
    expect(src).toContain("'[data-tab-alert]'");
    expect(src).not.toContain('#ef4444');
  });

  it('both dashboards mark up their tab counts', () => {
    expect(read('src/pages/admin/index.astro')).toContain('data-tab-alert');
    expect(read('src/pages/seller/dashboard.astro')).toContain('data-tab-alert="warning"');
  });

  it('the beacon is painted by the fade, so it can never outlive it', () => {
    // .dash-tab-fade sets `opacity`, which makes a group — drawing the dot as
    // its ::after is what guarantees the beacon only shows while there really
    // is strip left to scroll that way. A separate element would need a second
    // visibility state kept in step with the first.
    const css = read('src/styles/pages/dashboard.css');
    expect(css).toMatch(/\.dash-tab-fade::after\s*\{/);
    expect(css).toContain('.dash-tabs[data-alert-start]');
    expect(css).toContain('.dash-tabs[data-alert-end]');
  });
});
