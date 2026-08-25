/**
 * Which guard tests are satisfied by a COMMENT rather than by the code?
 *
 * The owner's question, 2026-08-25: *"יש מצב שיש ביקורות שרצות על ריק?"* — asked after three guards
 * written that day turned out to be vacuous, one because it found the string it required inside the
 * comment explaining the rule. "None of the others is known to be hollow" was a statement about what
 * had not been checked, so this checks it.
 *
 * **How.** Run the suite. Then run it again against a copy of the tree with every comment stripped
 * out of `src/`. A test that passes normally and FAILS with the comments gone was relying on a
 * comment for its assertion. That is the class, found mechanically instead of by reading 97 files.
 *
 * **It runs the second pass in a THROWAWAY GIT WORKTREE, and that is not tidiness.** The first
 * version stripped `src/` in place and restored it in a `finally`, which is correct right up until
 * something else reads the tree in between — and in this repo a `Stop` hook runs the full
 * verification at moments this script does not choose. It duly went red mid-run, on nine tests, in
 * a tree that was mid-experiment. Nothing was damaged, and it looked exactly like real breakage. A
 * tool that mutates a shared checkout is a tool that eventually lies to somebody, so this one
 * mutates a copy nobody else can see.
 *
 * `node_modules` is symlinked rather than installed: the copy lives for a few minutes and an
 * install would cost more than the whole audit.
 *
 * **What it cannot see.** A guard hollow for another reason — a slice that misses, a regex matching
 * nothing, a path that moved — passes both runs. One class, precisely; no claim about the rest.
 * `tests/helpers/source-guard.ts` is what prevents all of them going forward.
 *
 *   node scripts/audit-hollow-guards.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const OUT = mkdtempSync(join(tmpdir(), 'hollow-'));
const vitestIn = (root) => join(root, 'node_modules', 'vitest', 'vitest.mjs');

/** Anchored exactly as `tests/helpers/source-guard.ts` anchors it — a line comment must OPEN the
 *  line (or the slashes in an https URL would go), a block comment must follow whitespace or a
 *  brace (or an `image/[star]` attribute value swallows the rest of a stylesheet). */
const strip = (t) => t
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1 ')
  .replace(/^\s*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(astro|ts|css)$/.test(p)) out.push(p);
  }
  return out;
}

/** `process.execPath` plus a resolved entry, never a bare command name: that is a lookup through
 *  whatever directories the caller's environment lists, and it also runs whichever vitest a shell
 *  happens to find rather than this checkout's. */
function suite(root, tag) {
  const file = join(OUT, `${tag}.json`);
  const r = spawnSync(process.execPath, [vitestIn(root), 'run', '--reporter=json', '--outputFile', file], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28,
  });
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const m = new Map();
    for (const f of json.testResults ?? []) {
      const short = f.name.split('/tests/')[1] ?? f.name;
      for (const a of f.assertionResults ?? []) m.set(`${short} :: ${a.fullName}`, a.status);
    }
    return m;
  } catch {
    console.error(`${tag}: no report produced.`);
    console.error((r.stderr || r.stdout || '').slice(-1500));
    process.exit(1);
  }
}

console.log('run 1/2 — this tree, as it is ...');
const before = suite(REPO, 'normal');

const copy = join(OUT, 'stripped-tree');
console.log('making a throwaway worktree ...');
/* From the WORKING state, not from HEAD. `git stash create` writes a commit object for whatever is
   currently in the tree and index without touching either — which is exactly what is wanted here,
   because the interesting question is whether the guards as they stand right now are hollow, and
   HEAD is by definition the version before the fix you are testing. Auditing HEAD reported eleven
   hits on a tree where two of them had already been repaired. Falls back to HEAD when the tree is
   clean, which is when `stash create` prints nothing. */
const stashed = spawnSync('/usr/bin/git', ['stash', 'create'], { cwd: REPO, encoding: 'utf8' });
const base = (stashed.stdout ?? '').trim() || 'HEAD';
console.log(base === 'HEAD' ? '  (tree is clean — auditing HEAD)' : '  (auditing the working tree)');
const add = spawnSync('/usr/bin/git', ['worktree', 'add', '--detach', copy, base], { cwd: REPO, encoding: 'utf8' });
if (add.status !== 0) {
  console.error('could not create the worktree:', add.stderr);
  process.exit(1);
}

let after;
try {
  symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'), 'dir');
  for (const f of walk(join(copy, 'src'))) writeFileSync(f, strip(readFileSync(f, 'utf8')), 'utf8');
  console.log('run 2/2 — the copy, with every comment gone ...');
  after = suite(copy, 'stripped');
} finally {
  rmSync(join(copy, 'node_modules'), { force: true });
  spawnSync('/usr/bin/git', ['worktree', 'remove', '--force', copy], { cwd: REPO, encoding: 'utf8' });
  console.log('throwaway worktree removed; this checkout was never touched.');
}

const flipped = [];
for (const [k, v] of before) if (v === 'passed' && after.get(k) === 'failed') flipped.push(k);

console.log('');
console.log(`tests total                 : ${before.size}`);
console.log(`already failing before      : ${[...before.values()].filter((v) => v === 'failed').length}`);
console.log(`PASS normally, FAIL stripped: ${flipped.length}`);
for (const k of flipped) console.log('   ' + k);
if (!flipped.length) console.log('   (none — no guard in the suite is satisfied by a comment)');
console.log('');
console.log('Read each one before believing it. Most hits are tests that assert a comment EXISTS on');
console.log('purpose — a documented rule, a `silent:` marker — and those are SUPPOSED to fail here.');
console.log('A hit is a finding only when the test meant to be checking CODE.');
