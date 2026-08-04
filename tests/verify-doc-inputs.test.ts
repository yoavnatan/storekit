/**
 * Every markdown file a test READS must count towards `verify.mjs`'s cache fingerprint.
 *
 * The hole this closes, found 2026-08-04 while editing AI_INSTRUCTIONS.md. `verify.mjs` skips a
 * check whose inputs are byte-identical to the last time it passed, and its fingerprint deliberately
 * ignores `.md` — "no check reads them", which was true when it was written and stopped being true
 * the moment `instructions-integrity.test.ts` and `instructions-budget.test.ts` started asserting
 * against AI_INSTRUCTIONS.md. A docs-only edit then left the fingerprint unchanged, so
 * `npm run verify -- --all` printed green from cache without running the two tests that could have
 * gone red. Reproduced deliberately before the fix: edit the doc after a green run, and every check
 * reports "unchanged since it last passed".
 *
 * That is the one failure mode the cache is not allowed to have — it is built on "identical inputs,
 * identical result", and a file assumed to be input to nothing had quietly become input.
 *
 * So this is the guard on the assumption rather than on the one file: if a future test reads a
 * different `.md`, the exclusion is wrong again in exactly the same silent way, and this fails
 * naming it. The fix is always a one-word addition to `CHECKED_DOCS` in `scripts/verify.mjs` —
 * which costs that doc's edits a full suite run, and is the price of the tests being real.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TESTS = path.join(ROOT, 'tests');

/** The live regex out of `verify.mjs`, never a copy — a copy is what drifts. */
function checkedDocs(): RegExp {
  const src = readFileSync(path.join(ROOT, 'scripts/verify.mjs'), 'utf8');
  const literal = /^const CHECKED_DOCS = \/(.+)\/;$/m.exec(src);
  if (!literal) throw new Error('scripts/verify.mjs no longer declares `const CHECKED_DOCS = /…/;`');
  return new RegExp(literal[1]);
}

/**
 * Markdown paths passed to a file read. Bounded to what sits INSIDE the call's parentheses, so a
 * `// see DB_MIGRATION_PLAN.md §8` comment on the same line as an unrelated read is not a hit —
 * every doc named in this suite's prose would otherwise look like an input.
 */
const READS = /(?:readFileSync|readFile|new URL)\s*\(([^)]{0,200})\)/g;
const QUOTED_MD = /['"`]([^'"`]+\.md)['"`]/;

function docsReadBy(file: string): string[] {
  const src = readFileSync(path.join(TESTS, file), 'utf8');
  const found = new Set<string>();
  for (const [, inside] of src.matchAll(READS)) {
    const doc = QUOTED_MD.exec(inside);
    if (doc) found.add(path.posix.normalize(doc[1]).replace(/^(?:\.\.\/)+/, ''));
  }
  return [...found];
}

describe('verify.mjs fingerprint vs the docs tests read', () => {
  const files = readdirSync(TESTS).filter((f) => f.endsWith('.test.ts'));

  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('counts every markdown file the suite reads', () => {
    const pattern = checkedDocs();
    const missed = files.flatMap((f) => docsReadBy(f).map((doc) => `${doc}  (read by tests/${f})`))
      .filter((entry) => !pattern.test(entry.split('  ')[0]));

    expect(
      missed,
      'These markdown files decide whether a test passes, but scripts/verify.mjs excludes them from ' +
        'its cache fingerprint — so editing one leaves `verify --all` reporting green from cache ' +
        'without running the test. Add each to CHECKED_DOCS there:\n' +
        missed.join('\n'),
    ).toEqual([]);
  });
});
