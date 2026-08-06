#!/usr/bin/env node
// Make a fresh git worktree usable: `npm run worktree:setup`, run once from inside it.
//
// Why this exists. Two sessions in ONE working tree cannot both be green, and the failure is not a
// slowdown — it is a loop that does not end (measured 2026-08-04):
//   • Every gate in this repo keys off a fingerprint of the whole working tree — `verify.mjs`'s
//     content hash, `review-state.sh`'s `diff_fingerprint`. One keystroke saved by the other session
//     changes it, so the "unchanged since it last passed" cache never hits and every Stop hook pays
//     the full suite again.
//   • `require-green.sh` bounds itself at two blocks per fingerprint (`red-$fp`). A fingerprint that
//     changes every few seconds means the counter is always at 0, so the escape hatch never fires.
//   • And `--all` checks the whole tree, so session A goes red on half-written code session B owns,
//     which A cannot fix. It edits, the fingerprint moves, a fresh gate opens, red again.
// Separate worktree = separate tree = separate fingerprint, separate `/tmp/claude-review-state-*`,
// and each session only ever fails on its own code. That is the whole fix; this script only removes
// the reason worktrees were not already the default.
//
// The reason: a fresh worktree has no `node_modules`, so `verify.mjs` resolves every binary to a path
// that does not exist and the Stop hook is red before a single check runs — and `npm ci` per worktree
// is ~460MB and minutes. On APFS `cp -Rc` clones by reference: near-instant, and near-zero disk until
// a file actually diverges. The clone's `.cache` is dropped rather than kept — eslint and tsc key
// their caches on absolute paths, so a copied one is cold anyway, and dropping it is what guarantees
// no artifact of the other tree's state can be read as this tree's answer.
//
// `.env` (and the local Claude permission overrides) are gitignored, so a worktree checkout has
// neither. Without the first, the `db migrations` check and every seed script lose DATABASE_URL;
// without the second, the new session re-asks for permissions this machine already granted.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

// `stdio: 'inherit'` makes execFileSync return null rather than a string — the callers that stream
// their output (npm ci, the warm-up verify) want the child's console, not its text, and only the
// git callers read a value back.
const run = (cmd, args, opts = {}) =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts })?.trim() ?? '';

const git = (...args) => run('git', args);

