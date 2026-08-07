/**
 * The word "קניון" is retired from everything a person or a crawler reads.
 *
 * **Why a guard rather than a wording pass.** The 2026-08-07 pass replaced it across ~15 UI strings
 * and wrote the rule into AI_INSTRUCTIONS.md ("never קניון"), and it still shipped in the single
 * most quoted sentence on the site: `store.config.ts#description`, which is the Organization JSON-LD
 * `description`, the default meta description, the OG description and the opening line of
 * `/llms.txt` — the sentence an AI answer engine repeats when asked what Dezabin is. It survived for
 * one reason: the pass ran over `translations.ts`, and that string does not live there. Nothing in
 * the diff was wrong; the sweep just had a shorter reach than the rule.
 *
 * That is the class this holds — a retired word surviving in the surfaces that sit OUTSIDE the
 * translations file (a config default, an aria-label written inline, a fallback `?? 'טקסט'`).
 *
 * **The rule:** a line carrying the word passes only if it is a comment. Explaining why the word was
 * retired is the one legitimate use, and both current mentions are exactly that — the note above
 * `startSelling` in translations.ts and the pointer in store.config.ts. A code line is a failure
 * whether the word is in a string, an attribute or a class name.
 *
 * Comment-shaped lines are matched rather than comments stripped, on purpose: stripping from `//`
 * would swallow the rest of a line holding `'https://…'`, and a retired word after a URL on that
 * line would pass unseen. Matching the line's own shape cannot fail in that direction.
 *
 * Sits alongside the other "one rule, and here is the test that says so" guards: `outbound-fetch`,
 * `safe-redirect`, `money-guards`, `image-optimization`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** Retired word → what replaced it, named in the failure so the fix does not need a search. */
const RETIRED: Array<{ word: string; use: string; why: string }> = [
  {
    word: 'קניון',
    use: 'מתחם / מתחם חנויות דיגיטלי',
    why: 'a mall is a comparison the platform loses; "מתחם" names the place without the metaphor (translations.ts → startSelling)',
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|astro|js|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/** `//`, `/* …`, a block comment's `*` continuation, JSX/Astro `{/* …`, or HTML `<!-- …`. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('{/*') || t.startsWith('<!--');
}

describe('retired words never reach a reader', () => {
  for (const { word, use, why } of RETIRED) {
    it(`"${word}" appears only where a comment explains why it was retired`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(SRC)) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (line.includes(word) && !isCommentLine(line)) {
            offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 120)}`);
          }
        });
      }
      expect(
        offenders,
        `"${word}" is retired — use "${use}" instead (${why}). Still on a code line:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }
});
