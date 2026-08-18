import { tmpdir } from 'node:os';

/**
 * `process.env` with every inherited git pointer removed — what any test spawning `git` must pass.
 *
 * ── Why this exists (2026-08-17) ──
 *
 * Git exports `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and several more into every hook it runs,
 * and `.githooks/pre-push` runs the whole test suite. **Those variables beat the `cwd` you hand a
 * child process**, so under a `git push` a test operating on its own throwaway repository was in fact
 * addressing the real one: `git init --bare` set `core.bare=true` on it, and `git add -A` +
 * `git commit -m seed` put a 1,060-file deletion on the checked-out branch, signed with the fixture's
 * `t <t@t>` identity. It read like sabotage; it was a push.
 *
 * The hook strips them now, which is the fix that matters — applied once, where the environment is
 * actually created, rather than in each test that might inherit it. This is the second layer, so a
 * test is safe even when its caller forgets, and `tests/git-env-isolation.test.ts` is the third: it
 * fails on the day a new test spawns git without an explicit env, rather than the next time somebody
 * pushes.
 *
 * `GIT_CEILING_DIRECTORIES` is the belt to that braces: if an `init` in a temp directory ever fails
 * quietly, git will not walk UP the filesystem looking for a repository to use instead.
 */
const INHERITED_GIT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_EXEC_PATH_OVERRIDE',
] as const;

export function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of INHERITED_GIT_VARS) delete env[key];
  env.GIT_CEILING_DIRECTORIES = tmpdir();
  return env;
}
