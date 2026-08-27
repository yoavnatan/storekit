/**
 * A toast must never land on a bar that is already at the bottom of the screen.
 *
 * On a phone the toast container is `left:1rem; right:1rem; bottom:1.5rem` — exactly where the
 * dashboard's floating notices sit — and it carries the higher z-index, so it covered them
 * completely (owner, 2026-08-20: *"מה קורה אם נכנסת הודעת טוסט בזמן שזה מופיע? זה פשוט דורס את
 * זה?"* — it did, and it was measured before it was fixed). `ToastContainer` already lifted itself
 * above two other bottom surfaces by naming their selectors; the fix was to make that a DECLARED
 * contract instead, so the next bar to be added is covered by carrying the attribute rather than by
 * somebody remembering to extend a list.
 *
 * A source scan rather than a DOM test on purpose: what has to hold is that every fixed bottom bar
 * declares itself, and that is a statement about the whole tree, not about one render.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceGuard } from './helpers/source-guard.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.astro')) acc.push(full);
  }
  return acc;
}

describe('a fixed bottom bar declares itself so the toast can clear it', () => {
  it('the toast reads the declaration, not a list of component names', () => {
    const toast = readFileSync(join(SRC, 'components/ToastContainer.astro'), 'utf8');
    expect(toast).toContain('[data-bottom-bar]');
    // Measured by HEIGHT, so a bar put away with a display utility contributes nothing and this
    // file never has to know how any of them is toggled.
    expect(toast).toMatch(/data-bottom-bar[\s\S]{0,400}height > 0/);
  });

  it('every fixed bar pinned to the bottom carries it', () => {
    // The shape being caught: `fixed` and `bottom-<n>` in one class list. A bar at the bottom edge
    // of the viewport is, by construction, in the toast's landing zone on a phone.
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/class="[^"]*\bfixed\b[^"]*\bbottom-\d/.test(line)) continue;
        if (line.includes('data-bottom-bar')) continue;
        missing.push(`${file.replace(SRC, '')}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(
      missing,
      'A fixed bar at the bottom edge shares the toast\'s corner on a phone. Add `data-bottom-bar` '
      + 'on the same line as its class so the toast lifts above it, or move the bar off the bottom.',
    ).toEqual([]);
  });

  it('the products bulk bar clears the cookie notice', () => {
    /* The same collision, one layer down and with the loser reversed. The cookie notice is
       `fixed bottom-0` at z-60; `.bulk-bar` is z-45 — so a seller who had not dismissed the notice
       selected products and got the strip of actions UNDERNEATH a bar of legal text. On screen and
       unreachable (owner, 2026-08-27). Measured at 1440×900 before the fix: the notice occupies
       848–900 and the bar's bottom edge sat at 882, inside it.

       `--consent-bar-h` is published on <html> by `scripts/consent.ts` and cleared on dismissal, so
       the `0px` fallback is not a guess — it is the value for every visitor who has dismissed the
       notice, and the bar returns to its own 1.1rem exactly as before, which is the half of the
       request that is easy to lose ("אם העוגיות לא נמצאות אז שיהיה במקום הרגיל שלו").

       A source guard because the failure is a missing term in one declaration, and a DOM test for
       it needs a seller session, a products tab and an undismissed notice — three states, to assert
       one string. The live drive that found it and the one that confirmed the fix are in the
       commit; this is what stops it coming back. */
    expect(sourceGuard({
      file: 'src/styles/pages/dashboard.css',
      rule: 'the bulk bar offsets itself by the cookie notice height',
      find: (text) => {
        const rule = /\.bulk-bar\s*\{[^}]*\}/.exec(text)?.[0] ?? '';
        const bottom = /bottom:\s*([^;]+);/.exec(rule)?.[1] ?? '';
        return bottom.includes('--consent-bar-h') ? [] : [`bottom: ${bottom.trim() || '(none)'}`];
      },
      mustReject: '.bulk-bar {\n  position: fixed;\n  z-index: 45;\n  bottom: 1.1rem;\n}',
    })).toEqual([]);
  });
});
