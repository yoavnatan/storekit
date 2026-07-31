import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A loading placeholder that renders nothing looks EXACTLY like "no data" — it
// is the one bug in this area that cannot be spotted by looking at the page.
// It shipped: the performance charts and the advertising list both rendered
// `class="skeleton-shimmer"`, which is the name of the @keyframes and has never
// been a class, so three chart slots and the campaign list were blank boxes with
// no shimmer at all (found 2026-07-31, from "why is there no loader?").
//
// So: every placeholder class used anywhere in src/ must actually be defined in
// a stylesheet, and the keyframe name must never be used as one.

const SRC = join(process.cwd(), 'src');

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, exts);
    return exts.some((e) => full.endsWith(e)) ? [full] : [];
  });
}

const sources = walk(SRC, ['.astro', '.ts']);
const styles = walk(join(SRC, 'styles'), ['.css']).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('skeleton placeholders', () => {
  it('never uses the @keyframes name as a class', () => {
    const offenders = sources.filter((f) => /class(?:Name)?=["'`][^"'`]*\bskeleton-shimmer\b/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(process.cwd() + '/', ''))).toEqual([]);
  });

  it('only uses placeholder classes that a stylesheet defines', () => {
    const used = new Set<string>();
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/class(?:Name)?=["'`]([^"'`]*)["'`]/g)) {
        // A `${…}` in a template-literal class list is a runtime value, not a
        // class name — drop it before splitting or its first word reads as one.
        for (const token of m[1].replace(/\$\{[^}]*\}?/g, ' ').split(/\s+/)) {
          // Only the placeholder family — this is not a general "is every class
          // defined" check, which Tailwind utilities would make meaningless.
          if (/^skel(eton)?(-|$)/.test(token)) used.add(token);
        }
      }
    }
    const undefinedClasses = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(styles));
    expect(undefinedClasses).toEqual([]);
  });

  it('the shimmer class carries a real animation', () => {
    // Without this the class exists but paints a static block — the same
    // "looks like no data" failure, one layer down.
    const rule = styles.match(/\.skel-bar\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/animation:[^;]*skeleton-shimmer/);
    expect(styles).toMatch(/@keyframes\s+skeleton-shimmer/);
  });
});
