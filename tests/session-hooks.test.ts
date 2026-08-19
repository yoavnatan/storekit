import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cleanGitEnv } from './helpers/git-env.js';

/**
 * `one-way-to-verify.sh` — tested because nothing else can see a hook fail: one that stops speaking
 * up is silent by definition, and the rule it enforces went unenforced for five days without anyone
 * noticing (67 hand-run `astro check` / `tsc` invocations, 41 minutes).
 *
 * Its whole risk is over-blocking, which is why most of these cases are things it must let through:
 * a gate that blocks work it was never meant to block gets switched off, and then it protects
 * nothing.
 */
const HOOKS = resolve(fileURLToPath(new URL('../.claude/hooks', import.meta.url)));

/** Run a hook the way Claude Code does: the event's JSON on stdin, its output on stdout. */
function runHook(script: string, payload: unknown): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- same reasoning as scripts/verify.mjs: bash off PATH is the only portable spelling, and this is a local dev repo
  return execFileSync('bash', [resolve(HOOKS, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  }).trim();
}

const runVerifyHook = (command: string) => runHook('one-way-to-verify.sh', { tool_input: { command } });

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
    const out = runVerifyHook(command);
    expect(out, `expected a deny for: ${command}`).toContain('"permissionDecision": "deny"');
    expect(out).toContain('npm run verify');
  });

  it.each(allowed)('allows %s', (command) => {
    expect(runVerifyHook(command)).toBe('');
  });
});

/**
 * `money-rules-on-contact.sh` — the money rules, moved out of the always-read part of
 * AI_INSTRUCTIONS and delivered when a session actually edits money code (8 of the 40 sessions that
 * edited anything, 2026-08-04→09; the other four in five were carrying them for nothing).
 *
 * Two failure shapes, and both are silent, which is the whole reason this file exists:
 *  • The pattern misses a file — money code then gets written with no rules at all, and the
 *    always-read bullet no longer carries them. So the cases below include modules that DO NOT
 *    EXIST yet: the pattern has to match the vocabulary, not today's filenames.
 *  • The event name is wrong. It was built on `PreToolUse` first, which would have been better —
 *    before the edit rather than after — and PreToolUse's hookSpecificOutput has no
 *    `additionalContext` field (code.claude.com/docs/en/hooks). The hook ran, emitted valid JSON,
 *    and the field was dropped on the floor. Nothing about that is visible from inside a session,
 *    so the event name is asserted here.
 */
describe('money-rules-on-contact.sh — the money rules arrive when money code is touched', () => {
  let n = 0;
  const brief = (file: string) =>
    runHook('money-rules-on-contact.sh', {
      session_id: `test-money-hook-${process.pid}-${n++}`,
      tool_input: { file_path: file },
    });

  const onSurface = [
    '/repo/src/lib/money.ts',
    '/repo/src/lib/orders.ts',
    '/repo/src/lib/refund-owed.ts',
    '/repo/src/pages/api/checkout.ts',
    '/repo/src/pages/api/seller/anything.ts', // every API route counts: they are where money moves
    '/repo/src/lib/coupon-redemption.ts', // does not exist yet — the case the pattern is FOR
    '/repo/src/lib/seller-invoice.ts', // ditto
    '/repo/src/components/PriceTag.astro', // a surface that RENDERS a price is still a money surface
  ];
  const offSurface = [
    '/repo/src/components/Header.astro',
    '/repo/src/styles/pages/store.css',
    '/repo/src/lib/toast.ts',
    '/repo/tests/cart.test.ts', // tests are not the surface; the guard scans already cover them
  ];

  it.each(onSurface)('briefs on %s', (file) => {
    const out = brief(file);
    expect(out, `expected the money rules for: ${file}`).toContain('additionalContext');
    expect(out).toContain('lib/money.ts');
  });

  it.each(offSurface)('stays silent on %s', (file) => {
    expect(brief(file)).toBe('');
  });

  it('names PostToolUse — the only Edit/Write event that carries additionalContext', () => {
    const out = brief('/repo/src/lib/money.ts');
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('PostToolUse');
    // And the file itself must not drift back: the shape is easy to copy from a PreToolUse hook.
    const src = readFileSync(resolve(HOOKS, 'money-rules-on-contact.sh'), 'utf8');
    expect(src).not.toContain('hookEventName:"PreToolUse"');
  });

  it('briefs once per session, not once per edit', () => {
    const session = `test-money-hook-once-${process.pid}`;
    const payload = (file: string) => ({ session_id: session, tool_input: { file_path: file } });
    expect(runHook('money-rules-on-contact.sh', payload('/repo/src/lib/money.ts'))).toContain('additionalContext');
    expect(runHook('money-rules-on-contact.sh', payload('/repo/src/lib/orders.ts'))).toBe('');
  });

  it('still names every module the always-read bullet points at', () => {
    const rules = readFileSync(resolve(HOOKS, 'money-rules-on-contact.sh'), 'utf8');
    for (const module of [
      'lib/money.ts',
      'lib/business-day.ts',
      'lib/order-status-rules.ts',
      'lib/orders.ts#countsAsRevenue',
      'lib/refund-owed.ts',
      'lib/checkout-idempotency.ts',
      'lib/money-events.ts',
      'tests/reporting-invariants.test.ts',
    ]) {
      expect(rules, `the briefing dropped ${module}`).toContain(module);
    }
  });
});

