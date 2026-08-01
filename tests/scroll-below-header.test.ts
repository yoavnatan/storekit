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
});
