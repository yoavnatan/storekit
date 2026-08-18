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
 * `.env` is the deliberate exception, and it stays one. Backing it up alongside memory was put to
 * the owner the same day and turned down for the better reason: every value in it can be reissued
 * from a console, so a copy in the memory repo would buy a few minutes of convenience at the cost
 * of a second place the secrets can leak from. What replaced it is instructions — the setup script
 * prints the five values a fresh clone has to fill and where each one comes from. The last block
 * here pins that they stay accurate, because a recovery note that has drifted is worse than none:
 * it is trusted.
 *
 * Everything here runs against local bare repos under a temp HOME. Nothing touches the real memory
 * repo, the real `~/.claude`, or the network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cleanGitEnv } from './helpers/git-env.js';
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
    env: cleanGitEnv(),
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
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: cleanGitEnv(), stdio: 'ignore' });
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

  it('says nothing about .env when it is already there', () => {
    const m = machine();
    const b = checkout(m.root, 'machine-b', { env: true });
    expect(runSetup(b, m)).not.toContain('ONE THING LEFT');
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

/**
 * The five values a fresh clone must supply by hand.
 *
 * Not "the five in `.env.example`" — that file lists twenty-odd variables and all but these work
 * empty. These are the ones without which the app cannot connect to its database or serve the
 * flows that depend on an account, so they are what a recovery note has to name and the rest is
 * noise on the one morning anybody reads it.
 */
const MUST_FILL = [
  'DATABASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PUBLIC_CLOUDINARY_CLOUD_NAME',
  'PUBLIC_CLOUDINARY_UPLOAD_PRESET',
];

describe('the .env recovery note — the part nothing restores for you', () => {
  const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');

  it('walks a fresh clone through it, naming every value and where it comes from', () => {
    const m = machine();
    const out = runSetup(checkout(m.root, 'machine-b'), m);

    expect(out).toContain('ONE THING LEFT: .env');
    expect(out).toContain('cp .env.example .env');
    for (const key of MUST_FILL) expect(out).toContain(key);
    // A variable name on its own sends you looking; the console name is the actual instruction.
    for (const where of ['Neon', 'Google Cloud', 'Cloudinary']) expect(out).toContain(where);
  });

  /**
   * The drift guard, and the reason this block exists at all. A note naming a variable the project
   * no longer has — or silent about one it has gained — is worse than no note, because it is read
   * exactly once, under pressure, and believed. Renaming a variable now fails here until both the
   * script and `.env.example` are brought along.
   */
  it('names only variables that really exist in .env.example', () => {
    for (const key of MUST_FILL) {
      expect(example, `${key} is in the recovery note but not in .env.example`)
        .toMatch(new RegExp(`^${key}=`, 'mu'));
    }
  });

  it('puts the same list at the top of .env.example, for whoever opens the file instead', () => {
    const header = example.slice(0, example.indexOf('# --- '));
    expect(header).toContain('JUST CLONED');
    for (const key of MUST_FILL) expect(header).toContain(key);
  });
});

/**
 * `CLAUDE.md` — the page that has to work when nothing else has been read.
 *
 * The owner's requirement, 2026-08-09: after a clone he says "I'm restoring on a new machine" and
 * the session does the work, rather than him running anything. Which exposed a circle nobody had
 * noticed. What normally points a session at `AI_INSTRUCTIONS.md` is memory; memory arrives from
 * the private repo; the private repo is restored by a script a session only knows about because
 * `AI_INSTRUCTIONS.md` mentions it. On an existing machine the circle is closed and invisible. On a
 * fresh clone it has no entry at all — and there was no root `CLAUDE.md`, the one file the harness
 * loads without being told.
 *
 * So these assertions are about the trigger surviving: the steps have to be here, in the file that
 * gets read first, naming the same five values as everything else.
 */
describe('CLAUDE.md — the new-machine entry point', () => {
  const claude = readFileSync(fileURLToPath(new URL('../CLAUDE.md', import.meta.url)), 'utf8');

  it('sends the session to the real instructions', () => {
    expect(claude).toContain('AI_INSTRUCTIONS.md');
    expect(claude).toContain('CURRENT_TASK.md');
  });

  it('carries the restore steps, since nothing else can be assumed read', () => {
    expect(claude).toContain('scripts/setup-claude-memory.sh');
    expect(claude).toContain('npm ci');
    for (const key of MUST_FILL) expect(claude).toContain(key);
  });

  it('forbids the three things that would turn a restore into damage', () => {
    for (const rule of ['invent', 'commit `.env`', 'push']) expect(claude).toContain(rule);
  });

  /**
   * A ceiling, in the same spirit as `instructions-budget.test.ts` and for the same reason: this
   * file is always-read, and an always-read file with no bound grows into a second copy of the
   * instructions — at which point the budget on the first one has been quietly defeated. If a rule
   * needs more room than this, it belongs in `AI_INSTRUCTIONS.md`, which is where rules live.
   */
  it('stays small enough to remain an entry point rather than a second rulebook', () => {
    expect(claude.length, `CLAUDE.md is ${claude.length} chars — move detail to AI_INSTRUCTIONS.md`)
      .toBeLessThanOrEqual(4000);
  });
});

/**
 * `.claude/hooks/memory-backup-age.sh` — the alarm on the one risk that was silent by construction.
 *
 * Memory reaches GitHub as a side effect of pushing CODE, which is an action with its own unrelated
 * schedule. So a stretch of memory-only work is a stretch of unbacked memory, and nothing said so.
 *
 * The assertions that matter are the SILENT ones. An alarm that fires on ordinary state is read
 * twice and ignored forever after, and memory is dirty during most of a normal session — so "dirty
 * but backed up yesterday" has to stay quiet, and only age turns it into speech.
 */
const AGE_HOOK = fileURLToPath(new URL('../.claude/hooks/memory-backup-age.sh', import.meta.url));

/** Seconds → a git-usable timestamp that far in the past. */
const agoIso = (seconds: number) => new Date((NOW_MS - seconds * 1000)).toISOString();

/**
 * `Date.now()` once, at module load: every timestamp below is derived from it, so a suite that
 * takes seconds to run cannot have one case straddle the 24h boundary while another does not.
 */
const NOW_MS = Date.now();

/**
 * A checkout with a `.claude-memory` in whatever state the case needs.
 * `lastPushAge` is how long ago the commit that reached the remote was made; `dirty` leaves an
 * uncommitted file behind; `unpushed` adds a local commit the remote has never seen.
 */
function withMemory(opts: { lastPushAge?: number; dirty?: boolean; unpushed?: boolean; none?: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memage-')));
  temps.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  if (opts.none) return repo;

  const remote = join(root, 'remote.git');
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: cleanGitEnv(), stdio: 'ignore' });
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'MEMORY.md'), '# Memory Index\n');
  git(seed, 'add', '-A');
  const when = agoIso(opts.lastPushAge ?? 0);
  execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed', '--date', when],
    { cwd: seed, env: cleanGitEnv({ GIT_COMMITTER_DATE: when }), stdio: 'ignore' },
  );
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');

  const mem = join(repo, '.claude-memory');
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['clone', '-q', remote, mem], { env: cleanGitEnv(), stdio: 'ignore' });
  if (opts.dirty) writeFileSync(join(mem, 'scratch.md'), 'written this session\n');
  if (opts.unpushed) {
    writeFileSync(join(mem, 'committed.md'), 'committed, never pushed\n');
    git(mem, 'add', '-A');
    git(mem, 'commit', '-m', 'local only');
  }
  return repo;
}

