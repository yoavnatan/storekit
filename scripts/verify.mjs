#!/usr/bin/env node
// One command for the mid-session checkpoint: `npm run verify`.
//
// Why this exists. AI_INSTRUCTIONS.md asks for `astro check`, `npm run lint` and `npm test` after
// every code step. Run one after another, uncached, that is ~115s of pure waiting per checkpoint
// (measured 2026-07-31: tsc 9s / astro check 39s / lint 37s / vitest 30s) — and a session with eight
// checkpoints spends a quarter of an hour watching them. Three things fix that, none of which weaken
// the check:
//   • Concurrency — they are independent read-only passes, so the cost is the slowest, not the sum.
//   • Caches — eslint 37s→4s warm, tsc 9s→4s warm. Both invalidate on content/config change on
//     their own; neither can go stale into a false green.
//     ⚠️ But the eslint one HAS gone stale into a false RED (2026-07-31): it kept reporting
//     `no-undef` on an .astro file for imports that were sitting right there, across repeated
//     runs, while plain `npm run lint` on the same tree was clean. `rm node_modules/.cache/eslint`
//     fixed it and the warm rerun stayed clean. So when this prints a lint error you cannot see in
//     the code, confirm with uncached `npm run lint` BEFORE editing anything — the uncached run is
//     the ground truth, and a phantom error here has already cost one debugging detour.
//   • Scope — `astro check` (the 39s one) only has something to say when a .astro file changed; on a
//     pure .ts change plain `tsc` covers the same ground. A docs-only turn runs nothing at all.
// Typical warm checkpoint lands ~30s instead of ~115s, bounded by the test suite.
//
// `--all` disables the scoping and runs everything (the Stop hook and any "am I really green?"
// moment use it). Scoping keys off the working diff, so it is deliberately not the default for a
// final gate — a check skipped because its file was committed earlier in the session is still a
// check that did not run. NOTHING here weakens what gets caught: a skipped check is always named in
// the output, the Stop hook runs `--all` before any turn can end, and CI runs all four plus a build
// on a clean checkout with no caches at all. Note too that `--all` reaches for `astro check`, which
// has no cache — so the final gate never depends on an incremental artifact being right.
// The only thing removed is waiting.
//
// Two known `astro check` false-positives, kept here because this is what runs it — leave both alone:
//   1. A `const` declared immediately before `Astro.redirect(...)` inside an if/else-if chain is
//      wrongly flagged ts(6133) "never read". Confirm with grep before "fixing" it — deleting the
//      const breaks the redirect.
//   2. "Unreachable code" on a `<script is:inline>` nested inside a conditionally-rendered branch.
//      It is real and it runs; `is:inline` is injected raw.
// And when a `.astro` compile error gives no file/line — not in the dev overlay, not in astro check —
// run `npx astro build`: its [CompilerError] output carries a `Location:` with the exact file:line.
// (That one burned a whole session. Do not hand-write an AST differ to binary-search it.)
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = (name) => resolve(ROOT, 'node_modules/.bin', name);
// node_modules is already gitignored, so the caches need no new ignore rule and never reach a clone.
const CACHE = resolve(ROOT, 'node_modules/.cache');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const COMPACT = argv.includes('--compact'); // hook mode: nothing on success, failures only

// Tracked changes AND untracked files — same definition the review gate uses (.claude/hooks/
// review-state.sh); much of this repo's work sits uncommitted, so `diff HEAD` alone misses whole
// new modules.
function changedFiles() {
  try {
    // Resolving git off PATH is the only portable option (no fixed path across mac/linux/CI), and
    // this is a local dev script: anyone who can shadow `git` on your PATH can already edit it.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    const tracked = git('diff', 'HEAD', '--name-only');
    const untracked = git('ls-files', '--others', '--exclude-standard');
    return [...new Set((tracked + untracked).split('\n').filter(Boolean))];
  } catch {
    return null; // not a git repo / git unavailable — fall back to running everything
  }
}

