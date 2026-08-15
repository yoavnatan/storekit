/**
 * The area-audit table and its machine half say the same thing.
 *
 * The table (`.claude/skills/review-diff/SKILL.md`) is the narrative — what each area is, what its
 * outside contract is, what the last audit found. `.claude/audit-areas.json` is what a script can
 * act on: which files each row is ABOUT, and the day it was last marked done. Two sources for one
 * fact is how they drift, so this keeps them in lockstep and lets the prose stay prose.
 *
 * It also checks that every watched path still exists, which is the failure that would be silent:
 * a rename empties a row's watch list, `audit:drift` then reports that nothing has moved under it,
 * and an area that changed every day reads as freshly audited forever.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const AREAS = JSON.parse(readFileSync(join(ROOT, '.claude/audit-areas.json'), 'utf8')).areas as
  { id: number; title: string; audited: string | null; paths: string[] }[];
const TABLE = readFileSync(join(ROOT, '.claude/skills/review-diff/SKILL.md'), 'utf8');

/** `| 7 | **Dashboard: …** | ✅ 2026-08-09 · … |` → { 7: '✅ 2026-08-09' } */
function tableRows(): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of TABLE.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|(.*)$/.exec(line);
    if (!m) continue;
    rows.set(Number(m[1]), m[2]!);
  }
  return rows;
}

describe('the area-audit table and audit-areas.json agree', () => {
  it('covers exactly the same rows', () => {
    const inTable = [...tableRows().keys()].sort((a, b) => a - b);
    const inJson = AREAS.map((a) => a.id).sort((a, b) => a - b);
    expect(inJson).toEqual(inTable);
  });

  it('agrees on which rows are done, and on the date', () => {
    const rows = tableRows();
    for (const area of AREAS) {
      const cells = rows.get(area.id)!;
      const done = /\|\s*✅\s*(\d{4}-\d{2}-\d{2})/.exec(cells);
      // `partial` counts as not-yet-audited here on purpose: a row that is half read cannot be
      // measured for drift against a date it does not have.
      expect(area.audited, `row ${area.id}`).toBe(done ? done[1] : null);
    }
  });

  it('watches paths that exist', () => {
    const missing: string[] = [];
    for (const area of AREAS) {
      for (const p of area.paths) if (!existsSync(join(ROOT, p))) missing.push(`row ${area.id}: ${p}`);
    }
    expect(missing).toEqual([]);
  });

  it('gives every row something to watch', () => {
    // A row with no paths silently reports "nothing moved" forever, which is worse than no row.
    expect(AREAS.filter((a) => !a.paths.length).map((a) => a.id)).toEqual([]);
  });
});
