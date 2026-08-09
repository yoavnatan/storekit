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
// A real TS narrowing trap that astro check DOES catch, and whose fix is not obvious (moved here
// from AI_INSTRUCTIONS 2026-08-06, same reason as the block below): a `let` reassigned inside a
// `.forEach`, then read via `if (x)` / `x?.` right after the loop, narrows to `never` — the checker
// cannot see that the callback ran. Rewrite as `filter().map().filter(guard)` rather than casting.
//
// And when a `.astro` compile error gives no file/line — not in the dev overlay, not in astro check —
// run `npx astro build`: its [CompilerError] output carries a `Location:` with the exact file:line.
// (That one burned a whole session. Do not hand-write an AST differ to binary-search it.)
//
// THE FAILURE THAT REPORTS NOTHING AT ALL (moved here from AI_INSTRUCTIONS 2026-08-04, because this
// is the tool you reach for when it happens): Astro 7's compiler rejects an HTML comment as the
// first child right after `{expr && (` — put comments ABOVE the expression, never inside it. In a
// PAGE this fails silently in dev: the route simply stops building, so a static route falls through
// to a dynamic sibling — `/stores` began 302-ing to `/404` via `[storeSlug]` with nothing logged
// anywhere, and `astro check` still reported 0 errors. A page that suddenly 404s or redirects right
// after an edit is this, not a routing bug.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = (name) => resolve(ROOT, 'node_modules/.bin', name);
// node_modules is already gitignored, so the caches need no new ignore rule and never reach a clone.
const CACHE = resolve(ROOT, 'node_modules/.cache');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const COMPACT = argv.includes('--compact'); // hook mode: nothing on success, failures only
const NO_CACHE = argv.includes('--no-cache'); // force every check to actually run

// Resolving git off PATH is the only portable option (no fixed path across mac/linux/CI), and this
// is a local dev script: anyone who can shadow `git` on your PATH can already edit it.
// `-c core.quotePath=false`: git C-quotes any path with a non-ASCII byte ("\327\252..."), and a
// quoted name neither hashes nor exists — the hash would silently key off the wrong string. No
// tracked path is non-ASCII today; this is what keeps that from mattering the day one is.
const git = (...args) =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

// Tracked changes AND untracked files — same definition the review gate uses (.claude/hooks/
// review-state.sh); much of this repo's work sits uncommitted, so `diff HEAD` alone misses whole
// new modules.
function changedFiles() {
  try {
    const tracked = git('diff', 'HEAD', '--name-only');
    const untracked = git('ls-files', '--others', '--exclude-standard');
    return [...new Set((tracked + untracked).split('\n').filter(Boolean))];
  } catch {
    return null; // not a git repo / git unavailable — fall back to running everything
  }
}

// ── Don't run a check whose inputs are byte-identical to the last time it passed ──
//
// The measurement that forced this (2026-08-03, over the previous two days of sessions): 87% of all
// command wall-time in a session was verification, and a large share of it was the SAME tree checked
// twice — a checkpoint run, then the Stop hook's `--all` a minute later with nothing edited in
// between; or a docs edit after a green run, which changes the hook's fingerprint but cannot change
// a single check's answer. At `astro check` 84s that is a minute and a half of pure repetition per
// turn.
//
// So each check records the content hash of the tree it passed against, and skips when the tree is
// still exactly that. This is not a heuristic and it cannot go stale into a false green: identical
// inputs, identical result. It is also NOT the same thing as the tools' own caches (eslint's,
// tsc's) — those make a rerun cheaper, this makes it not happen.
//
// The hash is the true working-tree content, not mtimes: index blob hashes for every tracked file,
// plus a real `hash-object` of anything modified or untracked. `.md` and `.claude/` are excluded on
// purpose — no check reads them, and including them is what would make the session-close doc pass
// re-run the whole suite. Everything else counts, `package-lock.json` included, so a dependency
// change invalidates every marker.
//
// ⚠️ EXCEPT the docs a test actually reads, and this was a real false green (found 2026-08-04).
// `tests/instructions-integrity.test.ts` and `tests/instructions-budget.test.ts` read
// AI_INSTRUCTIONS.md, so a docs-only edit CAN turn the suite red — but excluding `.md` left the
// fingerprint identical, and `verify --all` reported green from cache without running them. That is
// precisely the "identical inputs, identical result" claim this cache is built on, broken by a file
// that was assumed to be input to nothing. `tests/verify-doc-inputs.test.ts` is the guard: it fails
// if any test reads a `.md` this regex still ignores, so the next one cannot be silent.
//
// `.claude/hooks/` and `.claude/skills/` are carved back in for the same reason, found by inspection
// the same day rather than by a failure: the integrity test asserts that every pointer in the
// always-read rules resolves, and several of them point at exactly those files — so renaming or
// deleting one would turn the suite red while this cache reported green. Both are tracked and
// stable, so counting them costs nothing; `settings.local.json` and the state that actually churns
// stay out.
//
// `CLAUDE.md` joined them on 2026-08-09, read by `tests/handoff-backup.test.ts`. It is the one page
// a freshly cloned machine loads before it knows anything else, so its restore steps are pinned
// against `.env.example` — and a pin whose check can be skipped from cache is not a pin.
const CHECKED_DOCS = /(?:^|\/)(?:AI_INSTRUCTIONS|CLAUDE)\.md$|(?:^|\/)\.claude\/(?:hooks|skills)\//;
const IRRELEVANT = /(?:(?:^|\/)\.claude\/)|(?:\.md$)/;
const relevant = (p) => p && (CHECKED_DOCS.test(p) || !IRRELEVANT.test(p));

