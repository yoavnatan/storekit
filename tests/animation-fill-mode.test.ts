import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The forwards-fill guard.
 *
 * The bug it exists for, reported twice: "the homepage cards only SOMETIMES rise
 * on hover." `.card-reveal-play` (the entrance animation scroll-reveal.ts adds to
 * cards that were below the fold at load, and never removes) was declared with
 * `animation: card-reveal … both`. A filling animation lives in the ANIMATION
 * origin of the cascade, which outranks every normal author declaration — so it
 * pinned `transform: translateY(0) scale(1)` on the card forever and
 * `.home-product-card:hover { transform: translateY(-5px) }` silently lost. Cards
 * above the fold never got the class, so the lift worked on some cards and not
 * others, with no error anywhere. Impossible to spot by reading either rule
 * alone, which is why it comes back.
 *
 * THE RULE: an entrance animation whose final keyframe is just the element's
 * RESTING state must not fill forwards (`forwards` / `both`). It buys nothing —
 * ending with no fill lands on the same pixels — and it costs every later
 * `:hover`/`:focus`/JS-set style on that property. Use `backwards` instead: that
 * keeps the half that is actually needed (the from-state applies during
 * `animation-delay`, so a staggered card cannot flash in before its turn).
 *
 * A forwards fill is only correct when the END state is NOT the resting state —
 * an element animating OUT to hidden, or one whose final value has no other
 * source (see the allowlist). Those are listed by name with the reason.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Animations whose forwards fill is load-bearing: the element does NOT rest at
 * the final keyframe, so dropping the fill would visibly snap it back.
 */
const FILL_IS_LOAD_BEARING = new Map<string, string>([
  ['badge-pop-out', 'animates OUT to opacity 0 / scale(0.4) — the whole point is that it stays gone'],
  ['dropdown-fade-out', 'same: the dropdown must stay hidden after fading'],
  ['ripple-wave', 'ends at opacity 0 — the ripple must not reappear'],
  ['fade-in', 'applied to elements carrying Tailwind `opacity-0`, so their resting state IS 0 (seller/dashboard.astro) — without the fill they would vanish again'],
  ['top-bar-grow', 'ends at `width: var(--tw)`; nothing else sets that width, so the fill is what holds the bar'],
]);

/** Values that mean "no visual change from the element's own resting style". */
const RESTING = /^(none|0|1|100%|translatey\(0(px)?\)|translatex\(0(px)?\)|scale\(1\)|scaley\(1\)|scalex\(1\)|rotate\(0(deg)?\)|visible)$/;

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Does this @keyframes block end on nothing but resting values? A multi-value
 * transform (`translateY(0) scale(1)`) counts as resting only if EVERY function
 * in it does.
 */
function endsAtRest(body: string): boolean {
  const final = body.match(/(?:^|[}\s])(?:to|100%)\s*\{([^}]*)\}/i);
  if (!final) return false;
  const decls = final[1]
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  if (!decls.length) return false;
  return decls.every((decl) => {
    const [prop, ...rest] = decl.split(':');
    const value = rest.join(':').trim().toLowerCase();
    if (prop.trim().toLowerCase() === 'transform') {
      const parts = value.match(/[a-z]+\([^)]*\)/g);
      if (!parts) return RESTING.test(value);
      return parts.every((p) => RESTING.test(p));
    }
    return RESTING.test(value);
  });
}

describe('animation fill-mode: a resting end state must not fill forwards', () => {
  const files = [...walk(join(SRC_DIR, 'styles'), ['.css']), ...walk(SRC_DIR, ['.astro'])];

  it('finds the stylesheets it is meant to guard', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no forwards/both fill on an animation that ends at the resting state', () => {
    // Collect every @keyframes in the tree first — an animation is often declared
    // in one file (tokens.css @theme) and its keyframes read from another.
    const keyframes = new Map<string, boolean>();
    const sources = files.map((f) => ({ rel: relative(SRC_DIR, f), text: stripComments(readFileSync(f, 'utf8')) }));
    for (const { text } of sources) {
      for (const m of text.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}/g)) {
        keyframes.set(m[1], endsAtRest(m[2]));
      }
    }
    expect(keyframes.size, 'no @keyframes found — the scanner regex has drifted').toBeGreaterThan(10);

    const findings: string[] = [];
    for (const { rel, text } of sources) {
      text.split('\n').forEach((line, i) => {
        const decl = line.match(/(?:animation|--animate-[\w-]+)\s*:\s*([^;]+)/);
        if (!decl) return;
        const value = decl[1];
        if (!/\b(forwards|both)\b/.test(value)) return;
        const name = [...keyframes.keys()].find((k) => new RegExp(`(^|[\\s:])${k}([\\s,]|$)`).test(value));
        if (!name) return; // shorthand we can't resolve to a known keyframe
        if (FILL_IS_LOAD_BEARING.has(name)) return;
        if (!keyframes.get(name)) return; // real end state — the fill is doing work
        findings.push(`${rel}:${i + 1} — "${name}" ends at its resting state but fills ${/both/.test(value) ? 'both' : 'forwards'}`);
      });
    }

    expect(
      findings,
      'Use `backwards` instead. A forwards fill on a resting end state changes nothing visually and ' +
        'permanently outranks :hover/:focus and any JS-set style on the same property — that is the ' +
        'homepage card-lift bug. If the fill really is load-bearing, add the animation to ' +
        'FILL_IS_LOAD_BEARING in this file WITH the reason.',
    ).toEqual([]);
  });

  it('the card entrance animations specifically stay non-filling', () => {
    const storeCard = readFileSync(join(SRC_DIR, 'styles/components/store-card.css'), 'utf8');
    const store = readFileSync(join(SRC_DIR, 'styles/pages/store.css'), 'utf8');
    // These two are the ones a hover-lift actually rides on, and the regression
    // that prompted this file. Pinned by name so a future edit has to see them.
    expect(storeCard).toMatch(/\.card-reveal-play\s*\{\s*animation:[^;]*\bbackwards\b/);
    expect(store).toMatch(/\.product-card--entering\s*\{\s*animation:[^;]*\bbackwards\b/);
  });
});
