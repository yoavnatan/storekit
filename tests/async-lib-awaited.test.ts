/**
 * Every call to an `async` export of `src/lib/` must be awaited, returned, or marked `void`.
 *
 * **Why this had to become mechanical (found 2026-08-02, during the stores migration).** Stage 2
 * turns synchronous `lib/` functions into queries, which makes them `async` — and the compiler
 * catches almost every caller, because a `Promise<Store>` has none of `Store`'s properties. It does
 * NOT catch the one that matters most: a promise in a BOOLEAN position is simply truthy.
 *
 *     const hasAlert = sellerId ? sellerHasAnyAlert(sellerId) : false;   // always truthy
 *     <span hidden={!initialSellerAlert}>                                // never hidden
 *
 * Both of those shipped in the same edit, `astro check` reported zero errors, and the visible
 * result was a red "you have something waiting" dot on every page for every seller — a defect a
 * type error would have named in a second and a person reads as a design choice. The same shape
 * hides an authorisation bypass: `if (!ownsStore(sellerId, storeId)) return 403` never returns 403
 * once `ownsStore` is async. Two of those were in this diff too.
 *
 * The remaining modules (`orders`, `store-products`, `messages`) migrate the same way, so the check
 * is written against whatever `src/lib/` exports today rather than a list to keep updated.
 *
 * **The four accepted forms**, each meaning something different:
 *   `await f()`   — this code needs the answer.
 *   `return f()`  — the caller needs it; an async function returning a promise is awaited by them.
 *   `void f()`    — deliberately not waited for, and the repo's existing convention for it
 *                   (lib/indexnow.ts, lib/order-notify.ts). It must be typed, not implied.
 *   inside an awaited `Promise.all([f(), g()])` — the array's own await covers every element.
 *     Added 2026-08-02 with the messages/notifications move: a page that needs two independent
 *     reads should issue them together rather than pay the round trip twice, and against a
 *     database in another region that difference is the page's speed. Demanding `await` on each
 *     element would forbid the correct shape, so the check follows the bracket instead.
 *
 * `src/scripts/` is out of scope: it is browser code, it cannot reach the database, and a
 * navigation helper fired from a click handler has nothing to await into.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|astro)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f));

/** Every `export async function` name in `src/lib/` — derived, so a new one is covered at once. */
function asyncLibExports(): string[] {
  const names = new Set<string>();
  for (const file of files.filter((f) => f.startsWith('src/lib/'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/export\s+async\s+function\s+(\w+)/g)) {
      names.add(m[1]!);
    }
  }
  return [...names];
}

interface Finding { file: string; line: number; text: string }

/**
 * For each line, the column from which it sits inside an awaited `Promise.all([…])` argument list
 * (`0` meaning the whole line). Tracked by counting brackets rather than parsing, which is enough:
 * the opener has to name `Promise.all` right after an `await`/`return`/`void`, so a bare
 * `Promise.all` whose result is dropped still reports every call inside it.
 */
function awaitedGroupRegions(lines: string[]): Map<number, number> {
  const opener = /(?:await|return|void)\s+Promise\.(?:all|allSettled|any|race)\s*\(/;
  const inside = new Map<number, number>();
  let depth = 0;

  lines.forEach((line, i) => {
    let from = 0;
    if (depth === 0) {
      const m = opener.exec(line);
      if (!m) return;
      depth = 1;                       // the '(' the pattern just consumed
      from = m.index + m[0].length;
    }
    inside.set(i, from);
    for (let c = from; c < line.length; c++) {
      if (line[c] === '(') depth++;
      else if (line[c] === ')' && --depth === 0) break;
    }
  });
  return inside;
}

function unawaitedCalls(names: string[]): Finding[] {
  const call = new RegExp(String.raw`(?<![\w$.])(${names.join('|')})\s*\(`, 'g');
  const findings: Finding[] = [];

  for (const file of files.filter((f) => !f.startsWith('src/scripts/'))) {
    let inBlockComment = false;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const grouped = awaitedGroupRegions(lines);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      const wasComment = inBlockComment;
      if (inBlockComment && trimmed.includes('*/')) inBlockComment = false;
      else if (!inBlockComment && trimmed.includes('/*') && !trimmed.includes('*/')) inBlockComment = true;
      // A name mentioned in prose is not a call site — and these modules are heavily commented.
      if (wasComment || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

      const groupedFrom = grouped.get(i);
      for (const m of line.matchAll(call)) {
        // An element of an awaited `Promise.all([…])` — the array's await covers it.
        if (groupedFrom !== undefined && m.index >= groupedFrom) continue;
        const before = line.slice(0, m.index).trimEnd();
        // The import that brings the name in, and the `export async function` that defines it.
        if (/\b(import|export|from)\b/.test(line) && !before.includes('await')) continue;
        if (/(await|return|=>|\byield|\bvoid)$/.test(before)) continue;
        // `f().then(…)` / `.catch(…)` — the promise is handled, just not with await.
        if (/\)\s*\.(then|catch|finally)\b/.test(line.slice(m.index))) continue;
        findings.push({ file, line: i + 1, text: trimmed.slice(0, 120) });
      }
    });
  }
  return findings;
}

describe('async lib calls are awaited', () => {
  it('finds the async lib surface it is meant to guard', () => {
    // A regression in the derivation itself would make this file pass by scanning for nothing.
    const names = asyncLibExports();
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain('getStoreBySlug');
    expect(names).toContain('updateStore');
  });

  it('has no call site that drops the promise on the floor', () => {
    const findings = unawaitedCalls(asyncLibExports());
    const report = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join('\n');
    expect(report, `Prefix each with await, return, or void:\n${report}`).toBe('');
  });

  it('accepts an element of an awaited Promise.all, and only while the bracket is open', () => {
    // The concession has to end where the group does, or one `Promise.all` in a file would excuse
    // every dropped promise after it.
    const inside = awaitedGroupRegions([
      'const [a, b] = await Promise.all([',
      '  getStoreBySlug(x),',
      '  getStoreBySlug(y),',
      ']);',
      'updateStore(id, patch);',
    ]);
    expect(inside.has(1)).toBe(true);
    expect(inside.has(2)).toBe(true);
    expect(inside.has(4)).toBe(false);
  });

  it('still reports a Promise.all nobody awaits', () => {
    const inside = awaitedGroupRegions(['Promise.all([', '  updateStore(id, patch),', ']);']);
    expect(inside.has(1)).toBe(false);
  });

  it('catches the shape that shipped — a promise used as a boolean', () => {
    // The check is only worth having if it would have failed on the real defect.
    const probe = unawaitedCalls(['sellerHasAnyAlert']);
    expect(probe).toEqual([]);
    const line = 'const hasAlert = sellerId ? sellerHasAnyAlert(sellerId) : false;';
    const call = /(?<![\w$.])(sellerHasAnyAlert)\s*\(/g;
    const m = [...line.matchAll(call)][0]!;
    expect(/(await|return|=>|\byield|\bvoid)$/.test(line.slice(0, m.index).trimEnd())).toBe(false);
  });
});
