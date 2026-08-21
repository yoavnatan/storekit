#!/usr/bin/env node
// One command for the mid-session checkpoint: `npm run verify`.
//
// Why this exists. AI_INSTRUCTIONS.md asks for `astro check`, `npm run lint` and `npm test` after
// every code step. Run one after another, uncached, that is ~115s of pure waiting per checkpoint
// (measured 2026-07-31: tsc 9s / astro check 39s / lint 37s / vitest 30s) — and a session with eight
// checkpoints spends a quarter of an hour watching them. Three things fix that, none of which weaken
// the check:
//   • Concurrency — they are independent read-only passes, so the cost is the slowest, not the sum.
//     Serialising the test step away from the others was TRIED and measured WORSE on 2026-08-21
//     (471s against 407s, and still red), so contention between the checks is NOT what kills a
//     vitest worker here. `const results` at the foot of this file has that whole hunt.
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
// ⚠️ A FULL `--all` CHECKPOINT IS CPU-BOUND, NOT TOOL-BOUND — don't try to speed it up by shrinking
// one check (measured 2026-08-09, and this is the discarded attempt so it is not re-walked). Warm
// and alone, `astro check` is 88s over the 649 files the root tsconfig's `**/*` gives it; pointed at
// a src-only tsconfig it is 398 files and **40s**. That looks like half a checkpoint saved. It is
// not: `tsc` then has to run alongside it to keep `tests/` and `scripts/` checked, and with vitest
// already saturating every core the two just take turns. Measured A/B on the same tree, same
// machine, uncached: old shape 84s astro + 10s lint + 56s test = **1:24.7 wall / 351s CPU**; split
// shape 82s astro + 14s tsc + 11s lint + 61s test = **1:22.6 wall / 363s CPU**. Two seconds, for
// more CPU and a second tsconfig to keep in sync. The only thing that would actually move this
// number is doing less total work — fewer checks, or a smaller test suite — not re-dividing it.
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
// THE ERRORS THAT ALL POINT AT THE WRONG PLACE — `as const` after `Astro.props` in a COMPONENT
// (2026-08-11, and it cost most of an hour). In a `.astro` COMPONENT's frontmatter, an `as const`
// assertion written anywhere BELOW `const { … } = Astro.props;` makes the compiler stop wiring
// `interface Props` to `Astro.props`. Nothing says so. What you get instead is every prop typed
// `unknown` and a page of ts(7006) "implicitly has an 'any' type" / ts(18046) "'x' is of type
// 'unknown'" on lines that are all perfectly correct — including generic helpers like
// `paginate(props.rows)` suddenly returning `unknown[]`. The tell is an IDE hint saying
// **"'Props' is declared but never used"** on a component that plainly uses it; astro check does
// not print that hint, so from the terminal there is no clue at all.
//   · Reproduce: add `const P = ['x'] as const;` under the destructure. Move the same line ABOVE
//     `interface Props` and everything goes green — it is POSITION, not the assertion.
//   · Fix: annotate instead of asserting (`const X: readonly Foo[] = [...]`). `as const` inside a
//     callback in the MARKUP is unaffected, which is why other components get away with it.
//   · Do NOT chase the reported lines. Nothing is wrong with them, and adding `: any` to silence
//     them buries a working `Props`. Worked example: components/dashboard/PayoutsPanel.astro.
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
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { withWorkerShare, workerBudget } from './lib/test-concurrency.mjs';
import { starvedFiles, starvedWorker, strip } from './lib/starved-workers.mjs';

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
// `MEMORY.md` joined on 2026-08-16, read by `tests/memory-index.test.ts`, and it is the one entry
// here that git cannot supply: it lives in the private memory repo, which is gitignored and is not
// this checkout at all, so it appears in no `ls-files` output and no amount of regex would reach it.
// `memoryIndexHash()` below hashes it directly for that reason. Listing it here is still required —
// `tests/verify-doc-inputs.test.ts` reads THIS regex to decide whether the doc is covered, and a
// name missing from it reads as "no check depends on this file".
const CHECKED_DOCS = /(?:^|\/)(?:AI_INSTRUCTIONS|CLAUDE|MEMORY)\.md$|(?:^|\/)\.claude\/(?:hooks|skills)\//;
const IRRELEVANT = /(?:(?:^|\/)\.claude\/)|(?:\.md$)/;
const relevant = (p) => p && (CHECKED_DOCS.test(p) || !IRRELEVANT.test(p));

