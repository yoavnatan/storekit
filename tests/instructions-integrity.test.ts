import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/source-guard.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGitEnv } from './helpers/git-env.js';

/**
 * Does AI_INSTRUCTIONS.md still describe the repo it is sitting in?
 *
 * The Security review gate covers code; nothing covered the docs, and they rot silently — a wrong
 * path never throws, it just sends a future session to a file that isn't there. A 2026-07-27 audit
 * found 3 wrong paths, an entry for a deleted directory, and 3 unlisted files, none of which would
 * ever have surfaced as an error. The end-of-session workflow therefore asked for this check by
 * hand, which made it both slow and skippable. It is mechanical work, so it belongs here: it runs
 * inside `npm test` in single-digit milliseconds and costs a session nothing.
 *
 * This matters more since 2026-07-31, when the always-read section was deliberately rewritten to be
 * pointer-heavy — "the reasoning is in `lib/pricing.ts`'s header". A pointer is only worth what it
 * resolves to, so a rename that leaves the pointer behind must fail loudly.
 *
 * What it CANNOT check: whether a note still tells the truth. Both of the errors found the day this
 * was written (AI_INSTRUCTIONS claiming commission lives at `store.config.ts →
 * checkout.commissionPercent`, in two separate places, when that file explicitly says it does not)
 * were true-path/false-claim, which only reading the code catches. Green here is "nothing points at
 * a missing file", not "everything said is correct".
 *
 * Two traps, both previously hit by hand-rolled versions of this check:
 *   • `## Workflow` appears EARLIER in the file as a cross-reference. Anchoring on the first match
 *     yields an empty or negative slice — a reverse check built that way once reported all 323 src
 *     files as undocumented when the true count was 0.
 *   • Structure entries are written `a.ts + b.ts ← note`, and some have no `←` note at all. A naive
 *     "first token per line" scan reported 12 undocumented files when only 3 were, and acting on
 *     that list would have added DUPLICATE entries to the section it was repairing.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = readFileSync(new URL('../AI_INSTRUCTIONS.md', import.meta.url), 'utf8');
const LINES = SRC.split('\n');

const at = (prefix: string) => LINES.findIndex((l) => l.startsWith(prefix));
const lastAt = (prefix: string) => {
  for (let i = LINES.length - 1; i >= 0; i--) if (LINES[i].startsWith(prefix)) return i;
  return -1;
};

const FEATURES_AT = at('## Features built');
const STRUCTURE_AT = at('## Project structure');
const WORKFLOW_AT = lastAt('## Workflow'); // LAST, not first — see the trap above

/** The rules a session reads at start, minus fenced code blocks (data-model sketches, not paths). */
const ALWAYS_READ = (LINES.slice(0, FEATURES_AT).join('\n') + '\n' + LINES.slice(WORKFLOW_AT).join('\n'))
  .replace(/```[\s\S]*?```/g, '');

/**
 * Files only, and the extension is REQUIRED. A "token ending in /" branch was tried first and
 * matched ordinary prose — "Google Ads/Meta", "7/14/30 days", "creative/fine-tuning" — so the
 * directory-group lines are parsed separately, anchored to the start of a structure line, where a
 * trailing slash is unambiguous.
 * Alternation is longest-first: `js` before `json` truncates `sellers.json` to a `sellers.js` that
 * does not exist, and the check then reports 15 phantom failures.
 */
const PATH_RE = /[.\w@[][\w./[\]-]*\.(?:astro|json|tsx|mjs|css|txt|ts|js|sh|md)\b/g;
/** A structure line that documents a whole directory: `src/lib/ ← …`. */
const DIR_LINE_RE = /^([.\w@[][\w./[\]-]*\/)/;

/** Illustrative filenames in prose that are not meant to exist. */
const NOT_REAL = new Set(['a.ts', 'b.ts', 'file.ts', 'foo.ts', 'src/**', '.env']);

// Resolving git off PATH is the only portable option (no fixed path across mac/linux/CI), and this
// is a test file: anyone who can shadow `git` on your PATH can already edit the suite itself.
// eslint-disable-next-line sonarjs/no-os-command-from-path
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, env: cleanGitEnv(), encoding: 'utf8', maxBuffer: 1e8 })
  .split('\n')
  .filter(Boolean);

