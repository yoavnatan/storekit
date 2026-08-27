/**
 * The header is the one element on this site that a shopper sees on every page, and the whole
 * point of it is that walking home → store → home does not make it move, change shape or blink
 * out. Three ways it stopped being that, all found on 2026-08-05, all silent — nothing throws,
 * the page is simply wrong for a moment or wrong in a way you only notice side by side:
 *
 *  1. A page hid `document.documentElement` to cover a content reflow. The store page did this
 *     while restoring scroll, so returning to a store you had scrolled blanked the FIXED header
 *     too, for up to half a second — the header appeared to vanish and come back on the single
 *     most common navigation on the site. Nothing in the header scrolls; it has nothing to
 *     restore and no reason to be hidden. Hide the content, never the root.
 *
 *  2. Two pages did not pass `storeMode`, which is not "this is a store" but the flag
 *     Header.astro reads to pick its ONE row mechanism. Those two built the row from the old
 *     `container between flex` branch and skipped `.site-header--store`, so the bar's bottom
 *     edge and its spacing changed the moment you arrived there from anywhere else.
 *     Header.astro's own frontmatter has claimed "every page passes storeMode" since
 *     2026-07-31; it had quietly stopped being true.
 *
 *  3. Seven pages nested a second `<main id="main-content">` inside the one BaseLayout already
 *     renders. Duplicate ids are invalid, `<main>` inside `<main>` is invalid, and the skip
 *     link — a WCAG item in the hard rules — resolves to whichever the browser meets first.
 *
 * Each is a rule a future page can break just by being written the ordinary way, which is why
 * this scans the tree rather than a file list: a page added tomorrow is covered the day it exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sourceGuard } from './helpers/source-guard.js';

const PAGES_DIR = join(process.cwd(), 'src', 'pages');
const SRC_DIR = join(process.cwd(), 'src');

function astroFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...astroFiles(full));
    else if (entry.name.endsWith('.astro')) out.push(full);
  }
  return out;
}

const rel = (f: string) => f.slice(process.cwd().length + 1);

/** The attribute list of every `<BaseLayout ...>` opening tag in a file.
 *  Scans to the `>` that closes the tag, ignoring any `>` inside an `{expression}`
 *  (`hasStore={n > 0}`) or inside a quoted attribute value. */
function baseLayoutProps(source: string): string[] {
  const found: string[] = [];
  let at = source.indexOf('<BaseLayout');
  while (at !== -1) {
    let depth = 0;
    let quote = '';
    let end = at + '<BaseLayout'.length;
    while (end < source.length) {
      const ch = source[end];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
      end++;
    }
    found.push(source.slice(at, end));
    at = source.indexOf('<BaseLayout', end);
  }
  return found;
}

describe('header stability', () => {
  it('no page hides the document root — that takes the fixed header with it', () => {
    const offenders: string[] = [];
    for (const file of astroFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        // `overflow`/`overflowY` on the root is the modal scroll lock and is fine: it does not
        // stop the header painting. Only visibility/display, which do.
        if (/document\.(documentElement|body)\.style\.(visibility|display)\s*=/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'Hide the content element instead (see [storeSlug]/index.astro\'s anti-flash curtain).\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('every page passes storeMode — one row mechanism for the whole site', () => {
    const offenders: string[] = [];
    for (const file of astroFiles(PAGES_DIR)) {
      for (const tag of baseLayoutProps(readFileSync(file, 'utf8'))) {
        if (!/\bstoreMode\b/.test(tag)) offenders.push(rel(file));
      }
    }
    expect(
      offenders,
      'storeMode is not "this is a store" — it is the flag Header.astro reads to pick its row\n' +
        'mechanism, and a page without it renders the legacy `container between flex` branch and\n' +
        'loses the header rule. Pass storeMode={true}. Missing in:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('only BaseLayout declares id="main-content"', () => {
    const offenders: string[] = [];
    for (const file of astroFiles(SRC_DIR)) {
      if (rel(file) === join('src', 'layouts', 'BaseLayout.astro')) continue;
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        // The skip link's href and a getElementById lookup both name it and are correct.
        if (/\bid=["']main-content["']/.test(line)) offenders.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(
      offenders,
      'BaseLayout already wraps the slot in <main id="main-content">. A second one nests <main>\n' +
        'inside <main> and duplicates the id the skip link targets. Use a <div>. Found at:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('does not decide its own width from an element further down the document', () => {
    /* The fourth way it stopped being still, and the only one that needed a stopwatch to see.
       The dashboard header runs full bleed, and `dashboard.css` used to say so with
       `html:has(#dash-main-card.dash-nav-side) .site-header > .container` — an ancestor selector
       whose subject sits about a thousand lines BELOW the header in the document. While the page
       streams, `:has()` has not met that element yet, so the header painted at the storefront's
       1160px and snapped to 1440px when the card finally arrived.

       Measured on a production build at 1440×900, sampling every frame: `L140 W1160` at 422ms,
       `L0 W1440` at 479ms. Three frames — long enough to read as a flicker, short enough that
       what moved is not identifiable, which is exactly how it was reported (owner, 2026-08-27:
       *"קופץ למרכז לשבריר שניה ואז חוזר למקום"*). It reproduced on the LIVE site and NOT on the
       dev server, where the shift lands at 1.6s from Astro's style injection and looks like a
       different bug entirely.

       The rule: the header's width comes from `dashNav`, which the page already computed on the
       server, so the first paint is the final one. A `:has()` reaching down the tree for it is a
       flicker every time, and the guard rejects the exact selector that was there. */
    expect(sourceGuard({
      file: 'src/styles/pages/dashboard.css',
      rule: 'the site header does not size itself from a :has() that reaches down the document',
      find: (text) => [...text.matchAll(/html:has\([^)]*\)\s*\.site-header[^{]*\{/g)].map((m) => m[0]),
      mustReject: 'html:has(#dash-main-card.dash-nav-side) .site-header > .container { max-width: none; }',
    })).toEqual([]);
  });
});
