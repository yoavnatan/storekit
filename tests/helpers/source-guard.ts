/**
 * A grep-guard that cannot silently stop guarding.
 *
 * **The failure this exists to make impossible.** On 2026-08-25 three separate guard tests were
 * written in one session, all three passed, and all three were **vacuous** — they would have passed
 * with the bug they guarded deliberately put back. Each for a different reason:
 *
 *   1. `consent.test.ts` looked for `--consent-bar-h` inside a CSS block and found it in the
 *      **comment explaining the rule**, so the rule was satisfied by its own documentation.
 *   2. `sticky-cart-bar.test.ts` sliced the file from a marker that sat *after* one of the two
 *      things it asserted about, so two assertions passed on **absence**.
 *   3. `consent.test.ts` again, on a different rule: the slice reached backwards far enough to hit
 *      a *different* element's legitimate `aria-label` and failed on the wrong element.
 *
 * They were caught only because each was re-run with its fix reverted by hand. Nothing in the repo
 * required that, and a guard nobody reverses is a guard nobody has checked. The owner's ruling:
 * *"נשמע נורא, תעשה שתימנע ממנגנון שכזה בעתיד"*.
 *
 * **The mechanism.** A guard declares, beside the rule, a `mustReject` — a scrap of source the rule
 * is supposed to catch. `sourceGuard` runs the rule twice: against the real file, which must be
 * clean, and against `mustReject`, which must NOT be. A rule that accepts its own counter-example
 * fails the test with that stated plainly, so "I proved it can fail" stops being a discipline
 * somebody remembers and becomes the only way to write one.
 *
 * That covers every way a guard goes hollow, not just the comment one: a bad slice, a regex that
 * never matches, a file path that moved, a rule reading the wrong half of a document. All of them
 * show up as "the counter-example was accepted".
 *
 * **Comments are stripped by default** (`raw: true` opts out) — that is trap 1 removed outright
 * rather than left to be remembered, and a block comment is only recognised where one can actually
 * open, after whitespace or `{`. Without that anchor `accept="image/*"` swallows a stylesheet, which
 * is its own worked case in `accessibility-guards.test.ts`.
 *
 * **Not retrofitted.** 97 test files in this repo make a negative assertion about source text and
 * predate this helper; sweeping them was judged a project rather than a fix, and none is known to
 * be vacuous. What this changes is that a NEW guard cannot be. The review checklist carries the
 * rule for anything written from here.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');

/**
 * Source text with comments removed — JSX, HTML, block and line.
 *
 * The block-comment pattern is anchored to whitespace or a brace on purpose: a comment opener also
 * appears inside ordinary attribute values — `accept="image/[star]"`, a `url(...)` — and an
 * unanchored strip eats from there to the next comment TERMINATOR, which can be a thousand lines
 * away inside an unrelated stylesheet. (Spelled `[star]` here for the same reason the anchor
 * exists: a literal opener or terminator inside this comment would end it early, which is the
 * parse error this line caused on its first draft.)
 */
export function stripComments(text: string): string {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1 ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** Repo-relative source, comments out unless `raw`. */
export function readSource(relPath: string, { raw = false } = {}): string {
  const text = readFileSync(join(REPO, relPath), 'utf8');
  return raw ? text : stripComments(text);
}

export interface SourceGuard {
  /** Repo-relative file the rule is about. */
  file: string;
  /** What the rule is, in words — used in the failure message a future reader will see. */
  rule: string;
  /**
   * Returns the offending fragments in `text`. Empty means "this source obeys the rule".
   *
   * Keep it total: it is handed the real file AND the counter-example below, and it must not throw
   * on either.
   */
  find: (text: string) => string[];
  /**
   * A scrap of source that BREAKS the rule — usually the bug itself, spelled out.
   *
   * This is the whole point of the helper. If `find` returns nothing for it, the rule is not
   * enforcing anything and the test fails saying so, instead of passing and protecting nothing.
   */
  mustReject: string;
  /** Read the file with comments intact. Only for a rule that is genuinely ABOUT the comments. */
  raw?: boolean;
}

/**
 * Assert a source file obeys a rule, and — in the same breath — that the rule can actually fail.
 *
 * ```ts
 * sourceGuard({
 *   file: 'src/styles/pages/product.css',
 *   rule: 'a fixed element on the bottom edge clears the cookie notice',
 *   find: (css) => [...css.matchAll(/bottom:\s*0(px)?;/g)].map((m) => m[0]),
 *   mustReject: '#bar { position: fixed; bottom: 0; }',
 * });
 * ```
 */
export function sourceGuard(guard: SourceGuard): string[] {
  const { file, rule, find, mustReject, raw = false } = guard;

  // The counter-example FIRST. If the rule is hollow, say that rather than reporting a clean file —
  // "the source passes" is exactly the reassuring, wrong answer this helper exists to prevent.
  const proof = find(raw ? mustReject : stripComments(mustReject));
  expect(
    proof.length,
    `The guard for "${rule}" (${file}) does not reject its own counter-example, so it is not `
    + 'guarding anything. Fix the rule, not the counter-example.',
  ).toBeGreaterThan(0);

  const offenders = find(readSource(file, { raw }));
  expect(offenders, `${file} breaks the rule: ${rule}`).toEqual([]);
  // Returned as well as asserted, so a call site can end in its own `expect(...).toEqual([])`.
  // That is not ceremony: SonarJS counts assertions per TEST BODY, and a test whose only assertion
  // lives inside a helper reads to the linter — and to a person skimming — as a test that asserts
  // nothing. Given what this file exists to prevent, that is the last impression it should give.
  return offenders;
}
