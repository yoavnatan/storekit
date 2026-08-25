/**
 * ACCESSIBILITY — the tree scan, and the classes that have actually shipped here.
 *
 * **Why a static scan when axe exists.** axe is the real check and it was driven over the whole
 * public site on 2026-08-25 (ten routes, 1280px and 375px, plus a keyboard drive). But axe needs a
 * running server and a logged-in session, so it cannot see the seller and admin dashboards without
 * credentials, and it cannot run in this suite at all. What it CAN'T cover is exactly where an
 * untouched surface rots — the same argument the area-audit table makes about diffs. So: axe finds
 * them once, and this file stops each class coming back, over `src/**` including every page no
 * scan can reach.
 *
 * **Every rule below is a bug that was real in this repo on the day it was written**, not a
 * checklist item copied from a standard:
 *
 *   1. `aria-pressed` on a LINK — the `/stores` category chips. Invalid ARIA (axe: critical); a
 *      screen reader is handed a pressed state with nothing to map it to. The store page's own chip
 *      row had already moved to `aria-current="page"`; this was the copy that never followed, which
 *      is the twin-drift class (memory `project_brand_boost_twin_drift`).
 *   2. **Combobox attributes on a plain input** — the store search field carried
 *      `aria-expanded`/`aria-controls`/`aria-autocomplete` with no `role="combobox"`, none of which
 *      a `searchbox` allows. The field announced as a plain text box that never said a list opened.
 *   3. **`role="button"` with no `tabindex`** — an element that looks operable and cannot be
 *      reached by keyboard at all.
 *   4. **An icon-only button with no accessible name** — a control a screen reader announces as
 *      "button" and nothing else.
 *   5. **`aria-controls` pointing at an id that does not exist** — the relationship is simply not
 *      there, and it fails silently in every browser.
 *   6. **A positive `tabindex`** — it does not move one control forward, it moves it in front of
 *      the ENTIRE document, and the damage is to pages that never declared one.
 *
 * The legal frame is not incidental: תקנה 35 requires ת״י 5568 level AA, we have **no exemption**
 * (the ₪1,000,000 turnover one reaches only sites operating before 26.10.2017), and `/accessibility`
 * publicly states that the site meets it. `docs/legal-privacy-accessibility.md` carries the source.
 * A regression here makes a published statement false, which is the part that is not recoverable.
 *
 * **A failure is fixed in the markup, never by widening a rule here.**
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(astro|ts)$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles().map((f) => ({ rel: f.slice(SRC.length + 1), src: readFileSync(f, 'utf8') }));

/** Comments come out before anything is matched. This file necessarily NAMES the patterns it
 *  bans, and a scan that reads its own documentation as a violation reports nothing but itself —
 *  the mirror image of a guard that reads its documentation as compliance, which is a mistake this
 *  repo made on 2026-08-25 in `tests/consent.test.ts` and fixed the same hour. */
function stripComments(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // A block comment opens after whitespace or a `{` — NEVER mid-token. Without that anchor this
    // line ate `accept="image/*"` in the dashboard and everything after it up to the next `*/`,
    // which landed inside a stylesheet 1,300 lines later and reported the CSS as a bad <input>.
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1 ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const CLEAN = FILES.map((f) => ({ rel: f.rel, src: stripComments(f.src) }));

describe('ARIA that is invalid on the element carrying it', () => {
  it('aria-pressed is never on a link — a link says aria-current="page"', () => {
    const bad = CLEAN.flatMap(({ rel, src }) =>
      [...src.matchAll(/<a\b[^>]*aria-pressed[^>]*>/g)].map((m) => `${rel}: ${m[0].slice(0, 100)}`));
    expect(bad, 'aria-pressed is valid on a button only — use aria-current="page"').toEqual([]);
  });

  it('an input with combobox attributes declares role="combobox"', () => {
    const bad = CLEAN.flatMap(({ rel, src }) =>
      [...src.matchAll(/<input\b[^>]*>/g)]
        .filter((m) => /aria-expanded|aria-autocomplete|aria-controls/.test(m[0]))
        // `list=` maps an input to combobox implicitly in the browser. Accepted, because that is
        // how the home search field works and it is genuinely valid — but never the thing to copy:
        // an implicit mapping is not a declaration, and the store field's missing role was the bug.
        .filter((m) => !/role=["'{ ]*combobox/.test(m[0]) && !/\blist=/.test(m[0]))
        .map((m) => `${rel}: ${m[0].slice(0, 110)}`));
    expect(bad, 'a searchbox/textbox allows none of aria-expanded/controls/autocomplete').toEqual([]);
  });
});

describe('anything that claims to be operable is reachable and named', () => {
  it('role="button" always carries a tabindex', () => {
    const bad = CLEAN.flatMap(({ rel, src }) =>
      [...src.matchAll(/<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\brole=["'{ ]*button\b[^>]*>/g)]
        // A real <button> with role="button" is redundant but harmless and already focusable.
        .filter((m) => !/^<button\b/.test(m[0]) && !/tabindex/.test(m[0]))
        .map((m) => `${rel}: ${m[0].slice(0, 110)}`));
    expect(bad, 'role="button" without tabindex cannot be reached by keyboard at all').toEqual([]);
  });

  it('an icon-only button has an accessible name', () => {
    const bad: string[] = [];
    for (const { rel, src } of CLEAN) {
      for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const attrs = m[1] ?? '';
        if (/aria-label|aria-labelledby|title=/.test(attrs)) continue;
        // Strip the icons; whatever text survives IS the name. A `{expr}` survives as itself and
        // counts, because on this site it is a `getT()` lookup. An empty body is not a violation
        // either — `ConfirmModal` fills its two buttons' text when it opens, which is why the
        // check is "nothing left AND nothing to fill it", i.e. no expression anywhere either.
        const rest = (m[2] ?? '')
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (rest.length > 0) continue;
        if (/textContent|innerText|innerHTML/.test(src.slice(m.index ?? 0, (m.index ?? 0) + 4000))) continue;
        bad.push(`${rel}: ${m[0].replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
    expect(bad, 'an icon-only button announces as "button" and nothing else — add aria-label').toEqual([]);
  });
});

describe('relationships and focus order', () => {
  it('every aria-controls points at an id that exists', () => {
    // A dangling relationship is not an error in any browser — it is simply absent, and the only
    // symptom is a screen reader never being told the panel a control opens.
    const ids = new Set<string>();
    for (const { src } of CLEAN) {
      for (const m of src.matchAll(/\bid=["'`]([A-Za-z][\w-]*)/g)) ids.add(m[1]!);
    }
    const bad = CLEAN.flatMap(({ rel, src }) =>
      [...src.matchAll(/aria-controls=["']([A-Za-z][\w-]*)["']/g)]
        .filter((m) => !ids.has(m[1]!))
        .map((m) => `${rel}: aria-controls="${m[1]}"`));
    expect(bad, 'aria-controls names an element that is never rendered').toEqual([]);
  });

  it('no positive tabindex anywhere', () => {
    // A positive value does not move one control forward — it moves it ahead of the whole
    // document, and the pages it breaks are the ones that never declared one.
    const bad = CLEAN.flatMap(({ rel, src }) =>
      [...src.matchAll(/tabindex=["'{ ]*([1-9]\d*)/g)].map((m) => `${rel}: tabindex=${m[1]}`));
    expect(bad, 'use DOM order; a positive tabindex reorders the entire page').toEqual([]);
  });
});
