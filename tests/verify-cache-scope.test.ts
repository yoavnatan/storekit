/**
 * `verify.mjs`'s "already passed" markers must live MACHINE-WIDE, and must be keyed by the
 * installed dependency tree as well as by the content.
 *
 * The waste this closes, measured 2026-08-19. A marker records "these checks passed against this
 * exact content" — a statement about the content, not about the directory the content sits in. The
 * markers lived under each checkout's `node_modules/.cache`, so a worktree that verified green,
 * rebased and fast-forwarded into main handed `pre-push` a tree it had *just* proved, and pre-push
 * ran the whole suite again from scratch because main had never seen that hash. With several
 * sessions live those runs also queue behind each other on the machine-wide test lock
 * (`scripts/lib/test-lock.mjs`), so the duplicate is not merely wasteful, it is the thing that
 * turns a checkpoint into ten minutes of waiting. The owner hit exactly that.
 *
 * Why this needs a test at all: reverting it breaks NOTHING. Every check still runs, every answer
 * is still right, main still cannot go red — the only symptom is that the session is slow again,
 * which is invisible in any output and is precisely what nobody notices in review. So the guard is
 * on the two properties that make sharing both possible and safe:
 *
 *   • the marker is resolved from `tmpdir()`, never from the checkout — otherwise no two checkouts
 *     can ever see each other's green;
 *   • the key carries `installHash()` — the tree hash covers `package-lock.json` (what SHOULD be
 *     installed) and can say nothing about what IS. A half-finished `npm ci` in one checkout must
 *     not be able to inherit another's green, and keying on npm's own
 *     `node_modules/.package-lock.json` means checkouts share only when their installs match.
 *
 * Read out of the real source rather than restated, so this cannot pass against a copy of the rule.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = readFileSync(path.join(ROOT, 'scripts/verify.mjs'), 'utf8');

/** The one declaration line, whitespace-normalised. Fails loudly if it is renamed away. */
function declaration(name: string): string {
  const line = SOURCE.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0];
  expect(line, `scripts/verify.mjs no longer declares \`${name}\``).toBeTruthy();
  return line!.replace(/\s+/g, ' ');
}

describe('the verify cache is shared across checkouts', () => {
  it('puts the state directory outside the checkout', () => {
    const state = declaration('STATE');
    expect(state, 'STATE must come from tmpdir() — a path under the checkout cannot be shared')
      .toMatch(/tmpdir\(\)/);
    // ROOT is the checkout. Anything derived from it is per-checkout by construction.
    expect(state, 'STATE must not be resolved from the checkout root').not.toMatch(/\bROOT\b/);
    expect(state, 'STATE must not live in node_modules — a fresh install wipes it')
      .not.toMatch(/node_modules|\bCACHE\b/);
  });

  it('keys the marker by the content hash AND the installed dependencies', () => {
    const marker = declaration('MARKER');
    expect(marker, 'the marker must live in the shared STATE directory').toMatch(/\bSTATE\b/);
    expect(marker, 'the marker must still be keyed by the tree content hash').toMatch(/\bHASH\b/);
    expect(marker, 'the marker must be keyed by the installed tree too, or a broken install inherits a green')
      .toMatch(/installHash\(\)/);
  });

  it('derives the install hash from what npm actually laid down, not from the lockfile', () => {
    // `package-lock.json` is already inside the tree hash. Hashing it again here would add a key
    // component that is always identical when the tree hash is, i.e. no protection at all.
    const fn = SOURCE.match(/function installHash\(\)[\s\S]*?\n}/)?.[0];
    expect(fn, 'installHash() is gone').toBeTruthy();
    expect(fn!).toMatch(/node_modules\/\.package-lock\.json/);
    // A checkout with no install must get its own bucket rather than falling back to a shared one.
    expect(fn!, 'a missing install must not silently share another checkout’s marker')
      .toMatch(/catch[\s\S]*return '[^']+'/);
  });
});
