/**
 * A Tailwind STATE utility (`hover:`, `focus:`, `aria-*:`, `data-*:`) is dead on arrival when a
 * legacy class on the SAME element already sets that property from an UNLAYERED stylesheet:
 * unlayered CSS beats `@layer utilities` however specific the utility is. Nothing warns. The
 * element simply never changes on hover / on open, and it looks like the state wiring is broken.
 *
 * Three times now:
 *  · 2026-07-15 — reset.css's bare `button { border: none; background: none }` killed every
 *    border/bg utility on every button on the site. Fixed at the root by importing reset.css into
 *    `layer(base)` (main.css's header carries that story).
 *  · 2026-08-05 — the avatar menu's saved-stores row got `aria-expanded:[background:...]` to stay
 *    lit while its flyout is open. `.user-dropdown__item { background: none }` beat it, so the row
 *    only ever looked lit because the pointer was still resting on it (owner noticed).
 *  · 2026-08-05 — auditing that one: the category picker's trigger had carried
 *    `hover:border-[var(--color-muted)]` and `aria-expanded:border-[var(--color-accent)]` since it
 *    was written. `.input`'s `border` shorthand beat both. Measured on a running page, an open
 *    picker's border computed to `--color-border` — the resting value.
 *
 * So: no markup may put a state utility for a property on an element whose own legacy class sets
 * that property from an unlayered file. The fix is never Tailwind's `!` (that is a second rule
 * about the same property, in the file that does not own it) — it is a rule in the stylesheet
 * that already owns the element, keyed on the state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const SRC = join(process.cwd(), 'src');
const MAIN = join(SRC, 'styles/main.css');

/** Every stylesheet main.css pulls in WITHOUT `layer(...)` — the ones that outrank utilities. */
function unlayeredSheets(): string[] {
  // Comments stripped first: main.css's own header quotes an @import it is telling you NOT to
  // write, and reading that one sends this looking for a file that was never there.
  const css = readFileSync(MAIN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/@import\s+'(\.[^']+)'([^;]*);/g)]
    .filter(([, , rest]) => !rest.includes('layer('))
    .map(([, rel]) => resolve(dirname(MAIN), rel))
    .filter((p) => p.endsWith('.css'));
}

/** Which longhand-ish properties a simple `.class { ... }` rule sets. Shorthands count as the
 *  longhands they can win: `border` sets border-color, `background` sets background-color. */
const PROPS = [
  { re: /(?:^|[;{\s])background(?:-color)?\s*:/, prop: 'background' },
  { re: /(?:^|[;{\s])border(?:-color)?\s*:/, prop: 'border-color' },
  { re: /(?:^|[;{\s])color\s*:/, prop: 'color' },
];

/** className → the properties an UNLAYERED bare `.className { … }` rule sets. Bare only: a rule
 *  with a pseudo/attribute/descendant part does not fight a plain utility on equal terms. */
function legacyClassProps(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const file of unlayeredSheets()) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/(^|\})\s*\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g)) {
      const [, , cls, block] = m;
      for (const { re, prop } of PROPS) {
        if (!re.test(block)) continue;
        if (!map.has(cls)) map.set(cls, new Set());
        map.get(cls)!.add(prop);
      }
    }
  }
  return map;
}

/** The property a Tailwind utility writes, or null if this test does not reason about it. */
function utilityProp(util: string): string | null {
  const bare = util.replace(/^(?:[a-z-]+(?:\[[^\]]*\])?:)+/, ''); // strip every variant prefix
  if (/^\[background[^\]]*\]$/.test(bare) || /^bg-/.test(bare)) return 'background';
  if (/^\[border-color[^\]]*\]$/.test(bare) || /^border-\[/.test(bare)) return 'border-color';
  if (/^\[color[^\]]*\]$/.test(bare) || /^text-\[color:/.test(bare)) return 'color';
  return null;
}

const STATE = /^(?:hover|focus|focus-visible|active|aria-[a-z-]+|data-[a-z[\]=-]+|group-[a-z-]+|peer-[a-z-]+):/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(astro|ts)$/.test(e.name) ? [full] : [];
  });
}

describe('unlayered legacy CSS vs Tailwind state utilities', () => {
  it('no element wears a state utility for a property its own legacy class already sets', () => {
    const legacy = legacyClassProps();
    const clashes: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (file.includes(`${SRC}/styles/`)) continue;
      const src = readFileSync(file, 'utf8');
      // Both the markup form and the string form (client-built HTML uses the same class lists).
      for (const m of src.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/g)) {
        const classes = m[1].split(/\s+/).filter(Boolean);
        const owned = new Map<string, string>(); // property → the legacy class that owns it
        for (const c of classes) for (const p of legacy.get(c) ?? []) owned.set(p, c);
        if (owned.size === 0) continue;
        for (const c of classes) {
          if (!STATE.test(c)) continue;
          const prop = utilityProp(c);
          const owner = prop && owned.get(prop);
          if (owner) {
            clashes.push(`${file.replace(process.cwd() + '/', '')}: \`${c}\` is dead — .${owner} sets ${prop} from an unlayered sheet`);
          }
        }
      }
    }

    expect(clashes).toEqual([]);
  });

  it('knows what it is scanning — the map is not silently empty', () => {
    // Every assertion above passes vacuously if the CSS parse returns nothing, which is exactly
    // how a guard like this rots into a no-op after an unrelated refactor of main.css.
    const legacy = legacyClassProps();
    expect(legacy.size).toBeGreaterThan(20);
    expect(legacy.get('input'), '.input sets a border, and that is the case that started this').toContain('border-color');
    expect(unlayeredSheets().length).toBeGreaterThan(5);
  });
});
