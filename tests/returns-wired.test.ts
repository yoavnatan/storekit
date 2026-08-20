import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NON_RETURNABLE_SUBJECTS } from '../src/lib/return-eligibility.js';

/**
 * Nothing in the returns feature may be written and left uncalled.
 *
 * ── Why this test exists, and it is a real failure's headstone ──
 * `notifySellerReturnDeadline` was written, reviewed, described in a summary as built, and wired to
 * nothing. A seller therefore got NO warning before a request closed against him — and every report
 * of the work said the warning existed. The owner's answer was "נורא, תבדוק שאין עוד כאלו".
 *
 * Dead code that looks like a feature is worse than a missing feature: a gap gets noticed the first
 * time somebody needs it, while an uncalled function is invisible from every direction except this
 * one. `astro check` cannot see it (an export is legitimately unused until someone imports it), lint
 * cannot (it is exported), and a review reads the function and finds it correct — which it is.
 *
 * So the check is mechanical: every export of every returns module must be named somewhere outside
 * its own file. A helper that genuinely has no caller yet should not be exported at all.
 */

const MODULES = [
  'src/lib/returns.ts',
  'src/lib/return-requests.ts',
  'src/lib/return-notify.ts',
  'src/lib/return-rate.ts',
  'src/lib/return-eligibility.ts',
  'src/lib/return-eligibility-order.ts',
  'src/lib/returns-run.ts',
];

/** Everything that could reference an export: source, pages, scripts, and the tests themselves. */
function allSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|astro|mjs)$/.test(entry.name)) out.set(rel, fs.readFileSync(rel, 'utf8'));
    }
  };
  ['src', 'tests', 'scripts'].forEach(walk);
  return out;
}

describe('the returns feature has no code nothing calls', () => {
  const sources = allSources();

  it('every export is referenced outside its own file', () => {
    const orphans: string[] = [];
    for (const file of MODULES) {
      if (!fs.existsSync(file)) { orphans.push(`${file} is gone — the list above is stale`); continue; }
      const src = fs.readFileSync(file, 'utf8');
      const names = [
        ...[...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!),
        ...[...src.matchAll(/^export const (\w+)\s*[:=]/gm)].map((m) => m[1]!),
      ];
      for (const name of names) {
        const used = [...sources.entries()].some(([p, text]) =>
          p !== file && new RegExp(`\\b${name}\\b`).test(text));
        if (!used) orphans.push(`${name} (${file})`);
      }
    }
    expect(
      orphans,
      'These are exported and nothing outside their own file names them. Either wire them up or stop\n'
      + 'exporting them — a function that looks built and runs never is the failure this test exists for.',
    ).toEqual([]);
  });

  it('scans the modules it claims to', () => {
    // If the list above rots, the test above passes by scanning nothing.
    expect(MODULES.every((m) => fs.existsSync(m))).toBe(true);
    expect(sources.size).toBeGreaterThan(100);
  });
});

/**
 * The published policy must name every exclusion the code enforces.
 *
 * These are two halves of one promise: `return-eligibility.ts` decides which shelves lose the return
 * right, and `/returns-policy` is where a buyer reads that BEFORE buying. A term added to the code
 * and not to the page is a right removed in silence — and the page is the only place a buyer could
 * have found out.
 */
describe('the policy page names every exclusion the code enforces', () => {
  it('mentions each non-returnable term', () => {
    const page = fs.readFileSync('src/pages/returns-policy.astro', 'utf8');
    // Compared against the SUBJECTS, never the matcher's spelling variants: the page says "מזון",
    // the matcher also carries "מאכל", and asking the page to contain a matcher is asking it to be
    // written for a regex rather than for a person.
    const missing = NON_RETURNABLE_SUBJECTS
      .filter(({ subject }) => !page.includes(subject.split(' ')[0]!))
      .map(({ subject }) => subject);
    expect(
      missing,
      'The code refuses returns on these and the policy page never mentions them. A buyer cannot\n'
      + 'find out before buying, which is the one moment the notice exists for.',
    ).toEqual([]);
  });
});

/**
 * The four reasons have ONE set of words, and it lives in `lib/returns.ts`.
 *
 * ── The bug this is the headstone for (owner, 2026-08-20) ──
 * `changed_mind` / `damaged` / `wrong_item` / `not_arrived` are database values. Two panels — the
 * seller's card and the admin's queue — each carried their own private map turning them into Hebrew,
 * identical to each other and invisible to anybody adding a THIRD reader. The third reader was the
 * money journal, and it did what a file with no map in it does: it wrote the raw code. An owner
 * reading his own money log saw `סיבה: changed_mind` in the middle of a Hebrew sentence, on the one
 * screen whose entire job is to be believed.
 *
 * Two identical copies are not a bug yet, which is exactly why nobody fixed them. The bug is the
 * shape: a rule with no single home is a rule the next caller cannot find.
 *
 * Grepped by SHAPE — a file that maps `changed_mind` to a string — rather than by the constant's
 * name, because a second copy will never be called `RETURN_REASON_LABELS`.
 */
describe('the return reasons are spelled out in exactly one place', () => {
  it('no file outside lib/returns.ts maps a reason code to its own words', () => {
    const owner = 'src/lib/returns.ts';
    const offenders = [...allSources()]
      .filter(([file]) => file !== owner && !file.startsWith('tests'))
      // `changed_mind:` as an object KEY with a value after it. A file naming the code in a
      // comparison (`reason === 'changed_mind'`) is reading the vocabulary, not redefining it.
      .filter(([, src]) => /\bchanged_mind\s*:\s*['"`]/.test(src))
      .map(([file]) => file);

    expect(
      offenders,
      'These build their own map of the return reasons. Import RETURN_REASON_LABELS from\n'
      + 'lib/returns.ts instead — a second copy is how the money journal came to print a raw\n'
      + 'database value at a person.',
    ).toEqual([]);
  });
});