const files = ALL ? null : changedFiles();
const has = (re) => files === null || files.some((f) => re.test(f));

const touchedAstro = has(/\.astro$/);
const touchedCode = has(/\.(ts|tsx|astro|mjs|js)$/);
// Guard tests scan the whole tree (money-guards, image-optimization, safe-redirect …), so a .css or
// .json file under src/ can turn the suite red just as a .ts file can. Scope tests by location, not
// by extension.
const touchedSrc = has(/^(src|tests|scripts)\//) || has(/\.(json|css)$/);

const checks = [];
if (touchedAstro) {
  // Superset of tsc: also compiles and type-checks .astro templates.
  checks.push({ name: 'astro check', cmd: BIN('astro'), args: ['check'] });
} else if (touchedCode) {
  checks.push({
    name: 'tsc',
    cmd: BIN('tsc'),
    args: ['--noEmit', '--incremental', '--tsBuildInfoFile', resolve(CACHE, 'tsbuildinfo.json')],
  });
}
if (touchedCode) {
  checks.push({
    name: 'lint',
    cmd: BIN('eslint'),
    // --cache-strategy content, NOT the default 'metadata': metadata keys the cache on mtime+size,
    // so an edit that preserves both (a same-length change, a checkout, a script-written file) would
    // be served from cache and reported clean. A faster check that can miss a real error is worse
    // than the slow one it replaced — content hashes cost almost nothing here.
    args: ['.', '--suppressions-location', '.eslint-baseline.json', '--pass-on-unpruned-suppressions',
           '--quiet', '--cache', '--cache-strategy', 'content', '--cache-location', resolve(CACHE, 'eslint/')],
  });
}
if (touchedSrc) {
  checks.push({ name: 'test', cmd: BIN('vitest'), args: ['run'] });
}

if (checks.length === 0) {
  if (!COMPACT) console.log('verify: nothing to check (no code touched).');
  process.exit(0);
}

const run = (check) =>
  new Promise((done) => {
    const started = Date.now();
    let out = '';
    const child = spawn(check.cmd, check.args, { cwd: ROOT, env: process.env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => done({ ...check, code: 1, out: String(err), secs: 0 }));
    child.on('close', (code) =>
      done({ ...check, code, out, secs: Math.round((Date.now() - started) / 1000) }),
    );
  });

// Keep only the lines that say what broke — a full vitest or eslint dump buries the one useful line.
// ESC written via fromCharCode, not a \x1b literal — a raw control character in a regex is a lint
// error (no-control-regex), and escaping the rule here would be sillier than escaping the byte.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s) => s.replace(ANSI, '');
function salient(check) {
  const lines = strip(check.out).split('\n');
  if (check.name === 'astro check' || check.name === 'tsc') {
    return lines.filter((l) => /error ts\(|error TS|^- \d+ error/.test(l)).slice(0, 12);
  }
  if (check.name === 'lint') return lines.filter(Boolean).slice(-25);
  return lines.filter((l) => /✗|×|FAIL|Tests {2}|Test Files {2}/.test(l)).slice(0, 15);
}

const results = await Promise.all(checks.map(run));
const failed = results.filter((r) => r.code !== 0);

if (failed.length === 0) {
  if (!COMPACT) {
    console.log(`verify: green — ${results.map((r) => `${r.name} ${r.secs}s`).join(' · ')}`);
    const skipped = ['astro check', 'lint', 'test'].filter((n) => !results.some((r) => r.name === n));
    if (skipped.length) console.log(`        skipped (untouched): ${skipped.join(', ')} — \`npm run verify -- --all\` forces them.`);
  }
  process.exit(0);
}

for (const f of failed) {
  console.log(`\n--- ${f.name} ---`);
  const lines = salient(f);
  console.log(lines.length ? lines.join('\n') : strip(f.out).trim().split('\n').slice(-20).join('\n'));
}
process.exit(1);
