/**
 * A selector that names `html` or `:root` as a DESCENDANT can never match, and CSS will not say so.
 *
 * The rail's collapse chevron never turned, in either direction, for a day (owner, 2026-08-23:
 * *"החץ לא משנה שם את הכיוון שלו כשזה סגור/פתוח"*). Two conditions decide which way it points —
 * the writing direction and whether the rail is collapsed — and BOTH live on `<html>`: `dir` as an
 * attribute, `dash-nav-mini` as a class. They were written as
 *
 *     [dir="rtl"] html.dash-nav-mini .dash-rail-toggle__icon,
 *     html.dash-nav-mini [dir="rtl"] .dash-rail-toggle__icon { transform: none; }
 *
 * The first asks for an `html` inside something, which the document cannot contain. The second asks
 * for a `[dir]` element below `html`, and there is none — `dir` is on the root itself. So the rule
 * that was supposed to cancel the double-mirror never applied, both mirrors did, and the glyph
 * looked identical in both states. Nothing errors, nothing warns, and the stylesheet still loads:
 * the only symptom is a control that quietly does not respond.
 *
 * The fix in every case is the same shape — two conditions on one element are ONE compound
 * selector, `html.dash-nav-mini[dir="rtl"]` — so this scans for the mistake rather than for that
 * one instance. It is cheap and total: `html` and `:root` may only ever be the first compound of a
 * selector, or inside `:has()`/`:not()` where they are a different question.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = join(process.cwd(), 'src/styles');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return name.endsWith('.css') ? [full] : [];
  });
}

/** Comments hold example selectors and prose about the very mistake this looks for. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * `html` / `:root` preceded by a combinator — a space, `>`, `+` or `~` — and not part of a longer
 * identifier (`.chart-html`) and not opening a line (where the leading space is only indentation).
 * The `[^,{}(]` lookbehind-by-capture is what distinguishes "second compound of a selector" from
 * "first thing after a comma or a brace", which is legitimate.
 */
function unreachable(css: string): string[] {
  const found: string[] = [];
  for (const line of stripComments(css).split('\n')) {
    // Only selector lines: something before `{`, and never an at-rule prelude.
    const sel = line.includes('{') ? line.slice(0, line.indexOf('{')) : line;
    if (!sel.trim() || sel.trim().startsWith('@')) continue;
    for (const part of sel.split(',')) {
      const t = part.trim();
      if (!t) continue;
      // Inside :has()/:not() the root is a legitimate thing to ask about, so those are dropped
      // before the scan rather than special-cased inside it.
      const bare = t.replace(/:(?:has|not|is|where)\([^)]*\)/g, '');
      if (/[\s>+~](?:html\b|:root\b)/.test(bare)) found.push(t);
    }
  }
  return found;
}

describe('html and :root are never descendants', () => {
  it('catches the shape that shipped', () => {
    expect(unreachable('[dir="rtl"] html.dash-nav-mini .x { color: red }')).toHaveLength(1);
    expect(unreachable('html.dash-nav-mini [dir="rtl"] .x { color: red }')).toHaveLength(0);
    expect(unreachable('.a > :root .x { color: red }')).toHaveLength(1);
  });

  it('does not flag a legitimate root selector', () => {
    for (const ok of [
      'html.dash-nav-mini[dir="rtl"] .x { color: red }',
      'html:has(#dash-main-card.dash-nav-side) { --x: 1 }',
      ':root { --x: 1 }',
      '.chart-html .y { color: red }',
      '@media (min-width: 1180px) {',
    ]) {
      expect(unreachable(ok), ok).toHaveLength(0);
    }
  });

  it('finds none in the stylesheets', () => {
    const bad: string[] = [];
    for (const file of cssFiles(STYLES)) {
      for (const sel of unreachable(readFileSync(file, 'utf8'))) {
        bad.push(`${file.replace(process.cwd() + '/', '')}: ${sel}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