/**
 * A token resolves if it exists on disk (relative to the repo, or as a suffix of a real path —
 * the file names shorthands like `components/buttons.css` and `pricing.ts` on purpose, because the
 * full path buys nothing at the point of the pointer).
 */
function resolves(token: string): boolean {
  if (NOT_REAL.has(token) || token.includes('*')) return true;
  const clean = token.replace(/\/$/, '');
  // `data/*.json` is runtime state, not source: gitignored, written on demand, and therefore
  // absent on a fresh checkout while every dev machine has it. CI read those 15 structure lines
  // as dead paths. Its presence proves nothing either way, so they are taken on trust.
  if (/^data\/[^/]+\.json$/.test(clean)) return true;
  // join(), not `new URL(rel, base)`: a URL percent-encodes the brackets in a real route path like
  // `src/pages/[key].txt.ts`, so existsSync would be handed `%5Bkey%5D` and answer false. The
  // suffix match below happened to cover for it, which is exactly the kind of accidental pass that
  // stops covering the day the tracked-file list is not consulted.
  if (existsSync(join(ROOT, clean))) return true;
  const needle = '/' + clean;
  if (tracked.some((p) => p === clean || p.endsWith(needle))) return true;
  // Directory group lines ("src/lib/ ← …") and gitignored-but-real dirs (data/).
  return tracked.some((p) => p.startsWith(clean + '/')) || safeIsDir(join(ROOT, clean));
}

function safeIsDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

const tokensIn = (text: string) => [...new Set(text.match(PATH_RE) ?? [])];