function runAgeHook(repo: string): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync('bash', [AGE_HOOK], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const DAY = 86_400;

describe('memory-backup-age.sh — silent until it is actually overdue', () => {
  it('says nothing when memory is clean and pushed', () => {
    expect(runAgeHook(withMemory({ lastPushAge: 5 * DAY }))).toBe('');
  });

  it('says nothing about ordinary unsaved work — memory is dirty most of a session', () => {
    expect(runAgeHook(withMemory({ lastPushAge: 2 * 3600, dirty: true }))).toBe('');
  });

  it('says nothing when there is no memory repo — that is the restore protocol, not this', () => {
    expect(runAgeHook(withMemory({ none: true }))).toBe('');
  });

  it('speaks when unbacked work has been sitting for more than a day', () => {
    const out = runAgeHook(withMemory({ lastPushAge: 3 * DAY, dirty: true }));
    expect(out).toContain('memory backup is overdue');
    expect(out).toContain('3 day(s) ago');
    expect(out).toContain('1 file(s) written but not committed');
  });

  it('counts a commit that never left the machine as unbacked, because it is', () => {
    const out = runAgeHook(withMemory({ lastPushAge: 4 * DAY, unpushed: true }));
    expect(out).toContain('1 commit(s) never pushed');
  });

  it('tells the session to offer the push and not to run it', () => {
    const out = runAgeHook(withMemory({ lastPushAge: 3 * DAY, dirty: true }));
    expect(out).toContain('HIS call');
    expect(out).toContain('do not run it unasked');
  });

  it('is wired into Stop, or it is a file that runs never', () => {
    const settings = JSON.parse(readFileSync(fileURLToPath(new URL('../.claude/settings.json', import.meta.url)), 'utf8'));
    const commands = (settings.hooks?.Stop ?? []).flatMap((g: { hooks?: { command?: string }[] }) => g.hooks ?? [])
      .map((h: { command?: string }) => h.command ?? '');
    expect(commands).toContain('bash .claude/hooks/memory-backup-age.sh');
  });
});
