import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One focus treatment for every text field on the site: **the border takes `--color-primary`,
 * and nothing else happens.** No ring, in any focus mode — a text field matches `:focus-visible`
 * even when focused by POINTER, so a "keyboard-only" ring in fact boxes every field on every
 * click. That was tried on 2026-08-02 and rejected on sight by the user: "צריך רק קו עדין".
 *
 * The user spotted it from the outside (2026-08-02): the buyer dashboard's order search
 * focused differently from the header's. Behind that were SEVEN answers to the same
 * question — an outline ring on `.input`, a grey 8% halo on `.o-search-input`, a black
 * border on the reply textarea, a muted border on the store's local search, an accent
 * border on the profile fields, the brand border on the seller toolbars, and the header's.
 * None was wrong on its own; together they meant "focused" looked like a different thing
 * on every screen.
 *
 * Two things are checked, and both are about drift rather than taste:
 *  1. a field's `:focus` border colour is the brand one, never a second hand-picked colour;
 *  2. a field's `:focus` draws no ring at all — neither a shadow (elevation is not the language
 *     for "you are typing here", and a colourless halo reads as fogged) nor an outline.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** A selector naming a text field, which is what this rule governs. */
const FIELD = /(input|search|textarea|field|\.prof-|\.eom-)/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(css|astro)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = walk(SRC_DIR).map((f) => [relative(SRC_DIR, f), readFileSync(f, 'utf8')] as const);

describe('every text field focuses the same way', () => {
  it('scans a real number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('a field :focus border is always --color-primary', () => {
    const offenders: string[] = [];
    for (const [file, text] of files) {
      text.split('\n').forEach((line, i) => {
        const m = /([^{]*):focus(?:-within)?\s*(?:,[^{]*)?\{[^}]*border-color:\s*var\(--color-([a-z-]+)\)/.exec(line);
        if (!m || !FIELD.test(m[1] ?? '')) return;
        if (m[2] !== 'primary') offenders.push(`${file}:${i + 1} — --color-${m[2]}`);
      });
    }
    expect(offenders, 'Use var(--color-primary); the shared rule is in styles/components/forms.css.').toEqual([]);
  });

  it('a field :focus draws no ring — no shadow, no outline', () => {
    const offenders: string[] = [];
    for (const [file, text] of files) {
      text.split('\n').forEach((line, i) => {
        if (!/:focus\s*(?:,[^{]*)?\{/.test(line) || /:focus-visible|:focus-within/.test(line)) return;
        const selector = line.slice(0, line.indexOf(':focus'));
        if (!FIELD.test(selector)) return;
        if (/box-shadow:\s*(?!none)/.test(line) || /outline:\s*(?!none)/.test(line)) {
          offenders.push(`${file}:${i + 1} — ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders, 'Focus on a text field is a border-colour change and nothing else.').toEqual([]);
  });
});