// One `path → content hash` map for the whole tree, and nothing else. It deliberately says nothing
// about what is staged, committed or in HEAD: `git commit` moves blobs from the working tree into
// the index without changing one byte a check reads, and an earlier version keyed off the raw
// `ls-files -s` text, so every commit threw the cache away and the pre-push gate paid the full
// minute again for a tree it had already passed.
function treeHash() {
  try {
    const byPath = new Map();
    for (const line of git('ls-files', '-s').split('\n')) {
      // "<mode> <sha> <stage>\t<path>"
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const path = line.slice(tab + 1);
      if (relevant(path)) byPath.set(path, line.slice(0, tab).split(' ')[1]);
    }
    // Working tree vs index, plus untracked: for these the index hash is not what a check will read.
    const dirty = [...new Set([
      ...git('diff', '--name-only').split('\n'),
      ...git('ls-files', '--others', '--exclude-standard').split('\n'),
    ].filter(relevant))].sort();
    const present = dirty.filter((f) => existsSync(resolve(ROOT, f)));
    // A deleted file simply leaves the map — restoring it puts the same entry back, so the hash
    // returns to exactly where it was.
    for (const f of dirty) if (!present.includes(f)) byPath.delete(f);
    if (present.length) {
      // `--` so a file whose name begins with a dash is a path and not a flag.
      const hashes = git('hash-object', '--', ...present).split('\n');
      present.forEach((f, i) => byPath.set(f, hashes[i]));
    }
    const digest = createHash('sha256');
    for (const path of [...byPath.keys()].sort()) digest.update(`${path} ${byPath.get(path)}\n`);
    return digest.digest('hex');
  } catch {
    return null; // no git / no hash → every check runs, which is the safe direction
  }
}

const HASH = NO_CACHE ? null : treeHash();
const MARKER = HASH && resolve(CACHE, 'verify', `${HASH}.json`);

function passedBefore() {
  if (!MARKER || !existsSync(MARKER)) return [];
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8'));
  } catch {
    return [];
  }
}

/** Union with what an earlier (possibly narrower) run recorded, so a scoped pass helps `--all`. */
function recordPassed(names) {
  if (!MARKER) return;
  try {
    mkdirSync(resolve(CACHE, 'verify'), { recursive: true });
    writeFileSync(MARKER, JSON.stringify([...new Set([...passedBefore(), ...names])]));
  } catch { /* the cache is an optimisation; failing to write one must never fail the run */ }
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
// The one check no other check can stand in for. Everything above reads FILES; the app reads a
// DATABASE, and the test suite builds its own from migrations/ — so a migration written but never
// applied leaves the whole suite green while every page that touches the table throws
// `column X does not exist`. Exactly that shipped a broken dev site on 2026-08-04 (0008_product_brand).
// Cheap (one query), and it names the fix. `--env-file-if-exists` mirrors the db:migrate npm script,
// since DATABASE_URL lives in .env rather than the shell.
if (has(/^migrations\//)) {
  checks.push({
    name: 'db migrations',
    cmd: process.execPath,
    args: ['--env-file-if-exists=.env', resolve(ROOT, 'scripts/db-migrate.mjs'), '--check'],
  });
}

// `astro check` is a superset of `tsc`, so a recorded pass of the bigger one satisfies the smaller.
const already = passedBefore();
const cached = (name) => already.includes(name) || (name === 'tsc' && already.includes('astro check'));
const fromCache = checks.filter((c) => cached(c.name)).map((c) => c.name);
const toRun = checks.filter((c) => !cached(c.name));

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

const results = await Promise.all(toRun.map(run));
const failed = results.filter((r) => r.code !== 0);

if (failed.length === 0) {
  recordPassed(checks.map((c) => c.name));
  if (!COMPACT) {
    const ran = results.map((r) => `${r.name} ${r.secs}s`).join(' · ');
    console.log(`verify: green — ${ran || 'nothing to re-run'}`);
    // Both kinds of not-running are named. Silence is what would turn either into "it all passed".
    if (fromCache.length) console.log(`        unchanged since it last passed: ${fromCache.join(', ')} — \`npm run verify -- --no-cache\` re-runs them.`);
    const skipped = ['astro check', 'lint', 'test'].filter((n) => !checks.some((c) => c.name === n));
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
