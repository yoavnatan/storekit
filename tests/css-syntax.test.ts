import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every stylesheet's braces balance.
 *
 * **Why this exists (2026-08-12).** A rule was edited to remove a declaration and its closing `}`
 * went with it. `npm run verify -- --all` then reported GREEN — twice — because nothing it runs
 * compiles CSS: `astro check` type-checks, ESLint reads JS/TS, and Vitest never touches the
 * stylesheet. Tailwind is what parses this, and Tailwind only runs during a dev server or a build.
 * So the whole site was broken (`CssSyntaxError: Missing closing }` — every page, no styles at all)
 * and the gate that exists to catch exactly that said it was fine. The owner found it by loading a
 * page, which is the one place this class always surfaces and the most expensive place to find it.
 *
 * A full Tailwind compile in `verify` would be the thorough answer and is far too slow for a check
 * that runs after every edit. This is the cheap one that catches the actual failure mode: an
 * unbalanced file. It reads in milliseconds and it would have failed on that commit.
 *
 * Comments and strings are stripped first — a `{` inside either is not structure, and counting it
 * would make the guard cry wolf, which is how a guard gets deleted.
 */

const STYLES = join(process.cwd(), 'src', 'styles');

const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);

/** Strip block comments and quoted strings, so only structural braces remain. */
function structural(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const FILES = cssFiles(STYLES);

describe('CSS syntax', () => {
  it('finds the stylesheets at all (a moved directory must fail loudly, not silently pass)', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each(FILES.map((f) => [f.slice(STYLES.length + 1), f]))('%s has balanced braces', (_name, file) => {
    const css = structural(readFileSync(file, 'utf8'));
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    expect({ open, close }).toEqual({ open, close: open });
  });

  it.each(FILES.map((f) => [f.slice(STYLES.length + 1), f]))('%s never closes more than it opened', (_name, file) => {
    // Balanced totals are not enough: `} .foo {` balances and is still broken. Depth must never go
    // negative while walking the file.
    const css = structural(readFileSync(file, 'utf8'));
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) break;
    }
    expect(depth).toBeGreaterThanOrEqual(0);
  });
});
