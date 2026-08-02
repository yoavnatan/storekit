import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The unitless-zero guard.
 *
 * `calc()` cannot add a plain number to a length. So the moment a custom
 * property that some calc() consumes is declared as bare `0` instead of `0px`,
 * EVERY calc() reading it goes invalid at once — and CSS's failure mode here is
 * silence: no console warning, no visibly broken rule, just properties that fall
 * back to their initial value.
 *
 * Hit 2026-08-02 on the seller dashboard's mobile tab strip. Narrowing the strip
 * to full-bleed meant `--dash-tab-pad: 0`, which is consumed by three calcs on
 * the edge-fade overlays: their `width`, and both sticky inset offsets. All
 * three died together, so the fades collapsed to zero width AND lost their
 * pinning — the tabs cut off hard at the screen edge with no hint that the strip
 * scrolled, which is exactly what the fades exist to prevent. The declaration
 * looked completely ordinary; only measuring the rendered box found it.
 *
 * Note that the `var(--x, 0px)` fallbacks already written on those calcs do NOT
 * catch this. A fallback fires for an UNDEFINED property, never for one that is
 * defined and badly typed — so the safety net that looks like it covers this is
 * the one thing that cannot.
 *
 * The rule: any custom property that appears inside a calc() anywhere in the
 * codebase must never be declared unitless-zero. Write `0px`.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const SCANNED = /\.(css|astro|ts)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SCANNED.test(entry.name)) out.push(path);
  }
  return out;
}

const files = walk(SRC_DIR).map(path => ({ path, text: readFileSync(path, 'utf8') }));

/** Every `--name` that appears inside a `calc(…)`, anywhere in src/. */
const usedInCalc = new Set<string>();
for (const { text } of files) {
  // Non-greedy to the first `)` is enough: a nested `var(--x, …)` closes first,
  // and the property name we want is always ahead of that close paren.
  for (const call of text.matchAll(/calc\([^;{}]*?\)/g)) {
    for (const ref of call[0].matchAll(/var\(\s*(--[\w-]+)/g)) usedInCalc.add(ref[1]);
  }
}

describe('custom properties consumed by calc()', () => {
  it('is a non-empty scan (the regex above still matches this codebase)', () => {
    expect(usedInCalc.size).toBeGreaterThan(0);
  });

  it('are never declared as a unitless zero', () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      text.split('\n').forEach((line, i) => {
        for (const decl of line.matchAll(/(--[\w-]+)\s*:\s*0\s*(?=[;}]|$)/g)) {
          if (!usedInCalc.has(decl[1])) continue;
          offenders.push(`${relative(SRC_DIR, path)}:${i + 1} — ${decl[1]}: 0 (write 0px)`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