/**
 * `block-destructive-git.sh` — the four git commands that have actually destroyed another session's
 * work in this repo. All four were written down in memory before they happened again; being written
 * down is precisely what failed, because their common shape is that git reports SUCCESS and the
 * loss surfaces hours later, when somebody asks where a module went.
 *
 * The risk here is over-blocking, exactly as above: this hook sits in front of every Bash call a
 * session makes, and a gate that refuses ordinary git gets switched off. So most of the cases below
 * are things it MUST let through — including the two repair tools the incidents were fixed with
 * (`refs/rescue/<name>` anchors, and a path-by-path `git checkout <sha> -- <file>`), which look
 * superficially like the commands being blocked.
 *
 * One case is here because it was a real defect and not a hypothesis: the argument extraction was
 * first written as `sed -E 's/\bupdate-ref\b//'`, and BSD sed — which is what macOS ships — has no
 * `\b`. It matched nothing, so every rule read the subcommand name as its own argument: the hook
 * denied `refs/rescue/` and allowed every `git push .` shape. It was emitting confident blocks the
 * whole time, which is what makes the class worth pinning — a guard can be loud and still be inert.
 */
describe('block-destructive-git.sh — the four commands that lost work here', () => {
  const run = (command: string, cwd?: string) =>
    runHook('block-destructive-git.sh', { tool_input: { command }, ...(cwd ? { cwd } : {}) });

  // Each case also asserts the way OUT is named: a block with no exit teaches the next session to
  // work around it, which is how a gate stops being one.
  const blocked: [string, string][] = [
    ['git update-ref refs/heads/main worktree-foo', 'merge --ff-only'],
    ['git update-ref main worktree-foo', 'merge --ff-only'],
    ['cd /repo && git update-ref -d refs/heads/main', 'merge --ff-only'],
    ['git push .', '867 files'],
    ['git push . HEAD:main', '867 files'],
    ['git push /Users/me/repo main', '867 files'],
    ['git push ../main-checkout main', '867 files'],
    ['git checkout main -- .', 'git show <ref>:<path>'],
    ['git checkout abc1234 -- .', 'git show <ref>:<path>'],
    ['git restore --source=main .', 'git show <ref>:<path>'],
  ];

  it.each(blocked)('blocks %s', (command, mustNameTheWayOut) => {
    const out = run(command);
    expect(out, `expected a deny for: ${command}`).toContain('"permissionDecision": "deny"');
    expect(out, `the block for ${command} never says what to do instead`).toContain(mustNameTheWayOut);
  });

  const allowed = [
    'git update-ref refs/rescue/before-surgery abc1234', // the anchor memory says to save FIRST
    'git checkout abc1234 -- src/foo.ts', // path-by-path is how the 2026-08-06 loss was repaired
    'git push origin main',
    'git push -u origin HEAD',
    'git checkout -- .', // no ref: discards only this session's own uncommitted work
    'git checkout main',
    'git checkout -B worktree-foo main',
    'git merge --ff-only worktree-foo',
    'git rebase main',
    'git status --short',
    'git show main:src/foo.ts',
    'npm run verify -- --all',
    'git commit -m "a message that mentions git add -A in prose"',
    // A message file whose PATH contains a dash-letters-a run — which every session's scratchpad
    // path does here (`…/-Users-yoavnatan-…` contains `-yoa`). Unanchored, the sweeping-commit
    // pattern matched the path and refused an ordinary commit with a warning about a stale
    // checkout. An over-block on a safety hook is what teaches the next session to route around it.
    'git commit -q -F /tmp/claude/-Users-yoavnatan-Desktop-porject-2/scratchpad/msg.txt',
  ];

  it.each(allowed)('allows %s', (command) => {
    expect(run(command), `over-blocked: ${command}`).toBe('');
  });

  it('blocks a sweeping commit from a tree missing tracked files, and names them', () => {
    // The 2026-08-06 shape, BUILT rather than described: HEAD holds files the working tree does not.
    const repo = mkdtempSync(resolve(tmpdir(), 'stale-tree-'));
    // env, not just cwd: under `git push` the pre-push hook runs this suite with GIT_DIR set, and
    // GIT_DIR beats cwd — so these would address the REAL repository (tests/git-env-isolation.test.ts).
    const git = (...args: string[]) =>
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- same reasoning as runHook above
      execFileSync('git', args, { cwd: repo, env: cleanGitEnv(), encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'keep.ts']) writeFileSync(resolve(repo, f), 'x');
    git('add', '-A');
    git('commit', '-qm', 'in');
    for (const f of ['a.ts', 'b.ts', 'c.ts']) rmSync(resolve(repo, f));

    for (const sweeping of ['git commit -am "docs"', 'git commit -a -m "docs"', 'git add -A', 'git add .', 'git add -u']) {
      const out = run(sweeping, repo);
      expect(out, `expected a deny for: ${sweeping}`).toContain('"permissionDecision": "deny"');
      expect(out, 'the block has to name the files, or it is unactionable').toContain('a.ts');
    }

    // Naming what you mean stays open — that is the exit the block points at.
    expect(run('git rm a.ts b.ts c.ts', repo)).toBe('');
    expect(run('git commit -m "docs"', repo)).toBe('');

    // And a tree missing nothing is never blocked, however sweeping the command.
    git('rm', '-q', 'a.ts', 'b.ts', 'c.ts');
    git('commit', '-qm', 'out');
    expect(run('git add -A', repo)).toBe('');

    rmSync(repo, { recursive: true, force: true });
  });
});
