#!/usr/bin/env node
/**
 * Create the next migration file, named so that two sessions can never collide.
 *
 * ── The problem this removes ──
 *
 * Migrations used to be numbered `0001…0041`, i.e. from a single global counter, and this repository
 * runs several Claude sessions at once in separate git worktrees. A worktree isolates FILES; it does
 * not isolate a counter. So two sessions writing a migration on the same afternoon both looked at
 * `migrations/`, both saw `0037` as the last one, and both wrote `0038`. That is not a mistake either
 * of them made — it is the only thing either of them COULD do.
 *
 * On 2026-08-17 the owner lost most of an evening to exactly this: one session's `0038` sat applied in
 * the shared development database while its file lived in an abandoned worktree, so every other
 * session's `db-migrate --check` refused the whole tree; the session that hit it renumbered its own
 * file, had to clear its own ledger row to do so, and a numbering-gap guard then failed because the
 * number it had moved away from was now missing. Three symptoms, one cause.
 *
 * ── The fix ──
 *
 * A timestamp, to the second: `20260818_214233_return_admin_award.sql`. Two sessions cannot produce
 * the same name unless they run this command in the very same second, and even then the second one is
 * told rather than silently overwriting.
 *
 * Nothing else has to change. `db-migrate.mjs` runs files in sorted filename order; `0`-prefixed
 * legacy names sort before `2`-prefixed ones, and timestamps sort chronologically among themselves.
 * The run order is still "oldest first" — it is simply no longer a number somebody has to claim.
 *
 * The existing 41 files keep their numbers. Renaming an applied migration would orphan its ledger row
 * on every machine that has already run it, which is the exact failure this is meant to end.
 *
 *   npm run db:new -- return_admin_award
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'migrations');

/**
 * The name a migration gets, as a pure function — exported so the guard that VALIDATES the shape can
 * check this against it. The two are deliberately not merged: `migration-ledger.test.ts` states the
 * shape independently, because its job is to catch a file somebody named by hand, and a guard reading
 * its rule from the thing it guards asserts nothing. What the test does instead is confirm that these
 * two independent statements agree — which is what stops a rename here from silently outdating it.
 *
 * The slug is normalised rather than trusted: it becomes a filename AND the ledger's primary key, so
 * anything outside `[a-z0-9_]` is collapsed — which also makes a path separator or a `..` impossible
 * to smuggle in through the argument.
 */
export function migrationFileName(raw, when = new Date()) {
  const slug = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!slug) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  // Local time, deliberately: the owner reads these names, and a file he wrote at nine in the evening
  // should not carry tomorrow's date because UTC has already rolled over.
  const stamp = `${when.getFullYear()}${p2(when.getMonth() + 1)}${p2(when.getDate())}`
    + `_${p2(when.getHours())}${p2(when.getMinutes())}${p2(when.getSeconds())}`;
  return `${stamp}_${slug}.sql`;
}

// Run as a CLI only when this file IS the command — importing it for `migrationFileName` must not
// create a file as a side effect, which is exactly what a test doing so would have done.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = process.argv.slice(2).join(' ').trim();
  if (!raw) {
    console.error('usage: npm run db:new -- <short_name>');
    console.error('   eg: npm run db:new -- return_admin_award');
    process.exit(1);
  }

  const name = migrationFileName(raw);
  if (!name) {
    console.error(`"${raw}" leaves nothing usable — letters and digits, please.`);
    process.exit(1);
  }

  const file = path.join(DIR, name);
  if (fs.existsSync(file)) {
    console.error(`${name} already exists — you are inside the same second as another run. Try again.`);
    process.exit(1);
  }

  // The title back out of the NAME rather than out of the argument, so the heading always describes
  // the file it is actually in.
  const title = name.slice(16, -4).replace(/_/g, ' ');
  fs.writeFileSync(file, `-- ${title}
--
-- Say WHAT this changes and WHY, for whoever finds it in a year. An applied migration is history: it
-- is never edited and never renamed, so this comment is the only place its reason can live.
--
-- Additive statements only, or an explicitly reversible one — tests/migration-ledger.test.ts holds
-- that rule, and explains why a destructive statement has to be visible in review.

`, 'utf8');

  console.log(`created migrations/${name}`);
  console.log('apply it with: npm run db:migrate');
}
