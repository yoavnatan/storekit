import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The site header is `position:fixed` on every page (styles/components/header.css), and the seller
// dashboard stacks a sticky tab strip and a sticky panel head under it. `scrollIntoView({block:
// 'start'})` knows about none of that — it parks the target's top edge at viewport y:0, i.e. behind
// the header — so whatever you scrolled TO lands hidden and the scroll reads as an overshoot. That
// is the bug reported on checkout (the payment accordion's "פרטי תשלום" heading, 2026-08-01), and
// the same call shape was sitting in four other places. scroll-utils.ts owns the offset now.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk('src').filter((f) => /\.(ts|astro)$/.test(f));

/**
 * **A sticky element cannot be used as a scroll TARGET, because a pinned one reports where it is
 * pinned rather than where it belongs.**
 *
 * Opening the bulk-image panel from the bottom of a long products table scrolled to the panel's
 * BOTTOM (owner, 2026-08-23). The panel lives above the table, so from down there it was already
 * off the top of the screen — and its own `.bulk-upload-header` is `position: sticky`, so it
 * measured at y:54, pinned under the site header. "You are already there", said the arithmetic;
 * nothing moved; the galleries then loaded and grew the panel several hundred pixels above the
 * viewport, and the unchanged scroll position was suddenly looking at its foot. Measured: panel
 * top -452, bottom 133, header 54.
 *
 * The fix is to aim at the CONTAINER, whose top nothing pins, and this pins the fix: the two
 * helpers that scroll a panel into view must pass the container they were given, never the header
 * they looked up. A source assertion rather than a behavioural one because jsdom has no layout —
 * every rect it reports is zero, so the bug is invisible to it by construction.
 */
describe('a scroll target is never a sticky element', () => {
  const products = readFileSync('src/scripts/dashboard/products.ts', 'utf8');
  const body = products.slice(
    products.indexOf('function scrollStickyHeaderIntoView'),
    products.indexOf('function scrollEditRowIntoView'),
  );

  it('scrollStickyHeaderIntoView scrolls the container, not the header it found', () => {
    expect(body, 'the helper should be there to read').toContain('const header = container.querySelector');
    // The lookup stays — it is the "has this rendered yet" guard — but it must not be the target.
    expect(body).toContain('scrollBelowPinnedChrome(container');
    const code = body.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code, 'aiming at the header is the bug this file names').not.toContain('scrollBelowPinnedChrome(header');
  });
});

describe('scrolling to a target under the fixed header', () => {
  it("nobody uses scrollIntoView({block:'start'}) — it lands behind the fixed header", () => {
    // Code lines only: the helper and its call sites are allowed to NAME the call they replaced.
    const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);
    const offenders = sourceFiles.filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((line) => !isComment(line) && /scrollIntoView\(\s*\{[^}]*block:\s*['"]start['"]/.test(line)),
    );
    expect(offenders).toEqual([]);
  });

  it('nobody re-derives the pinned-bar offset from --site-header-h', () => {
    // Nothing in this codebase DEFINES that custom property — every use is a `var(..., fallback)`
    // in CSS. Reading it from JS returns '' and the offset silently becomes 0, which is exactly how
    // products.ts's edit-row scroll was landing under the header without anyone noticing.
    const offenders = sourceFiles
      .filter((f) => !f.endsWith(join('scripts', 'dashboard', 'scroll-utils.ts')))
      .filter((f) => /getPropertyValue\(\s*['"]--(site-header|dash-tabs|products-toolbar)-h['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the checkout payment accordion scrolls through the shared helper', () => {
    for (const f of ['src/pages/checkout.astro', 'src/components/ProductQuickView.astro']) {
      expect(readFileSync(f, 'utf8')).toContain('scrollBelowPinnedChrome');
    }
  });

  it('the products table never uses scrollIntoView — its edit form is TALLER than the viewport', () => {
    // `block:'nearest'` scrolls the least it can, which for a target taller than the scrollport
    // means aligning whichever edge is closer: open a row from below and the form's BOTTOM lands at
    // the viewport's bottom, i.e. the seller arrives in the middle of the form with the heading and
    // the Save button off-screen above. Reported 2026-08-12 on the toolbar's "ערוך", which was the
    // one opener left doing this — the row menu's own opener already went through
    // scrollEditRowIntoView, so the same button did two different things depending on how it was
    // pressed. Nothing here is short enough for scrollIntoView to be safe; the helper aims at the
    // form's own header and re-aims while the gallery images resize it.
    const products = readFileSync(join('src', 'scripts', 'dashboard', 'products.ts'), 'utf8');
    const codeLines = products.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(codeLines.filter((line) => /\.scrollIntoView\(/.test(line))).toEqual([]);
    expect(products).toContain('scrollEditRowIntoView');
  });
});
