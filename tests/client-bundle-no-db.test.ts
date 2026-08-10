import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nothing that runs in a BROWSER may import a module that reaches `lib/db.ts`.
 *
 * `db.ts` builds a connection pool at module scope, so the import is a side effect and a bundler
 * cannot shake it away. The symptom is not a type error and not a build failure — it is Postgres,
 * `pg`'s dependency tree and a `DATABASE_URL` read shipped inside the seller dashboard's JS, on the
 * one screen a seller loads most. `csv-bulk.ts`'s header records the same trap from the other
 * direction ("bundling a Node-only import into the browser build crashes the whole page on load"),
 * which is exactly the point: the rule has been learned twice by hand and never held mechanically.
 *
 * It caught a real one on 2026-08-10 while the reports tab was being built. `scripts/dashboard/
 * reports.ts` imported `isReportId` from `lib/seller-reports.ts`, whose builders import `orders.ts`
 * → `db.ts`. `astro check` passed, lint passed, every test passed. The fix was to split the ids and
 * row shapes into `lib/seller-report-shapes.ts`, which is what this test now protects.
 *
 * **`import type` is exempt and has to be**, because it is erased before a bundler ever sees it —
 * that is precisely how a client file legitimately names a server module's row shape. Only VALUE
 * imports are counted.
 *
 * fileURLToPath, not `.pathname` — this repo's own directory name is Hebrew and `.pathname` hands
 * back the percent-encoded form, which `readdirSync` cannot open.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const LIB = join(SRC, 'lib');
const DB = join(LIB, 'db.ts');

/** Directories whose files are shipped to the browser. `src/scripts/` is the whole client-script
 *  tree; `.astro` component scripts are covered by the build itself failing on a Node import. */
const CLIENT_DIRS = [join(SRC, 'scripts')];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every relative VALUE import in a file, resolved to a `.ts` path. `import type {…}` and
 *  `import { type X }`-only statements are skipped: they are erased at build. */
function valueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/import\s+([^'"]*?)\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const clause = m[1];
    if (/^\s*type\b/.test(clause)) continue;
    // `import { type A, type B } from …` is also fully erased.
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    const hasDefaultOrNamespace = /^\s*[A-Za-z_$*]/.test(clause.replace(/\{[^}]*\}/, '').trim());
    if (named && !hasDefaultOrNamespace && named.split(',').every((s) => !s.trim() || /^\s*type\b/.test(s))) continue;
    const target = resolve(dirname(file), m[2]).replace(/\.js$/, '.ts');
    if (existsSync(target)) out.push(target);
  }
  return out;
}

/** Every module under src/ that reaches db.ts through value imports. */
function modulesReachingDb(): Set<string> {
  const files = walk(SRC);
  const edges = new Map(files.map((f) => [f, valueImports(f)]));
  const tainted = new Set<string>([DB]);
  // Fixed point — an import graph with cycles cannot be walked once.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, deps] of edges) {
      if (tainted.has(file)) continue;
      if (deps.some((d) => tainted.has(d))) { tainted.add(file); changed = true; }
    }
  }
  return tainted;
}

describe('client bundles never reach the database', () => {
  const tainted = modulesReachingDb();
  const rel = (p: string): string => p.slice(SRC.length);

  it('knows which modules are server-only — the scan is not passing vacuously', () => {
    // If this ever drops to a handful, the import parser has stopped matching and every assertion
    // below became meaningless.
    expect(tainted.size).toBeGreaterThan(20);
    expect([...tainted].some((p) => p.endsWith('orders.ts'))).toBe(true);
  });

  it('no file under src/scripts/ value-imports one', () => {
    const offenders: string[] = [];
    for (const dir of CLIENT_DIRS) {
      for (const file of walk(dir)) {
        for (const dep of valueImports(file)) {
          if (tainted.has(dep)) offenders.push(`${rel(file)} → ${rel(dep)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the reports tab reads its shapes from the leaf module, not the builders', () => {
    // The specific instance the rule was learned on, pinned by name so a future edit that re-points
    // the import fails with the reason rather than with a bundle size nobody measures.
    const client = readFileSync(join(SRC, 'scripts/dashboard/reports.ts'), 'utf8');
    expect(client).toMatch(/from '\.\.\/\.\.\/lib\/seller-report-shapes\.js'/);
    expect(client).not.toMatch(/import \{[^}]*\} from '\.\.\/\.\.\/lib\/seller-reports\.js'/);
  });
});