describe('AI_INSTRUCTIONS.md describes the repo it lives in', () => {
  it('has all three section anchors', () => {
    expect(FEATURES_AT).toBeGreaterThan(0);
    expect(STRUCTURE_AT).toBeGreaterThan(FEATURES_AT);
    expect(WORKFLOW_AT).toBeGreaterThan(STRUCTURE_AT);
  });

  it('every file it points a session at actually exists', () => {
    const dead = tokensIn(ALWAYS_READ).filter((t) => !resolves(t));
    expect(
      dead,
      `The always-read rules point at ${dead.length} path(s) that do not exist: ${dead.join(', ')}. ` +
        `The rules are deliberately pointer-heavy — a pointer that no longer resolves is a rule ` +
        `that quietly stopped working. Fix the pointer, or move the content back.`,
    ).toEqual([]);
  });

  it('every path listed in Project structure exists on disk', () => {
    const dead: string[] = [];
    for (let i = STRUCTURE_AT + 1; i < WORKFLOW_AT; i++) {
      const line = LINES[i];
      if (!line.trim() || line.startsWith('<!--') || line.startsWith('```') || line.startsWith('#')) continue;
      // Only the part BEFORE the note — a note may mention any file in passing.
      const head = line.split('←')[0];
      const dir = head.match(DIR_LINE_RE)?.[1];
      if (dir && !resolves(dir)) dead.push(`line ${i + 1}: ${dir}`);
      for (const token of tokensIn(head)) {
        if (!resolves(token)) dead.push(`line ${i + 1}: ${token}`);
      }
    }
    expect(dead, `Project structure lists paths that no longer exist:\n${dead.join('\n')}`).toEqual([]);
  });

  /**
   * The narrow slice of "is the note TRUE" that a machine can actually settle.
   *
   * The header above says this file cannot check whether a note tells the truth, and in general
   * that is still so. But one kind of claim is checkable and turned out to rot exactly as
   * predicted: a note naming a FUNCTION. On 2026-08-10 a sweep of the map found the structure line
   * for `product-seo-hints.ts` had listed `productSeoScore` since 2026-08-04 and no such function
   * existed — it happened to come true that day when one was written for another reason. Two more
   * were live: `admin-tab-views.ts` named `getLastViewedAt()` (really `getAllLastViewedAt()`) and
   * pointed at `data/admin-tab-views.json`, deleted with every other JSON file on 2026-08-03; and
   * `order-totals.ts` named `storeSliceTotal()`, renamed to `storeSliceTotalAgorot()`.
   *
   * A stale symbol is worse than a stale path. A dead path fails the test above, and a session that
   * follows one lands nowhere and knows it. A dead symbol sends a session to a real file to look
   * for something that is not in it — where the honest conclusions are "I misread" or "someone
   * deleted it", and the tempting one is to write it again beside the thing that already does it.
   *
   * Two forms, and the distinction is what keeps this quiet:
   *   · `someFn()` — unqualified, so it must live in the file the line documents.
   *   · `other-module.ts#someFn` — qualified, so it must live in THAT module; the line is telling a
   *     session where to go next, and those pointers rot the same way. Checking them against the
   *     documented file instead reports three false failures on the current map.
   * Bare `#foo` with no module before it is not a symbol at all (`#rrggbb` is a colour format), and
   * prose is left alone: only a name wearing `()` or sitting after `module#` makes a claim.
   */
  it('every function name in Project structure exists in the file it names', () => {
    const FILE_IN_HEAD = /[\w@[][\w./[\]-]*\.(?:astro|tsx|mjs|ts|js)\b/g;
    const QUALIFIED = /([\w@[][\w./[\]-]*\.(?:astro|tsx|mjs|ts|js))#([a-zA-Z_]\w*)/g;
    const UNQUALIFIED = /(^|[^#\w.])([a-z]\w{3,})\(\)/g;

    const bodyOf = (token: string): string | null => {
      const clean = token.replace(/\/$/, '');
      const hit = existsSync(join(ROOT, clean))
        ? clean
        : tracked.find((p) => p === clean || p.endsWith('/' + clean));
      if (!hit || safeIsDir(join(ROOT, hit))) return null;
      try {
        // Comments stripped: this answers "does the thing AI_INSTRUCTIONS points at EXIST", and a
        // name that appears only in that file's own prose is a pointer to nothing while looking
        // perfectly resolved. Found 2026-08-25 by scripts/audit-hollow-guards.mjs, which runs the
        // suite a second time with every src/ comment removed.
        return stripComments(readFileSync(join(ROOT, hit), 'utf8'));
      } catch {
        return null;
      }
    };

    const wrong: string[] = [];
    for (let i = STRUCTURE_AT + 1; i < WORKFLOW_AT; i++) {
      const line = LINES[i];
      if (!line.trim() || line.startsWith('<!--') || line.startsWith('```') || line.startsWith('#')) continue;
      const [head, ...rest] = line.split('←');
      const note = rest.join('←');
      if (!note.trim()) continue;

      // Qualified pointers: checked against the module they name, wherever the line sits.
      for (const [, mod, name] of note.matchAll(QUALIFIED)) {
        const body = bodyOf(mod);
        if (body && !new RegExp(`\\b${name}\\b`).test(body)) {
          wrong.push(`line ${i + 1}: ${mod}#${name} — not in ${mod}`);
        }
      }

      // Unqualified: any of the files this line documents may hold it (`a.ts + b.ts ← …`).
      const owners = [...new Set(head.match(FILE_IN_HEAD) ?? [])]
        .map(bodyOf)
        .filter((b): b is string => b !== null);
      if (owners.length === 0) continue;
      for (const [, , name] of note.matchAll(UNQUALIFIED)) {
        const re = new RegExp(`\\b${name}\\b`);
        if (!owners.some((body) => re.test(body))) {
          wrong.push(`line ${i + 1}: ${name}() — not in ${head.trim()}`);
        }
      }
    }

    expect(
      wrong,
      `Project structure names ${wrong.length} function(s) that are not in the file it sends a ` +
        `session to. Fix the NAME here after checking the code — never rename the code to match ` +
        `the note:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  it('every tracked src/ file is named in Project structure', () => {
    const structure = LINES.slice(STRUCTURE_AT, WORKFLOW_AT).join('\n');
    const undocumented = tracked
      .filter((f) => f.startsWith('src/'))
      .filter((f) => {
        if (structure.includes(f) || structure.includes(f.split('/').pop()!)) return false;
        // Or covered by a directory group line, at any depth.
        const parts = f.split('/');
        for (let i = parts.length - 1; i > 0; i--) {
          if (structure.includes(parts.slice(0, i).join('/') + '/')) return false;
        }
        return true;
      });
    expect(
      undocumented,
      `${undocumented.length} src/ file(s) are in the repo but not in Project structure — add a ` +
        `one-line "path ← note" entry for each, or a directory group line that covers them:\n` +
        undocumented.join('\n'),
    ).toEqual([]);
  });
});
