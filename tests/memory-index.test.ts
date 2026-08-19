import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The memory index budget — the same ratchet as `instructions-budget.test.ts`, on the other file
 * every session reads before it can do anything.
 *
 * `.claude-memory/MEMORY.md` is loaded into every session automatically. It has a hard load ceiling
 * of ~24.4KB, and the failure past it is not a truncation — the file is simply NOT loaded, and the
 * session starts knowing nothing about this project. Nothing looks wrong; I just silently stop
 * knowing that PayMe is superseded, that a seeder names a purge scope and never a WHERE, that
 * `git push .` from a worktree once deleted 867 files.
 *
 *     2026-08-16  20,559 bytes / 137 entries      ← 84% of the load ceiling
 *     2026-08-16  17,846 bytes / 113 entries      ← after the compression pass
 *
 * What that pass did, because it is the worked example of how to pay for a new memory: it deleted
 * no memories (all 178 files are still indexed) and no facts. It grouped the flat list into topic
 * sections, merged same-topic entries onto one line, cut titles that only restated the filename
 * beside them, and dropped hook clauses whose detail already lives in the memory file itself. Two
 * hooks had gone stale against their own files and were fixed rather than shortened: the dashboard
 * lazy panels ("DECIDED, not started" → BUILT 2026-08-11), and the order-automation carrier note,
 * still naming Sendit after the 2026-08-09 direct-courier decision replaced it.
 *
 * The floor is worth knowing before anyone squeezes harder: 178 links cost ~6.2KB in filenames and
 * link syntax alone, before a word of hook — and those filenames are quoted verbatim across
 * AI_INSTRUCTIONS.md and CLAUDE.md, so renaming them is not a lever either. Below ~17.5KB the only
 * thing left is merging memory FILES, i.e. collapsing distinct topics, which is a content decision
 * and not a formatting one. Don't do it to satisfy this number.
 *
 * So when this fails: merge same-topic index lines, or move a hook's detail down into the memory
 * file it points at. Lowering CEILING is right; raising it is not, unless the number went down.
 */
/**
 * **The ratchet, and it is now ADVISORY here rather than a red suite (owner, 2026-08-20).**
 *
 * `MEMORY.md` lives OUTSIDE every worktree — one file, symlinked, shared by every session on this
 * machine. So a session that adds one memory line reddened the verify of every other session,
 * including sessions that never touched memory and could not act on it: they see a failure about a
 * file they did not change, in a directory that is not in their tree. That is the shape that cost
 * the owner an evening — *"לא יהיה מצב שאני 5 שעות מול 3 סשנים שלא מגיבים"* — because the honest
 * response to it is to stop and trim a shared file under time pressure, which is what I did three
 * times tonight while another session was editing the same lines.
 *
 * The ratchet still matters and has not moved: the budget is the budget, and whoever ADDS a line
 * pays for it. What changed is who is told. `.claude/hooks/memory-index-budget.sh` says it to the
 * session that just wrote a memory, at the moment it wrote one — which is the only session that can
 * do anything about it — and this file now fails only on the number that is actually dangerous.
 */
const CEILING = 18_000;

/**
 * Where the suite genuinely refuses, and it is a different question from the ratchet.
 *
 * Past `LOAD_LIMIT` the harness does not truncate the index — it drops it, and a session starts
 * knowing nothing about this project while looking completely normal. `HARD_FAIL` sits well under
 * that with room for the growth one session can add between two checks, so crossing it means the
 * ratchet has been ignored for a while and not that somebody wrote one line an hour ago.
 */
const HARD_FAIL = 21_000;

/** What the harness refuses to load. The ceiling exists to keep a wide margin under this. */
const LOAD_LIMIT = 24_400;

/**
 * Where the memory repo actually is, which is not one path.
 *
 * In the main checkout it is `<repo>/.claude-memory`. In a worktree that directory does NOT exist —
 * `worktree-setup.mjs` deliberately links the harness memory path at the MAIN checkout's copy
 * instead (its own header explains why), so the only handle a worktree has is the harness path for
 * its own cwd slug. Checking both is what makes this test run in both places rather than quietly
 * skipping in exactly the tree where a session is editing memory.
 */
