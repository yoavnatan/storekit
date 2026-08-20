import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The reaper decides correctly which running test process is a ghost.
 *
 * ── Why this exists (owner, 2026-08-21) ──
 * A session merged, removed its worktree, and left its own `npm run verify` running inside it. The
 * directory went; the process did not. It held two of the machine's four test workers for 24
 * minutes, verifying a tree that no longer existed, and every other session's suite crawled behind
 * it — a six-minute run took an hour. *"אי אפשר כל לילה לעבור את אותו הסיפור"*.
 *
 * ── Why it tests a FUNCTION and not a process ──
 * The first version of this test spawned two fake `vitest` binaries, deleted one's directory, and
 * asserted which survived. It reported a failure the hook did not have — twice — because this
 * sandbox kills any process named `vitest` that `npm run verify` did not start. The test was
 * measuring the sandbox. `orphan_worktree_of` takes an argv string and returns a verdict, so the
 * whole decision is checkable with no processes at all.
 *
 * ── The bug it caught, which is the reason it is worth having ──
 * The first extraction was a sed capture that began with a greedy wildcard before the worktrees
 * path. Greedy means it started the capture at the LAST `/` it could, so what came back was a path
 * FRAGMENT rather than the path — and a fragment is never a directory that exists, so every live
 * run looked like a ghost and the hook would have killed working sessions across the machine.
 * Caught before it ever ran for real. (The regex is described rather than quoted here on purpose:
 * a wildcard followed by a slash closes a JSDoc block, which cost a run of its own to notice.)
 */

const HOOK = path.join(process.cwd(), '.claude/hooks/reap-orphan-verify.sh');

/**
 * Ask the hook's own decision function about one argv line. Empty string = "leave it alone".
 *
 * `/bin/bash` by absolute path, not `bash` — resolving a binary through `PATH` is what
 * `sonarjs/no-os-command-from-path` refuses, and it is right to: a writable directory earlier in
 * `PATH` decides which program a test runs. On macOS this path is fixed.
 */
function verdict(argv: string): string {
  return execFileSync('/bin/bash', [
    '-c',
    `REAP_DECIDE_ONLY=1 source ${JSON.stringify(HOOK)}; orphan_worktree_of ${JSON.stringify(argv)}`,
  ], { encoding: 'utf8' }).trim();
}

describe('the orphan reaper', () => {
  it('is wired into the hook it claims to be', () => {
    expect(fs.existsSync(HOOK)).toBe(true);
    const settings = fs.readFileSync(path.join(process.cwd(), '.claude/settings.json'), 'utf8');
    expect(settings).toContain('reap-orphan-verify.sh');
  });

  it('names the worktree of a run whose directory is gone', () => {
    const gone = path.join(os.tmpdir(), 'not-a-real-dir-8f2a', '.claude/worktrees/ghost');
    expect(fs.existsSync(gone)).toBe(false);
    expect(verdict(`node ${gone}/node_modules/.bin/vitest run --maxWorkers 4`)).toBe(gone);
  });

  /** The one that matters: a slow neighbour is a legitimate neighbour. */
  it('leaves a run alone while its worktree still exists', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-'));
    const live = path.join(base, '.claude/worktrees/alive');
    fs.mkdirSync(path.join(live, 'node_modules/.bin'), { recursive: true });
    try {
      expect(verdict(`node ${live}/node_modules/.bin/vitest run --maxWorkers 4`)).toBe('');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  /** The greedy-regex bug, pinned by shape: a verdict must be a path that starts at the root. */
  it('returns a whole path, never a fragment of one', () => {
    const gone = path.join(os.tmpdir(), 'deep-8f2a', 'a', 'b', '.claude/worktrees/ghost');
    const said = verdict(`node ${gone}/node_modules/.bin/vitest run`);
    expect(said).toBe(gone);
    expect(said.startsWith(os.tmpdir()), `"${said}" is a fragment, not the path`).toBe(true);
  });

  it('ignores a run in the MAIN checkout, which is nobody\'s ghost', () => {
    expect(verdict('node /repo/node_modules/.bin/vitest run')).toBe('');
  });

  it('ignores processes that are not a test run at all', () => {
    expect(verdict('node /x/.claude/worktrees/ghost/node_modules/.bin/astro dev')).toBe('');
    expect(verdict('vim notes.txt')).toBe('');
  });

  /** This repo lives under "תיק עבודות/porject 2" — every path here has spaces AND Hebrew in it. */
  it('handles a path with spaces and Hebrew, which is the only kind this repo has', () => {
    const gone = '/Users/x/Desktop/תיק עבודות/porject 2/.claude/worktrees/ghost';
    expect(verdict(`node ${gone}/node_modules/.bin/vitest run --maxWorkers 4`)).toBe(gone);
  });
});
