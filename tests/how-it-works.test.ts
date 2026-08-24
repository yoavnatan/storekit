/**
 * `HOW_IT_WORKS.md` — the mechanical half of keeping it true.
 *
 * The document exists because a session quoted the owner a checklist line that had stopped being
 * true five days earlier. **This test cannot prevent that**, and pretending otherwise would be the
 * more dangerous outcome: no test can decide whether a sentence still describes the code. What it
 * CAN do is refuse the cheaper failure — a file renamed, a script removed, an environment variable
 * gone — which is what turns a document from partly stale into untrustworthy.
 *
 * The line that got it wrong would still have passed here, because `seed:reviews` still existed;
 * only its behaviour had changed. That is stated plainly in the document itself, next to the rule
 * that actually covers it: change a behaviour, grep the file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const DOC = readFileSync('HOW_IT_WORKS.md', 'utf8');

describe('every module HOW_IT_WORKS.md names still exists', () => {
  it('resolves each `lib/…` and `pages/…` reference', () => {
    // Backticked paths only — prose mentions a module by bare name all the time, and demanding a
    // file for every capitalised word would make the guard noisy enough to be switched off.
    const referenced = [...DOC.matchAll(/`((?:lib|pages|components|config|scripts)\/[\w[\]./-]+\.(?:ts|astro))/g)]
      .map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(15);
    const missing = [...new Set(referenced)].filter((p) => !existsSync(`src/${p}`));
    expect(missing).toEqual([]);
  });

  it('resolves each root-level document it points at', () => {
    const docs = [...DOC.matchAll(/`([A-Z_]+\.md)`/g)].map((m) => m[1]!);
    expect(docs.length).toBeGreaterThan(0);
    expect([...new Set(docs)].filter((f) => !existsSync(f))).toEqual([]);
  });
});

describe('every environment variable it names is read somewhere in src/', () => {
  it('names no switch the code has stopped looking at', async () => {
    const { execSync } = await import('node:child_process');
    const vars = [...DOC.matchAll(/`([A-Z][A-Z0-9_]{4,})(?:=\d)?`/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(0);
    const missing = [...new Set(vars)].filter((v) => {
      // `grep -rl` over src/ — an env var this document tells the owner to set, that nothing reads,
      // is operational advice that silently does nothing. Exactly the class of the line that
      // started all this, in the one form a machine can catch.
      try {
        execSync(`grep -rlF ${JSON.stringify(v)} src/`, { stdio: 'pipe' });
        return false;
      } catch { return true; }
    });
    expect(missing).toEqual([]);
  });
});

describe('the state markers stay meaningful', () => {
  it('uses only the three the document defines', () => {
    // A fourth marker invented in passing turns the one column that says "is this real today" into
    // prose again. Three states, defined at the top of the file, and no others.
    // `⚠️` is TWO code points — U+26A0 plus the U+FE0F variation selector — so a character class
    // matches the warning sign alone and the set never equals the literal you wrote. Matching the
    // selector explicitly is the difference between a guard and a puzzle.
    const markers = [...DOC.matchAll(/✅|🔶|⚠️?/gu)].map((m) => m[0].replace('️', ''));
    expect(markers.length).toBeGreaterThan(20);
    // Code-point order, not the order they are written in the document — `⚠` (U+26A0) sorts before
    // `✅` (U+2705) before `🔶` (U+1F536).
    expect([...new Set(markers)].sort()).toEqual(['⚠', '✅', '🔶']);
  });

  it('still admits to what is unbuilt', () => {
    // A document that has quietly become all-green is a document nobody updated when something
    // slipped. This is a floor, not a target: when the last 🔶 genuinely goes, delete this test in
    // the same change that removes it, deliberately.
    expect(DOC).toContain('🔶');
    expect(DOC).toContain('refund_settled');
  });
});

describe('the always-read instructions point at it', () => {
  it('is announced where a session will actually meet it', () => {
    // The failure mode this closes: a document that is correct, maintained, and read by nobody
    // because nothing at session start mentions it.
    const instructions = readFileSync('AI_INSTRUCTIONS.md', 'utf8');
    expect(instructions).toContain('HOW_IT_WORKS.md');
  });
});