// One `path → content hash` map for the whole tree, and nothing else. It deliberately says nothing
// about what is staged, committed or in HEAD: `git commit` moves blobs from the working tree into
// the index without changing one byte a check reads, and an earlier version keyed off the raw
// `ls-files -s` text, so every commit threw the cache away and the pre-push gate paid the full
// minute again for a tree it had already passed.
/**
 * The memory index's content hash, or null when there is no memory repo (a fresh clone, CI).
 *
 * It is a real input to `tests/memory-index.test.ts` and it is invisible to git, so without this the
 * cache would report green on an index that had just grown past its ceiling. Two paths because a
 * worktree has no `.claude-memory/` of its own — `worktree-setup.mjs` links the harness memory path
 * at the main checkout's copy instead, and that link is the only handle a worktree has.
 *
 * It costs nothing in practice: a session that touched code has already changed the hash, and the
 * one case where this adds a full run — a session that ONLY wrote memory — is exactly the case the
 * budget test exists to catch.
 */
function memoryIndexHash() {
  const slug = ROOT.replace(/[^A-Za-z0-9]/gu, '-');
  const candidates = [
    resolve(ROOT, '.claude-memory', 'MEMORY.md'),
    resolve(homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return null;
}

function treeHash() {
  try {
    const byPath = new Map();
    const memory = memoryIndexHash();
    if (memory) byPath.set('.claude-memory/MEMORY.md', memory);
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

/**
 * The installed dependency tree, as one hash — the second half of the marker's key.
 *
 * The tree hash covers `package-lock.json`, i.e. what SHOULD be installed. It cannot see what IS:
 * an interrupted `npm ci`, a hand-deleted package, a worktree whose setup died halfway. That did
 * not matter while each checkout kept its own markers, because a checkout could only ever inherit
 * its own green. It matters the moment they are shared, so the key carries it.
 *
 * `node_modules/.package-lock.json` is npm's own record of what it actually laid down, and it is
 * written deterministically from the lockfile — so two checkouts installed from the same lockfile
 * agree byte for byte and share, and anything else simply does not. Missing file → its own bucket,
 * which is today's behaviour and the safe direction.
 */
function installHash() {
  try {
    return createHash('sha256')
      .update(readFileSync(resolve(ROOT, 'node_modules/.package-lock.json')))
      .digest('hex')
      .slice(0, 16);
  } catch {
    return 'noinstall';
  }
}

/**
 * MACHINE-WIDE, not per checkout (2026-08-19). The marker records "these checks passed against this
 * exact content", and that sentence is about the CONTENT — it was never about the directory the
 * content happened to be sitting in. Keeping the markers under each checkout's `node_modules` made
 * it about the directory, and the cost was one whole suite per push: a worktree verifies green,
 * fast-forwards into main, and `pre-push` then runs the identical suite against the identical bytes
 * from scratch, because main had never seen that hash. With three sessions live that is the wait
 * the owner hit on 2026-08-19 ("waiting hours"), and it is pure repetition — the same argument the
 * paragraph above makes about `git commit` throwing the cache away, one level up.
 *
 * The key is `<tree content>-<installed deps>`, so sharing can only ever happen between checkouts
 * that would run the identical checks over the identical inputs. `tmpdir()` because this is an
 * optimisation and losing it costs a re-run, not correctness — the same reasoning, and the same
 * neighbourhood, as `scripts/lib/test-concurrency.mjs`.
 */
const STATE = resolve(tmpdir(), 'storekit-verify-state');
const HASH = NO_CACHE ? null : treeHash();
const MARKER = HASH && resolve(STATE, `${HASH}-${installHash()}.json`);

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
    mkdirSync(STATE, { recursive: true });
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

// The same class as the migration gate above, through the other door. `showcase:images` writes URLs
// to the manifest and `seed:showcase` writes them to the DB — two commands, and the storefront reads
// only the second. A session that generates images and stops leaves paid-for pictures that no page
// will ever show, silently. Exactly that happened on 2026-08-17 (a remade banner, a new avatar and
// 22 re-rolled heroes, all stranded), and the owner found it by looking at the shop, which is the
// only thing that could have found it. See scripts/showcase-seed-check.mjs.
if (has(/^scripts\/lib\/showcase\/image-manifest\.json$/)) {
  checks.push({
    name: 'showcase images seeded',
    cmd: process.execPath,
    args: ['--env-file-if-exists=.env', resolve(ROOT, 'scripts/showcase-seed-check.mjs'), '--quiet'],
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

/**
 * **Every check except `test` yields the CPU, and that one word is a fix on its own.**
 *
 * `test-concurrency.mjs` bounds what the test runs demand between them. It cannot see the steps
 * beside them, and those are not small: `astro check` measures 54-140s of full-CPU work on this
 * codebase — 85s in the 2026-08-20 measurement — and while it runs, some other session's vitest is
 * forking workers. A worker that does not answer inside its boot window is not a slow test, so no
 * `testTimeout` reaches it; the run dies with `[vitest-pool]: Failed to start forks worker` and
 * every assertion that ran having passed. Three sessions hit that six times over 2026-08-19/20, and
 * each one costs a full re-run, which puts another suite on the machine and makes the next session's
 * boot worse. That is the loop the owner meant when he said two sessions still wedge.
 *
 * Lowering the others is the only direction available — raising a priority needs root — and `nice`
 * is inherited by children, so one word covers `astro check`'s whole process tree. It costs the
 * yielding checks nothing that matters: they have no wall-clock deadline inside them, which is the
 * same property that always kept them out of the old lock. It gives the one step whose failure mode
 * IS a deadline the cores it needs at the moment it needs them.
 */
const NICE = existsSync('/usr/bin/nice') ? '/usr/bin/nice' : null;

const spawnCheck = (check) =>
  new Promise((done) => {
    const started = Date.now();
    let out = '';
    const yields = NICE && check.name !== 'test';
    const child = yields
      ? spawn(NICE, ['-n', '10', check.cmd, ...check.args], { cwd: ROOT, env: process.env })
      : spawn(check.cmd, check.args, { cwd: ROOT, env: process.env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => done({ ...check, code: 1, out: String(err), secs: 0 }));
    child.on('close', (code) =>
      done({ ...check, code, out, secs: Math.round((Date.now() - started) / 1000) }),
    );
  });

/**
 * **The test step takes a share of the machine; nothing waits for anything.**
 *
 * This replaced a machine-wide lock on 2026-08-20. The lock stopped several sessions' suites from
 * over-subscribing the CPU, which was a real failure — six suites once asked for six machines and
 * put a different random subset of database-backed files past the 30s ceiling every run. It stopped
 * it by letting exactly one suite exist at a time, and that is what made the machine unusable at the
 * scale the owner works at: a measured `verify --all` took 8m40s of which five minutes was queueing,
 * at 123% CPU on twelve cores. `scripts/lib/test-concurrency.mjs` carries the full argument and the
 * measurement.
 *
 * So the bound stayed and the queue went. Every live run claims a share of one machine-wide worker
 * budget, and `--maxWorkers` on the command line overrides `vitest.config.ts`'s own cap for this run
 * only — the config keeps the four-worker default for anyone running `npm test` by hand.
 */
const run = async (check) => {
  if (check.name !== 'test') return spawnCheck(check);
  const { workers, release } = await withWorkerShare((share, runs) => {
    // Said once, and only when the machine is actually shared. A run that is slower than usual
    // because it is one of four should say so; a lone run should print nothing.
    if (!COMPACT && runs > 1) {
      console.log(`verify: ${runs} test runs on this machine — taking ${share} of ${workerBudget()} workers.`);
    }
  });
  const sized = { ...check, args: [...check.args, '--maxWorkers', String(workers)] };
  try {
    const first = await spawnCheck(sized);
    if (first.code === 0 || !starvedWorker(first.out)) return first;
    // ── A red run with nothing red in it is retried ONCE, out loud ──
    //
    // Only this exact shape: a non-zero exit where the output names a worker that never started and
    // no line names a failing test. That is the machine, not the code — every assertion that ran
    // passed, and the rest never ran at all. Re-running is what a person does here anyway (the owner
    // did it three times in one session, and a peer session three more), so the choice is not
    // whether to re-run but whether a human has to notice first.
    //
    // It cannot mask a real failure: one failing assertion anywhere puts a FAIL line in the output
    // and the red returns immediately. It cannot loop: one retry, then whatever it says stands. And
    // it is never silent, because a gate that quietly re-runs itself is how a genuinely flaky suite
    // stays invisible.
    //
    // ── And it re-runs only the FILES that never started, not the suite (2026-08-21) ──
    //
    // The whole-suite re-run is what actually cost the owner his evenings, and the arithmetic is
    // brutal: a full `--all --no-cache` measured 407s on a quiet machine, of which ~200s was the
    // second attempt at 4784 tests that had already all passed. Four full runs were measured that
    // day and every one of them lost a worker — a different file each time — so this is not a rare
    // path, it is the normal one. Two sessions before this one went looking for the cause (another
    // session's type-check; then this run's own siblings) and both were wrong: serialising the test
    // step away from every other check measured 471s and still red, and so did moving the child's
    // output off its pipe. What the failing runs share is a machine at the edge of its memory —
    // 7-19MB free at the peak — and that is not going to be argued away on a 16GB laptop. The full
    // hunt, with every number, is at `const results` at the foot of this file.
    //
    // So the cost is what changes. The starved files are named in the error, they are the only ones
    // that did not run, and re-running just them is seconds instead of minutes. Nothing is skipped:
    // every file still runs, and if the names cannot be parsed the full re-run happens exactly as
    // before. A second starvation in the narrow re-run is reported as the red it is, rather than
    // being chased around a third time.
    const starved = starvedFiles(first.out, existsSync);
    if (!COMPACT) {
      console.log(starved.length
        ? `verify: red with no failing test — ${starved.length} file(s) never started. Re-running only those…`
        : 'verify: red with no failing test — a worker never started. Re-running the suite once…');
    }
    // **The narrow re-run keeps the same `--maxWorkers` share.** Its file list is usually shorter
    // than the share, so this changes nothing most of the time — but "usually" is not a bound, and
    // a run that lost several workers at once would otherwise burst to `vitest.config.ts`'s default
    // of four while another session's suite is holding half the budget. The claim taken above is a
    // share, not the machine.
    const second = await spawnCheck(starved.length
      ? { ...sized, args: [...sized.args, ...starved] }
      : sized);
    if (second.code !== 0) return second;
    // The first attempt's PASSES are the ones being reported — the re-run only covers what it
    // missed — so the output kept is the first one, with the re-run's time added to it. Keeping the
    // narrow run's summary instead would report "3 test files" for a green suite of 380.
    return { ...first, code: 0, out: first.out, secs: second.secs + first.secs, retried: true };
  } finally { release(); }
};

// Keep only the lines that say what broke — a full vitest or eslint dump buries the one useful line.
// `strip` comes from `lib/starved-workers.mjs`, which needs the same ANSI removal to read a starved
// run and is the module that now owns it.
function salient(check) {
  const lines = strip(check.out).split('\n');
  if (check.name === 'astro check' || check.name === 'tsc') {
    return lines.filter((l) => /error ts\(|error TS|^- \d+ error/.test(l)).slice(0, 12);
  }
  if (check.name === 'lint') return lines.filter(Boolean).slice(-25);
  // ── A test step that failed with NOTHING failing (2026-08-20) ──
  //
  // The summary lines match this filter, so a run where every assertion passed and vitest still
  // exited non-zero printed "Tests 4587 passed" under a FAILED header and hid the one line that
  // said why — `[vitest-pool]: Failed to start forks worker`, or a worker that never answered.
  // The owner met this three times in one session and each time it read as "the suite is red for
  // no reason", which is the most expensive kind of report: it costs a re-run and teaches nobody.
  //
  // So the summary alone is not enough to explain a failure. When no line names a failing TEST,
  // return nothing and let the caller print the raw tail, which is where the real error is.
  const failing = lines.filter((l) => /✗|×|FAIL/.test(l));
  if (!failing.length) return [];
  return lines.filter((l) => /✗|×|FAIL|Tests {2}|Test Files {2}/.test(l)).slice(0, 15);
}

/**
 * **The checks run together — and the two remedies that were TRIED and measured are recorded here so
 * they are not tried a third time** (2026-08-21).
 *
 * The test step kept dying on a worker that never started, which reads exactly like contention, so
 * two obvious cures were built and measured on a quiet machine against the same tree:
 *
 *     concurrent, as it has always been ......................... 407.2s, red
 *     every other check first, then vitest with the machine ..... 471.0s, red
 *     concurrent, child output to a FILE instead of a 64KB pipe .. 418.7s, red
 *     the same suite run by hand, twice ......................... 136.8s and 152.9s, GREEN
 *
 * So it is neither the sibling checks nor back-pressure on the pipe, and the hand-run greens are two
 * samples of something the full runs failed four times out of four — enough to say the failure is
 * frequent and probabilistic, not enough to say the hand-run is immune. What the numbers do agree on
 * is the machine's memory: free RAM measured 7-19MB at the peak of every failing run against
 * 103-866MB in the green ones, on a 16GB laptop that is also carrying a browser, an editor and
 * several sessions. That is not going to be argued away from inside this script.
 *
 * **So the cause was left alone and the COST was fixed instead** — see the retry in `run` above,
 * which re-runs the files that never started rather than the 4784 tests that already passed. The
 * same `--all --no-cache` that measured 407s red measured 143.5s green after it.
 */
const results = await Promise.all(toRun.map(run));
const failed = results.filter((r) => r.code !== 0);

if (failed.length === 0) {
  recordPassed(checks.map((c) => c.name));
  if (!COMPACT) {
    const ran = results.map((r) => `${r.name} ${r.secs}s`).join(' · ');
    console.log(`verify: green — ${ran || 'nothing to re-run'}`);
    // Both kinds of not-running are named. Silence is what would turn either into "it all passed".
    if (fromCache.length) console.log(`        unchanged since it last passed: ${fromCache.join(', ')} — \`npm run verify -- --no-cache\` re-runs them.`);
    // A green that took two attempts is still a green, but it is not the same event, and reporting
    // it as one would hide a suite that has started needing the retry every time.
    if (results.some((r) => r.retried)) console.log('        the test step needed its one retry — the first attempt lost a worker to the machine, not to a test.');
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
