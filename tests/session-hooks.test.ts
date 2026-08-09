import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * The two hooks that decide how a session spends its time, tested because nothing else can see them
 * fail — a hook that stops speaking up is silent by definition.
 *
 * `one-session-per-tree.sh` decides whether a session opens a git worktree, which costs ~2.5 minutes
 * of setup plus the merge back. Between 2026-08-04 and 08-09 it answered "yes, another session is
 * live" 34 times out of 34, because it asked whether a PID existed and every VS Code tab left open
 * is a live `claude` process — one of them had been idle for a day and a half. Live now means the
 * session's TRANSCRIPT moved recently, and these cases are the two directions that matter: an idle
 * tab must not cost a worktree, and a session actually working must still be caught.
 *
 * `one-way-to-verify.sh` keeps `npm run verify` the only way the checks run (41 minutes of hand-run
 * `astro check` / `tsc` in the same five days). Its whole risk is over-blocking, so most of these
 * cases are things it must let through.
 */
const HOOKS = resolve(fileURLToPath(new URL('../.claude/hooks', import.meta.url)));

/**
 * Run a hook the way Claude Code does: JSON on stdin, decision (if any) on stdout.
 *
 * `script` is a full path on purpose. one-session-per-tree.sh resolves the repository from its OWN
 * location, not from the cwd — so running the checkout's copy against a temporary repo silently
 * tests the checkout instead (it exits early there, because a linked worktree has nothing to say),
 * and every assertion passes for the wrong reason.
 */
function runHook(script: string, payload: unknown, cwd = HOOKS): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- same reasoning as scripts/verify.mjs: bash/git off PATH is the only portable spelling, and this is a test in a local dev repo
  return execFileSync('bash', [script], { input: JSON.stringify(payload), encoding: 'utf8', cwd }).trim();
}

describe('one-way-to-verify.sh — npm run verify is the only way to run the checks', () => {
  const blocked = ['npx astro check', 'cd sub && npx tsc --noEmit', 'npx vitest run', 'npm test', 'npm run test'];
  const allowed = [
    'npm run verify',
    'npm run verify -- --all',
    'node scripts/verify.mjs --all',
    'npx vitest run tests/money.test.ts', // a single file while iterating is explicitly allowed
    'npm test -- tests/money.test.ts',
    'npx vitest run -t "refund"',
    'npm run lint', // 8s, and the documented way to confirm a phantom cached lint error
    'grep -rn "tsc --noEmit" scripts/',
  ];

  it.each(blocked)('blocks %s', (command) => {
    const out = runHook(resolve(HOOKS, 'one-way-to-verify.sh'), { tool_input: { command } });
    expect(out, `expected a deny for: ${command}`).toContain('"permissionDecision": "deny"');
    expect(out).toContain('npm run verify');
  });

  it.each(allowed)('allows %s', (command) => {
    expect(runHook(resolve(HOOKS, 'one-way-to-verify.sh'), { tool_input: { command } })).toBe('');
  });
});

describe('one-session-per-tree.sh — live means working, not merely running', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'session-hook-'));
  const tree = resolve(tmp, 'tree');
  mkdirSync(resolve(tree, '.claude/hooks'), { recursive: true });
  for (const f of ['one-session-per-tree.sh', 'review-state.sh']) {
    cpSync(resolve(HOOKS, f), resolve(tree, '.claude/hooks', f));
  }
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- as above
  const git = (...args: string[]) => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  // The hook keys its state directory off git's own toplevel — on macOS that resolves /var to
  // /private/var, so deriving it from `tree` instead would silently watch a different directory.
  const root = git('rev-parse', '--show-toplevel');
  // eslint-disable-next-line sonarjs/hashing -- not a security hash: the hooks key their state directory by `shasum` of the tree path, and this has to compute the same name
  const state = resolve('/tmp', `claude-review-state-${createHash('sha1').update(root).digest('hex')}`);
  const sessions = resolve(state, 'sessions');
  const hook = resolve(tree, '.claude/hooks/one-session-per-tree.sh');

  // Stands in for another session's `claude` process: alive for the length of this file, and its
  // liveness is the only thing the hook reads off it.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- as above
  const other = spawn('sleep', ['120'], { stdio: 'ignore' });

  afterAll(() => {
    other.kill();
    rmSync(state, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Register another session: `stampAgo` seconds since its Stop-hook heartbeat, `transcriptAgo`
   * since its transcript was last appended to. Live is the LATER of the two, so both have to be
   * settable — a session mid-command has a stale heartbeat and a moving transcript, and an
   * abandoned tab has neither.
   */
  function register(pid: number, stampAgo: number, transcriptAgo: number | null): void {
    mkdirSync(sessions, { recursive: true });
    const stamp = Math.floor(Date.now() / 1000) - stampAgo;
    if (transcriptAgo === null) {
      writeFileSync(resolve(sessions, String(pid)), `${stamp}\n`); // heartbeat-only entry
      return;
    }
    const transcript = resolve(tmp, `transcript-${pid}-${transcriptAgo}.jsonl`);
    writeFileSync(transcript, '{}\n');
    const when = new Date(Date.now() - transcriptAgo * 1000);
    utimesSync(transcript, when, when);
    writeFileSync(resolve(sessions, String(pid)), `${stamp}\n${transcript}\n`);
  }

  const enter = (transcript: string) =>
    runHook(hook, { transcript_path: transcript, cwd: tree }, tree);

  it('says nothing about a live process that has been idle for hours — the VS Code tab', () => {
    rmSync(sessions, { recursive: true, force: true });
    register(other.pid!, 2 * 60 * 60, 2 * 60 * 60);
    expect(enter(resolve(tmp, 'mine.jsonl'))).toBe('');
  });

  it('still catches a session that is actually working', () => {
    rmSync(sessions, { recursive: true, force: true });
    register(other.pid!, 0, 0);
    expect(enter(resolve(tmp, 'mine.jsonl'))).toContain('already live');
  });

  it('counts a session mid-command: heartbeat cold, transcript moving', () => {
    rmSync(sessions, { recursive: true, force: true });
    register(other.pid!, 3 * 60 * 60, 5);
    expect(enter(resolve(tmp, 'mine.jsonl'))).toContain('already live');
  });

  it('counts a heartbeat-only entry, which is what the Stop hook writes', () => {
    rmSync(sessions, { recursive: true, force: true });
    register(other.pid!, 30, null);
    expect(enter(resolve(tmp, 'mine.jsonl'))).toContain('already live');
  });

  it('prunes an entry whose process is gone, however fresh its transcript', () => {
    rmSync(sessions, { recursive: true, force: true });
    // A PID that cannot be running: `sleep` above is alive, and this one exited before we started.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- as above
    const dead = execFileSync('bash', ['-c', 'sleep 0 & p=$!; wait $p; echo $p'], { encoding: 'utf8' }).trim();
    register(Number(dead), 0, 0);
    expect(enter(resolve(tmp, 'mine.jsonl'))).toBe('');
    expect(existsSync(resolve(sessions, dead))).toBe(false);
  });

  it('registers this session with its transcript, so the next one can judge it', () => {
    rmSync(sessions, { recursive: true, force: true });
    const mine = resolve(tmp, 'mine.jsonl');
    writeFileSync(mine, '{}\n');
    enter(mine);
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- as above
    const written = execFileSync('bash', ['-c', `cat ${JSON.stringify(sessions)}/*`], { encoding: 'utf8' });
    expect(written).toContain(mine);
  });
});
