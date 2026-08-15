#!/usr/bin/env node
/**
 * Which area audits have gone STALE — i.e. the code under them moved after the day they were
 * marked done.
 *
 * The owner asked (2026-08-16) whether the area audits should be re-run periodically, and answered
 * his own question in the asking: on a schedule you never finish, and you spend most of the runs
 * re-reading code nobody touched. The version that finishes is this one — a ✅ is a statement about
 * the code that existed on that date, so it stops being one the moment that code changes.
 *
 * It is not hypothetical. Row 7 audited the dashboard's forms on 2026-08-09; the panel-loading model
 * underneath them was replaced on 08-11; the row still read ✅ while five separate bugs came out of
 * exactly that change, every one of them found by the owner rather than by us.
 *
 * Reports, never blocks: this is a reading list, and a check that fails the build for "an area is
 * due" is one people learn to skip. `--json` for the session-start hook.
 */
import { git } from './lib/run.mjs';
import { readFileSync } from 'node:fs';

const AREAS = JSON.parse(readFileSync(new URL('../.claude/audit-areas.json', import.meta.url), 'utf8')).areas;
const asJson = process.argv.includes('--json');
/** `--top`: the three most-drifted rows, one line each, for the session-start hook. */
const asTop = process.argv.includes('--top');

/** Commits touching this area since it was audited — the answer git already has. */
function movedSince(area) {
  if (!area.audited) return null;               // never audited; not drift, just open
  const out = git('log', `--since=${area.audited}`, '--format=%h', '--name-only', '--', ...area.paths);
  const lines = out.split('\n').filter(Boolean);
  const commits = lines.filter((l) => /^[0-9a-f]{7,}$/.test(l)).length;
  const files = new Set(lines.filter((l) => l.includes('/') || l.includes('.')));
  return { commits, files: files.size };
}

const open = [];
const stale = [];
for (const area of AREAS) {
  const moved = movedSince(area);
  if (moved === null) { open.push(area); continue; }
  if (moved.commits > 0) stale.push({ ...area, ...moved });
}

if (asTop) {
  for (const a of stale.sort((x, y) => y.files - x.files).slice(0, 3)) {
    // Ranked by FILES, not commits: one commit touching nine files of an area is a bigger claim on
    // a re-read than nine commits touching one.
    console.log(`  row ${a.id} — ${a.title}`);
    console.log(`         ${a.files} file(s) changed since ${a.audited}`);
  }
} else if (asJson) {
  console.log(JSON.stringify({ open: open.map((a) => a.id), stale: stale.map((a) => ({ id: a.id, commits: a.commits, files: a.files })) }));
} else {
  const fresh = AREAS.length - open.length - stale.length;
  console.log(`area audits — ${AREAS.length} areas: ${fresh} still current, ${stale.length} stale, ${open.length} never audited\n`);
  if (stale.length) {
    console.log('STALE — audited, then the code under them moved:');
    for (const a of stale.sort((x, y) => y.files - x.files)) {
      console.log(`  ${String(a.id).padStart(2)}. ${a.title}`);
      console.log(`      audited ${a.audited} · ${a.commits} commit(s), ${a.files} file(s) since`);
    }
    console.log('');
  }
  if (open.length) {
    console.log('NEVER AUDITED:');
    for (const a of open) console.log(`  ${String(a.id).padStart(2)}. ${a.title}`);
    console.log('');
  }
  console.log('Table + what "audited" requires: .claude/skills/review-diff/SKILL.md');
}
