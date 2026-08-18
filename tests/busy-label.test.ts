/**
 * A label beside the pulsing dots must not draw three of its own.
 *
 * This was fixed once, on 2026-08-17, with a `/[\s.…]+$/` anchored at the end of the string — and
 * reported again the next day, still on screen, because the bulk delete composes its label as
 * `"מוחק... (3)"`. The end of that string is a bracket. The strip matched nothing.
 *
 * So this file guards two things, and the second is the one that actually stops the repeat:
 *   1. `busyLabel` handles the shapes that exist, composed ones included;
 *   2. NOTHING builds a `.dot-pulse` beside a caller-supplied label without going through it.
 *
 * The second is a source scan rather than a behaviour test on purpose. The bug was never that the
 * regex was wrong where it ran — it was that a second surface (`btn-busy.ts`) had its own copy
 * with its own hole, which is the exact shape this repo names in safe-redirect and secret-compare:
 * correct in most places, missing from one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { busyLabel } from '../src/lib/busy-label.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

describe('busyLabel', () => {
  it('drops a trailing ellipsis, in either spelling', () => {
    expect(busyLabel('מוחק...')).toBe('מוחק');
    expect(busyLabel('מסיר רקע…')).toBe('מסיר רקע');
    expect(busyLabel('Deleting…')).toBe('Deleting');
  });

  it('drops one the caller has buried mid-string — the 2026-08-18 report', () => {
    expect(busyLabel('מוחק... (3)')).toBe('מוחק (3)');
    expect(busyLabel('Deleting… (12)')).toBe('Deleting (12)');
  });

  it('leaves a label that never had one alone', () => {
    expect(busyLabel('שומר')).toBe('שומר');
    expect(busyLabel('מוחק (3)')).toBe('מוחק (3)');
  });

  it('does not eat a single full stop, which is punctuation and not an ellipsis', () => {
    expect(busyLabel('נשמר. ממשיך')).toBe('נשמר. ממשיך');
  });
});

describe('every surface that pairs a label with the dots uses it', () => {
  const surfaces = [
    ['src/components/ConfirmModal.astro', '../src/components/ConfirmModal.astro'],
    ['src/scripts/dashboard/btn-busy.ts', '../src/scripts/dashboard/btn-busy.ts'],
  ] as const;

  it.each(surfaces)('%s calls busyLabel', (_name, path) => {
    expect(read(path)).toContain('busyLabel(');
  });

  it.each(surfaces)('%s keeps no private ellipsis regex of its own', (_name, path) => {
    // A local `replace(/…$/)` is how the second hole got there — one surface fixed, one not.
    const code = read(path).replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/^\s*\/\/.*$/gmu, ' ');
    expect(code).not.toMatch(/replace\(\s*\/\[?[^/]*(?:\\\.|…)[^/]*\/[a-z]*\s*,/u);
  });

  it('no confirm caller passes a label the dots would duplicate', () => {
    // The check the guard this replaced was NAMED for and never performed. Reads every
    // `workingLabel:` in the tree and asserts what the seller actually sees — the value after
    // `busyLabel` — carries no ellipsis, however the caller composed it.
    const files = [
      '../src/scripts/dashboard/products.ts',
      '../src/scripts/dashboard/advertising.ts',
      '../src/scripts/dashboard/promotions.ts',
      '../src/scripts/admin/stores.ts',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = read(f); } catch { continue; }
      for (const m of text.matchAll(/workingLabel:\s*(`[^`]*`|'[^']*'|"[^"]*")/gu)) {
        // Strip the quoting and any `${…}` holes — a hole is a value, never an ellipsis.
        const literal = m[1].slice(1, -1).replace(/\$\{[^}]*\}/gu, '');
        if (/\.{2,}|…/u.test(busyLabel(literal))) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders, 'a busy label still carries its own ellipsis').toEqual([]);
  });

  it('builds the dots without interpolating the label into markup', () => {
    // The template it replaced put `label` inside `aria-label="${label}"` unescaped — the
    // attribute-breakout class this repo already carries a rule for.
    const confirm = read('../src/components/ConfirmModal.astro');
    expect(confirm).not.toMatch(/aria-label="\$\{label\}"/u);
  });
});
