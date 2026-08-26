import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The standard `backdrop-filter` is written AFTER its `-webkit-` twin, never before.
 *
 * **This is a production-only defect, which is why it survived for months.** With the standard
 * property first, the build's CSS minifier treats it as a duplicate of the `-webkit-` line that
 * follows and drops it, shipping only the prefixed one. Chromium does not honour
 * `-webkit-backdrop-filter` on its own — measured in a real browser on 2026-08-26, a rule carrying
 * only the prefixed property computes `backdrop-filter: none` — so every frosted surface on this
 * site was flat in Chrome, Edge and Firefox in every production build, while `npm run dev` (which
 * does not minify) looked exactly right.
 *
 * The owner found it by looking at the deployed site: *"ברנדר נראה שזה שקוף לחלוטין בלי שום
 * עכירות"*. Nothing else could have — the source is correct CSS, the tests passed, and the page
 * looked perfect on every developer machine.
 *
 * The rule is the ordinary authoring convention (prefixed first, standard last, so the standard one
 * wins wherever both are understood). It is enforced here because getting it backwards is invisible
 * in review, invisible in dev, and silently removes the effect in production.
 */

const ROOTS = ['src/styles', 'src/components', 'src/pages', 'src/layouts'];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(css|astro)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Offending files: those where a standard `backdrop-filter` declaration appears before a `-webkit-`
 * one with nothing but whitespace between them — the shape the minifier collapses.
 *
 * Deliberately not "any file containing both": the two can legitimately live in different rules,
 * and a guard that cannot tell those apart is one people learn to work around.
 */
const WRONG_ORDER = /(?<![-\w])backdrop-filter\s*:[^;}]*;\s*-webkit-backdrop-filter\s*:/;

function offenders(files: readonly string[]): string[] {
  return files
    .filter((file) => WRONG_ORDER.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(process.cwd(), file));
}

describe('backdrop-filter', () => {
  it('rejects the order that the minifier silently collapses', () => {
    // The counter-example first — `tests/helpers/source-guard.ts`'s discipline, applied to a rule
    // that spans two files' worth of shapes rather than one file's text. Without this the check
    // would pass just as happily on a regex that never matches anything.
    const tmp = path.join(process.cwd(), 'node_modules', '.tmp-backdrop-guard.css');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, '.x::before{backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);}');
    try {
      expect(offenders([tmp]), 'the rule must catch the collapsing order').toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('accepts the correct order', () => {
    const tmp = path.join(process.cwd(), 'node_modules', '.tmp-backdrop-ok.css');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, '.x::before{-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);}');
    try {
      expect(offenders([tmp])).toEqual([]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('is written the surviving way everywhere in the tree', () => {
    const files = ROOTS.flatMap((root) => walk(path.join(process.cwd(), root)));
    expect(files.length, 'the scan found some files to check').toBeGreaterThan(10);
    expect(
      offenders(files),
      'A standard `backdrop-filter` written immediately before its `-webkit-` twin is dropped by the\n'
      + 'production minifier, and Chromium ignores the prefixed property on its own — so the effect\n'
      + 'disappears in production while dev looks correct. Put `-webkit-backdrop-filter` FIRST.',
    ).toEqual([]);
  });
});