let ROOT;
let COMMON;
try {
  ROOT = git('rev-parse', '--show-toplevel');
  // In the main worktree these two are the same directory; in a linked worktree `--git-dir` points
  // at `.git/worktrees/<name>` while `--git-common-dir` still points at the real `.git`. That is the
  // only reliable way to tell which one you are standing in.
  COMMON = resolve(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
} catch {
  console.error('worktree-setup: not a git repository.');
  process.exit(1);
}

const MAIN = dirname(COMMON);
if (MAIN === ROOT) {
  console.error(
    'worktree-setup: this IS the main worktree — nothing to provision.\n' +
      '  Create one first (Claude: EnterWorktree, or `git worktree add .claude/worktrees/<name>`),\n' +
      '  then run this from inside it.',
  );
  process.exit(1);
}

const steps = [];

// ── node_modules ──
const src = resolve(MAIN, 'node_modules');
const dst = resolve(ROOT, 'node_modules');
if (existsSync(dst)) {
  steps.push('node_modules: already here');
} else if (!existsSync(src)) {
  run('npm', ['ci'], { cwd: ROOT, stdio: 'inherit' });
  steps.push('node_modules: npm ci (main worktree had none to clone)');
} else {
  // `-c` is macOS clonefile; `--reflink=auto` is the GNU spelling; a plain recursive copy is the
  // portable last resort and the only one that actually costs the full 460MB.
  const attempts = [['-Rc'], ['-R', '--reflink=auto'], ['-R']];
  let how = null;
  for (const flags of attempts) {
    try {
      run('cp', [...flags, src, dst]);
      how = flags.join(' ');
      break;
    } catch {
      rmSync(dst, { recursive: true, force: true }); // a half-written copy is worse than none
    }
  }
  if (!how) {
    run('npm', ['ci'], { cwd: ROOT, stdio: 'inherit' });
    how = 'npm ci (clone failed)';
  }
  // Every cache under here belongs to the tree it was built in. Rebuilding costs seconds; reading
  // another tree's answer as this tree's is the class of bug this whole script exists to end.
  rmSync(resolve(dst, '.cache'), { recursive: true, force: true });
  steps.push(`node_modules: cloned \`cp ${how}\``);
}

// ── gitignored files a checkout cannot carry ──
for (const rel of ['.env', '.claude/settings.local.json']) {
  const from = resolve(MAIN, rel);
  const to = resolve(ROOT, rel);
  if (!existsSync(from) || existsSync(to)) continue;
  copyFileSync(from, to);
  steps.push(`${rel}: copied`);
}

// ── memory, for THIS worktree's path ──
//
// **The damage this prevents (2026-08-06).** The harness derives a project's memory directory from
// the absolute path, dashing every non-alphanumeric character — so a worktree, being a different
// path, gets a DIFFERENT slug and therefore a different memory directory. `setup-claude-memory.sh`
// only ever links the main checkout's slug, so in a worktree the harness wrote memory into a plain
// directory that belonged to no repository. What happened next is the part that cost real work: the
// memory sync went looking for its checkout, `.claude-memory` does not exist in a worktree either,
// and git walked UP from there and found the PROJECT repo — so it committed a tree of memory files,
// with no `src/` at all, straight onto the session's own branch. Two such commits landed on a code
// branch before anyone noticed.
//
// A symlink to the main checkout's `.claude-memory` closes both halves at once: memory written from
// a worktree lands in the memory repo, and the sync finds a real checkout instead of walking up into
// this one. Skipped when the main checkout has no memory repo (a machine that never ran the setup
// script) — there is nothing to point at, and inventing one is how a wrong path becomes permanent.
{
  const memRepo = resolve(MAIN, '.claude-memory');
  const slug = ROOT.replace(/[^A-Za-z0-9]/gu, '-');
  const linkDir = resolve(homedir(), '.claude', 'projects', slug);
  const link = resolve(linkDir, 'memory');
  if (!existsSync(memRepo)) {
    steps.push('memory: skipped — no .claude-memory in the main checkout (run scripts/setup-claude-memory.sh)');
  } else if (existsSync(link) && !lstatSync(link).isSymbolicLink()) {
    // A real directory here holds memory the harness already wrote outside the repo. Replacing it
    // would delete it, so it is moved aside and named rather than merged: which of those files are
    // worth keeping is a judgement, and a setup script has no business making it.
    renameSync(link, `${link}.local-backup`);
    symlinkSync(memRepo, link);
    steps.push('memory: linked (a real directory was moved to memory.local-backup — check it)');
  } else if (!existsSync(link)) {
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(memRepo, link);
    steps.push('memory: linked to the main checkout\'s .claude-memory');
  }
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`worktree ready — ${branch}\n  ${steps.join('\n  ')}`);

// ── prove it, and leave it warm ──
//
// Two reasons this is not optional (`--no-verify` exists for a hand-run, not for a session).
//   • A worktree whose checks cannot run is worse than no worktree: the Stop hook would go red on
//     the tooling rather than on the code, and a red you learn to explain away is a gate that has
//     stopped working. Green here means the provisioning above actually worked.
//   • Cold, the full suite measured 2:18 in a fresh worktree against 1:25 in a warm one — eslint and
//     tsc key their caches on absolute paths, so the clone starts with none, and the PGlite image has
//     to be rebuilt. Paying that once here, unattended, keeps every later Stop hook well under its
//     timeout instead of putting the FIRST one closest to it.
if (!process.argv.includes('--no-verify')) {
  console.log('  warming the checks (first run in a new tree is cold, ~2 min)…');
  run('npm', ['run', 'verify', '--', '--all'], { cwd: ROOT, stdio: 'inherit' });
}
console.log('  `npm run verify` now runs here, against this tree only.');
