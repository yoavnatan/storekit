import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ═══ A TEST THAT SHELLS OUT TO GIT MUST SAY WHICH REPOSITORY IT MEANS ═══
 *
 * ── The incident, 2026-08-17 ──
 *
 * A `git push` produced a commit nobody wrote: 1,060 files and 212,797 lines deleted, message
 * "seed", author `t <t@t>`, sitting on the branch that happened to be checked out. The repository
 * had also quietly become `core.bare=true`. It looked like sabotage for a good ten minutes.
 *
 * It was neither sabotage nor a broken test. **Git exports `GIT_DIR` — and `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE` and several more — into every hook it runs**, and `.githooks/pre-push` runs the
 * whole test suite. So the suite inherited a pointer to the real repository, and those variables
 * BEAT the `cwd` a child process is given. `tests/handoff-backup.test.ts` builds a throwaway repo
 * and runs `git init --bare`, `git add -A` and `git commit -m seed` inside it; under the hook all
 * three addressed the real repository instead. `init --bare` set the flag, and `add -A` staged the
 * deletion of everything the fixture's tiny tree did not contain.
 *
 * Every part was individually correct. The join was invisible, it only exists while pushing, and it
 * cannot be reproduced by running the suite normally — which is exactly the kind of thing that
 * survives review and costs an evening.
 *
 * ── What this guard actually asserts ──
 *
 * Not "no test may call git" — several legitimately must. The rule is that a test which spawns git
 * has to hand it an explicit `env`, because inheriting the parent's is the bug. The hook strips the
 * variables too (that is the real fix, applied once rather than per test); this is the layer that
 * fails on the DAY a new test forgets, instead of the next time somebody pushes.
 */

const TESTS = path.join(process.cwd(), 'tests');

/** Source with comments stripped — git named in a comment is documentation, not a spawn. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const FILES = fs.readdirSync(TESTS)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(TESTS, f));

describe('a test that spawns git says which repository it means', () => {
  it('every git spawn passes an explicit env', () => {
    for (const file of FILES) {
      const src = code(file);
      // Only the calls that actually run git. `execFileSync('git', …)` / `spawnSync('git', …)`,
      // matched with their options object so the assertion can look inside it.
      const spawns = [...src.matchAll(/(?:execFileSync|execSync|spawnSync|execFile|spawn)\(\s*'git'[\s\S]{0,600}?\)\s*[;.]/g)];
      for (const [call] of spawns) {
        expect(
          /\benv\s*:/.test(call),
          `${path.basename(file)}: this git call inherits the parent environment.\n`
          + '  Under `git push` the pre-push hook runs the suite with GIT_DIR set, and GIT_DIR beats cwd —\n'
          + '  so the command acts on the REAL repository. Pass env: cleanGitEnv() (tests/handoff-backup.test.ts).\n'
          + `  ${call.split('\n')[0]!.trim()}`,
        ).toBe(true);
      }
    }
  });

  it('the pre-push hook strips the git environment before running the suite', () => {
    // The primary fix, pinned where it is easy to delete by accident: the hook runs `npm run verify`
    // as a child of git, and every test in that run inherits whatever it does not clear.
    const hook = fs.readFileSync(path.join(process.cwd(), '.githooks', 'pre-push'), 'utf8');
    const unsetLines = hook.split('\n').filter((l) => /^\s*unset .*GIT_DIR/.test(l));
    expect(unsetLines.length, '.githooks/pre-push must `unset GIT_DIR …` before it runs anything').toBeGreaterThan(0);

    // The verify run specifically — the memory-backup block above it already had its own unset,
    // which is precisely why nobody noticed the test run below it did not.
    const verifyAt = hook.indexOf('npm run --silent verify');
    expect(verifyAt).toBeGreaterThan(-1);
    const before = hook.slice(0, verifyAt);
    expect(
      /unset [^\n]*GIT_DIR[^\n]*\n(?:[^\n]*\n){0,40}?[^\n]*npm run --silent verify/.test(hook)
      || /unset [^\n]*GIT_DIR/.test(before.slice(-2000)),
      'the unset must come BEFORE the verify run, not only in the memory-backup block',
    ).toBe(true);
  });
});
