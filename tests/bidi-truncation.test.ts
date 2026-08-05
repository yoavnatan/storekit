/**
 * `dir="auto"` may not sit on a one-line label that truncates.
 *
 * The trap is that `dir` decides TWO things and only one of them is ever wanted
 * on a name: the order the characters run in, and which edge the box aligns and
 * truncates from. On a store card, an English store name resolved the span to
 * `ltr`, so `text-align: start` became LEFT — and since the span filled the
 * title column, the name drifted to the far side of the card, away from the very
 * logo it names, with the ellipsis eating the wrong end (user, 2026-08-05).
 *
 * `<bdi>` is the element for this: it isolates the text's own direction and
 * leaves the block in the page's, which is exactly the split a label wants.
 * `dir="auto"` stays correct on a PARAGRAPH — a Hebrew description on an English
 * page should be right-aligned as a whole — so this guard is deliberately narrow
 * and fires only where the element also truncates to one line.
 *
 * Five surfaces had it: the store card's name and tagline, the homepage product
 * tile, both labels on a search result, the spotlight tagline, and two dashboard
 * pickers.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full, exts);
    return exts.some((e) => full.endsWith(e)) ? [full] : [];
  });
}

/** Class names whose own CSS rule truncates to one line with an ellipsis. */
function truncatingClasses(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(SRC, 'styles'), ['.css'])) {
    const css = readFileSync(file, 'utf8');
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/text-overflow:\s*ellipsis/.test(rule[2]!)) continue;
      for (const cls of rule[1]!.matchAll(/\.([a-zA-Z0-9_-]+)/g)) found.add(cls[1]!);
    }
  }
  return found;
}

/** Tailwind's own one-line truncation utilities. */
const TRUNCATING_UTILITIES = ['truncate', 'text-ellipsis'];

describe('a truncating label isolates its direction instead of adopting it', () => {
  const classes = truncatingClasses();

  it('found the CSS classes it is guarding, so a refactor cannot make this a no-op', () => {
    expect(classes.has('store-card__name')).toBe(true);
    expect(classes.size).toBeGreaterThan(5);
  });

  it('no element both truncates and carries dir="auto"', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC, ['.astro', '.ts'])) {
      const source = readFileSync(file, 'utf8');
      // Whole opening tags, so `class` and `dir` are only compared within one element.
      for (const tag of source.matchAll(/<[a-zA-Z][^<>]*>/g)) {
        const text = tag[0]!;
        if (!/\bdir=(["'])auto\1/.test(text)) continue;
        const classAttr = /\bclass=(["'`])([\s\S]*?)\1/.exec(text)?.[2] ?? '';
        const tokens = classAttr.split(/[\s{}()]+/).filter(Boolean);
        const truncates = tokens.some((t) => classes.has(t) || TRUNCATING_UTILITIES.includes(t));
        if (truncates) {
          const line = source.slice(0, tag.index!).split('\n').length;
          offenders.push(`${relative(process.cwd(), file)}:${line}`);
        }
      }
    }
    expect(offenders, 'wrap the text in <bdi> and drop dir="auto" — see this file\'s header').toEqual([]);
  });
});
