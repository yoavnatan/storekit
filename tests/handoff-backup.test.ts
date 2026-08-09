/**
 * "This machine dies — what do I lose?"
 *
 * The answer is supposed to be `.env` and nothing else: code lives in `storekit`, memory lives in
 * the private `storekit-memory` repo, and `.githooks/pre-push` backs the second up whenever the
 * first is pushed. An audit on 2026-08-09 found one more thing in neither repo —
 * `.claude/settings.local.json`, this machine's ~4.8KB of Claude permission grants, gitignored by
 * the code repo on purpose because it is machine state rather than project state.
 *
 * Losing it costs no work, which is exactly why it would go unnoticed: the new machine simply
 * re-asks for every permission, one dialog at a time, and the cheapest way out of that is turning
 * the gates off. So it now rides with memory, and this file pins both halves of the round trip:
 *
 *   · `.githooks/pre-push` copies it INTO the memory checkout before that checkout is committed,
 *   · `scripts/setup-claude-memory.sh` copies it BACK on a fresh machine — and never over a file
 *     that already exists, because on a machine in use the local file is newer than the snapshot.
 *
 * Everything here runs against local bare repos under a temp HOME. Nothing touches the real memory
 * repo, the real `~/.claude`, or the network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP = fileURLToPath(new URL('../scripts/setup-claude-memory.sh', import.meta.url));
const PRE_PUSH = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url));

const SETTINGS = '{ "permissions": { "allow": ["Bash(npm run verify:*)"] } }';

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/**
 * Identity has to be explicit: a CI runner has no configured git user and `commit` would abort.
 *
 * The `sonarjs` suppressions on every `execFileSync` in this file are the same call this repo
 * already makes in `scripts/worktree-setup.mjs`: resolving `git` and `bash` from PATH is the point —
 * these are the binaries the developer's own shell would run, and pinning an absolute path would
 * test a toolchain nobody has.
 */
const git = (cwd: string, ...args: string[]) =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/**
 * A throwaway "machine": a bare memory remote seeded with one commit, plus an empty HOME for the
 * symlink the setup script plants under `~/.claude/projects/<slug>`.
 */
function machine() {
  // macOS puts temp dirs under a /var -> /private/var symlink, and the setup script derives the
  // harness slug from the path it resolves itself to. Resolving up front keeps the slug this test
  // computes and the one the script computes identical.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-')));
  temps.push(root);

  const remote = join(root, 'memory-remote.git');
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'MEMORY.md'), '# Memory Index\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');

  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, remote, home };
}

/** A checkout of the code repo, with only the parts these two scripts read. */
function checkout(root: string, name: string, opts: { settings?: string; env?: boolean } = {}) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, '.githooks'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  cpSync(SETUP, join(repo, 'scripts', 'setup-claude-memory.sh'));
  cpSync(PRE_PUSH, join(repo, '.githooks', 'pre-push'));
  git(repo, 'init', '-b', 'main');
  if (opts.settings !== undefined) writeFileSync(join(repo, '.claude', 'settings.local.json'), opts.settings);
  if (opts.env) writeFileSync(join(repo, '.env'), 'DATABASE_URL=postgres://x\n');
  return repo;
}

