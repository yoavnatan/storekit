import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Two mechanical rules that both cost real bugs on 2026-08-20, in one afternoon.
 *
 * ── 1. A confirmation dialog says `message`, and only `message` ──
 *
 * `ConfirmModal.astro` reads `detail.message` and falls back to a generic "this cannot be undone".
 * A caller that says `body:` therefore opens a dialog that looks perfectly correct and states
 * NOTHING about what is being confirmed — no error, no warning, and the failure is invisible unless
 * somebody opens that exact dialog and reads it.
 *
 * It had happened once, in `scripts/admin/returns.ts`: the admin deciding a dispute, which is the
 * single most money-critical confirmation on the platform. Its `body` had three carefully written
 * branches naming the exact amount about to be moved, and every one of them was dead. Found because
 * the owner asked whether the critical actions have a dialog at all.
 *
 * ── 2. An `.astro` comment may not be the first child of a `&& (` ──
 *
 * `{cond && ( {/* … *\/} <p/> )}` is two sibling expressions with no fragment around them. Astro's
 * compiler does not report it as an error at that line — the route simply answers 404 from then on,
 * with nothing anywhere naming the file. It cost three separate debugging rounds in one session.
 */

function walk(dir: string, exts: RegExp): string[] {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel, exts);
    return entry.isFile() && exts.test(entry.name) ? [rel] : [];
  });
}

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

describe('every confirmation dialog states what it is about', () => {
  const FILES = ['src/scripts', 'src/components', 'src/pages']
    .flatMap((d) => walk(d, /\.(ts|astro)$/));

  it('scans a real set of files, so this cannot pass by finding nothing', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => read(f).includes("'confirm:open'"))).toBe(true);
  });

  it("no caller of confirm:open passes `body:` — ConfirmModal reads `message`", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = read(file);
      // Each dispatch, then the object literal that follows it. `body:` anywhere in the next ~30
      // lines of that call is the mistake; a `body:` on the `fetch` inside `onConfirm` is not, and
      // is why this looks at the detail object rather than at the whole file.
      for (const m of src.matchAll(/confirm:open'[^)]*?\{\s*detail:\s*\{/g)) {
        const from = (m.index ?? 0) + m[0].length;
        const detail = src.slice(from, from + 900);
        // Stop at `onConfirm`, which is where the caller's own request body legitimately begins.
        const head = detail.split('onConfirm')[0] ?? '';
        if (/\bbody\s*:/.test(head)) offenders.push(file);
      }
    }
    expect(
      [...new Set(offenders)],
      'ConfirmModal reads `detail.message`. A `body:` opens a dialog showing the generic default\n'
      + 'instead of the sentence that says what is about to happen — silently.',
    ).toEqual([]);
  });
});

describe('an .astro comment is never the first child of a && block', () => {
  const ASTRO = ['src/components', 'src/pages', 'src/layouts'].flatMap((d) => walk(d, /\.astro$/));

  it('scans the .astro tree', () => {
    expect(ASTRO.length).toBeGreaterThan(20);
  });

  it('finds no `&& (` immediately followed by a comment', () => {
    const offenders: string[] = [];
    for (const file of ASTRO) {
      // `&& (` at the end of a line, then whitespace, then `{/*` — the exact shape that compiles to
      // a 404 with no error message.
      if (/&&\s*\(\s*\n\s*\{\s*\/\*/.test(read(file))) offenders.push(file);
    }
    expect(
      offenders,
      'A comment there is a second sibling with no fragment around it: the page silently stops\n'
      + 'compiling and every route answers 404, naming no file. Move it ABOVE the `{cond && (`.',
    ).toEqual([]);
  });
});