function findMemoryDir(): string | null {
  const inRepo = fileURLToPath(new URL('../.claude-memory/', import.meta.url));
  if (existsSync(resolve(inRepo, 'MEMORY.md'))) return inRepo;
  const slug = resolve(inRepo, '..').replace(/[^A-Za-z0-9]/gu, '-');
  const viaHarness = resolve(homedir(), '.claude', 'projects', slug, 'memory');
  return existsSync(resolve(viaHarness, 'MEMORY.md')) ? viaHarness : null;
}

// The memory repo is private, cloned by scripts/setup-claude-memory.sh — absent on a fresh checkout
// and in CI. Absent is not a failure; present-and-oversized is.
const MEMORY_DIR = findMemoryDir();

describe.skipIf(!MEMORY_DIR)('MEMORY.md — the always-loaded memory index', () => {
  const dir = MEMORY_DIR!;
  const raw = MEMORY_DIR ? readFileSync(resolve(dir, 'MEMORY.md'), 'utf8') : '';
  const bytes = Buffer.byteLength(raw, 'utf8');
  const links = [...raw.matchAll(/\]\((?<file>[a-z0-9_]+\.md)\)/gu)].map((m) => m.groups!.file);

  it(`stays under the ${HARD_FAIL.toLocaleString()}-byte hard limit`, () => {
    // The ratchet (CEILING) is the hook's job — see its note above. This is the cliff.
    expect(
      bytes,
      `MEMORY.md is now ${bytes.toLocaleString()} bytes, past the ${HARD_FAIL.toLocaleString()}-byte ` +
        `hard limit and closing on the ${LOAD_LIMIT.toLocaleString()} the harness simply REFUSES to ` +
        `load — past that a session starts with no project memory at all and nothing looks wrong. ` +
        `The ${CEILING.toLocaleString()} ratchet has been ignored for a while: merge same-topic ` +
        `entries, or move a hook's detail into the memory file it points at.`,
    ).toBeLessThanOrEqual(HARD_FAIL);
  });

  it('leaves real headroom under the load limit', () => {
    // Holding the ceiling is the job; this keeps the ceiling itself worth holding.
    expect(CEILING).toBeLessThan(LOAD_LIMIT * 0.8);
  });

  it('points only at memory files that exist', () => {
    const missing = links.filter((f) => !existsSync(resolve(dir, f)));
    expect(missing, `index lines pointing at files that are not there: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('indexes every memory file — an unlisted memory is an unread one', () => {
    // Recall runs through this index. A file nothing links to is invisible whatever it says.
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    const linked = new Set(links);
    const orphans = files.filter((f) => !linked.has(f));
    expect(orphans, `memory files missing from MEMORY.md: ${orphans.join(', ')}`).toEqual([]);
  });

  it('is an input verify.mjs actually hashes, not just one it names', () => {
    // `tests/verify-doc-inputs.test.ts` checks that MEMORY.md appears in CHECKED_DOCS — but that
    // regex filters `git ls-files`, and this file lives in a gitignored second repo that git never
    // lists. So the regex alone would claim a coverage the cache cannot deliver, and this test
    // would sit skipped-from-cache on exactly the memory-only session it exists to catch. The
    // hashing is the half that does the work; this pins it to the name.
    const verify = readFileSync(fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url)), 'utf8');
    expect(verify).toMatch(/function memoryIndexHash\(\)/u);
    expect(verify.slice(verify.indexOf('function treeHash()'))).toContain('memoryIndexHash()');
  });

  it('links each memory exactly once', () => {
    // Listed twice is one topic drifted into two hooks, which can then disagree with each other.
    const seen = new Map<string, number>();
    for (const f of links) seen.set(f, (seen.get(f) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([f, n]) => `${f} (${n}×)`);
    expect(dupes, `listed more than once: ${dupes.join(', ')}`).toEqual([]);
  });
});