function runSetup(repo: string, m: ReturnType<typeof machine>) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync('bash', [join(repo, 'scripts', 'setup-claude-memory.sh')], {
    env: { PATH: process.env.PATH ?? '', HOME: m.home, MEMORY_REMOTE: m.remote },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('setup-claude-memory.sh — what a fresh machine gets back', () => {
  it('restores .claude/settings.local.json from the memory repo', () => {
    const m = machine();

    // Machine A: has the settings, pushes. The hook is what puts the snapshot in the memory repo,
    // so this half is deliberately not simulated by hand — it is the real pre-push run.
    const a = checkout(m.root, 'machine-a', { settings: SETTINGS, env: true });
    runSetup(a, m);
    runPrePush(a);

    // Machine B: a bare clone, no settings file at all.
    const b = checkout(m.root, 'machine-b', { env: true });
    const out = runSetup(b, m);

    expect(out).toContain('Restored .claude/settings.local.json');
    expect(readFileSync(join(b, '.claude', 'settings.local.json'), 'utf8')).toBe(SETTINGS);
  });

  it('never overwrites settings that are already there', () => {
    const m = machine();
    const a = checkout(m.root, 'machine-a', { settings: SETTINGS, env: true });
    runSetup(a, m);
    runPrePush(a);

    // A machine in use: its own grants are newer than the snapshot, and the snapshot must lose.
    const local = '{ "permissions": { "allow": ["Bash(echo:*)"] } }';
    const b = checkout(m.root, 'machine-b', { settings: local, env: true });
    const out = runSetup(b, m);

    expect(out).toContain('Kept existing');
    expect(readFileSync(join(b, '.claude', 'settings.local.json'), 'utf8')).toBe(local);
  });

  it('says out loud that .env is still missing — the one thing neither repo carries', () => {
    const m = machine();
    const b = checkout(m.root, 'machine-b');
    expect(runSetup(b, m)).toContain('STILL MISSING: .env');
  });

  it('says nothing about .env when it is already there', () => {
    const m = machine();
    const b = checkout(m.root, 'machine-b', { env: true });
    expect(runSetup(b, m)).not.toContain('STILL MISSING');
  });

  it('links the harness memory path at this checkout to the memory repo', () => {
    const m = machine();
    const b = checkout(m.root, 'machine-b', { env: true });
    const out = runSetup(b, m);

    const slug = b.replace(/[^A-Za-z0-9]/gu, '-');
    const link = join(m.home, '.claude', 'projects', slug, 'memory');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(b, '.claude-memory'));
    // The script's last line reads the index back THROUGH the link it just planted, so this is the
    // round trip rather than a second opinion about the same symlink. Asserted from its output
    // rather than by reading the file here, and deliberately: `verify-doc-inputs.test.ts` treats a
    // markdown filename quoted inside a file-read call as proof that the repo's own copy of that
    // doc is an input to the suite. Here it would not be — the index this exercises is a fixture in
    // a temp dir — and satisfying that guard instead would put the real memory index into the
    // verify fingerprint, making every routine memory edit cost a full suite run.
    expect(out).toContain('Done. Verify: # Memory Index');
  });
});

/**
 * Runs the real hook and returns its stderr.
 *
 * It exits 1 here, and that is the point rather than a workaround: section 2 of the hook refuses to
 * run `npm run verify -- --all` when `node_modules` is absent, and a fake checkout has none. So the
 * hook does its whole backup section and then bails before the part that would cost two minutes.
 * If that ordering is ever inverted — the gate moved above the backup — these assertions fail,
 * which is correct: a backup that only happens on a green tree is not a backup.
 */
function runPrePush(repo: string): string {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('bash', [join(repo, '.githooks', 'pre-push')], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (e) {
    const err = e as { stderr?: string };
    return err.stderr ?? '';
  }
}

describe('.githooks/pre-push — what a push actually backs up', () => {
  it('stages and commits settings.local.json into the memory repo', () => {
    const m = machine();
    const a = checkout(m.root, 'machine-a', { settings: SETTINGS, env: true });
    runSetup(a, m);

    const err = runPrePush(a);
    expect(err).toContain('node_modules is missing'); // it reached the gate, i.e. section 1 ran

    const mem = join(a, '.claude-memory');
    expect(readFileSync(join(mem, 'settings.local.json.bak'), 'utf8')).toBe(SETTINGS);
    // Committed, not merely copied: an uncommitted file in the memory checkout is exactly as lost
    // as one that was never written.
    expect(git(mem, 'status', '--porcelain')).toBe('');
    expect(git(mem, 'log', '--oneline', 'origin/main..HEAD')).toBe('');
  });

  it('picks up later changes to the grants, rather than only the first snapshot', () => {
    const m = machine();
    const a = checkout(m.root, 'machine-a', { settings: SETTINGS, env: true });
    runSetup(a, m);
    runPrePush(a);

    const grown = '{ "permissions": { "allow": ["Bash(npm run verify:*)", "Bash(git status:*)"] } }';
    writeFileSync(join(a, '.claude', 'settings.local.json'), grown);
    runPrePush(a);

    expect(readFileSync(join(a, '.claude-memory', 'settings.local.json.bak'), 'utf8')).toBe(grown);
  });

  it('does not invent a backup when there are no grants to back up', () => {
    const m = machine();
    const a = checkout(m.root, 'machine-a', { env: true });
    runSetup(a, m);
    runPrePush(a);

    expect(existsSync(join(a, '.claude-memory', 'settings.local.json.bak'))).toBe(false);
  });
});
