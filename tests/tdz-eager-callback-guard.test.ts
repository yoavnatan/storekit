import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import type { Rule } from 'eslint';
import { parser as tsParser } from 'typescript-eslint';
import * as astroParser from 'astro-eslint-parser';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══ A `const` READ BY A CALLBACK THAT RUNS BEFORE THE LINE DECLARING IT ═══
 *
 * ── The bug this exists to make impossible (found by the area-19 audit, 2026-08-25) ──
 *
 * `/api/returns` filtered a partial return's ticked lines through `allowedPositions`:
 *
 * ```ts
 * const returnedLinesRaw = asked
 *   .map(…)
 *   .filter(…)
 *   .filter((l) => !allowedPositions || allowedPositions.has(l.position));   // ← line 195
 * …
 * const allowedPositions = store ? await returnableLinePositions(…) : null;  // ← line 216
 * ```
 *
 * `allowedPositions` is a `const` twenty lines further down, so at line 195 it is in its temporal
 * dead zone and the read throws `ReferenceError`. Every partial return — a buyer ticking two of
 * three items — answered **500**.
 *
 * ── Why nothing already in this repo caught it, which is the whole argument for this file ──
 *
 *   · **TypeScript does not report it.** TS2448 covers a direct read in the same scope. A read from
 *     inside a callback is allowed, because the compiler cannot know when the callback runs. Here
 *     it ran in the same statement.
 *   · **No test reached it.** `.filter()` on an EMPTY array never invokes its callback, and a
 *     whole-order return sends no `lines` at all — which is the buyer's default button and every
 *     scenario in `returns-scenarios.test.ts`. The throw sat behind a branch nothing exercised.
 *   · **`@typescript-eslint/no-use-before-define` is too blunt to be the answer.** Switched on over
 *     this tree it reports 40 places, and 39 of them are legal: a click handler, a `setTimeout`, a
 *     `fetch().then()` reading a module const declared lower down — all of which run long after the
 *     declaration. Making those 40 errors is how a rule gets turned off again.
 *
 * ── So the rule here is the narrow one: the callback runs IMMEDIATELY ──
 *
 * A reference is reported only when all three hold, which is exactly the shape that throws:
 *   1. it resolves to a `let`/`const`/`class` binding declared LATER in the file;
 *   2. it sits inside a function that is an argument to an eagerly-invoking call — an array method
 *      that runs its callback synchronously, or an IIFE;
 *   3. that call itself appears before the declaration.
 *
 * A deferred callback (an event handler, a timer, a `.then`) fails test 2 and is never reported.
 *
 * ── It has to be proved capable of failing ──
 *
 * `tests/helpers/source-guard.ts` records why: three guards written in one session all passed while
 * guarding nothing. This file's `mustReject` is the original `/api/returns` code, and the rule is
 * run against it and required to REPORT. A rule that accepts its own counter-example fails here.
 */

/** Array and string methods that invoke their callback synchronously, before the call returns. */
const EAGER_METHODS = new Set([
  'filter', 'map', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'flatMap', 'reduce', 'reduceRight', 'sort', 'toSorted', 'replace', 'replaceAll',
]);

interface Node { type: string; range: [number, number]; parent?: Node; [k: string]: unknown }

/** Is this function invoked by the very call it is an argument to — array method or IIFE? */
function isEagerlyInvoked(fn: Node): Node | null {
  const call = fn.parent;
  if (!call || call.type !== 'CallExpression') return null;
  const args = call.arguments as Node[] | undefined;
  const callee = call.callee as Node | undefined;
  if (callee === fn) return call;                                    // an IIFE
  if (!args?.includes(fn)) return null;
  if (callee?.type !== 'MemberExpression') return null;
  const property = callee.property as { type: string; name?: string };
  if (property.type !== 'Identifier' || !property.name) return null;
  return EAGER_METHODS.has(property.name) ? call : null;
}

// Cast at the end rather than annotated here: the visitor below walks the AST through this file's
// own minimal `Node` shape (ESLint's published node types do not carry `parent` on every member),
// and annotating the object would demand that shape match `RuleListener` exactly for no benefit.
const rule = {
  meta: { type: 'problem', schema: [] },
  create(context: Rule.RuleContext) {
    return {
      'Program:exit'(program: Node) {
        const source = context.sourceCode;
        const walk = (scope: { references: unknown[]; childScopes: unknown[] }): void => {
          for (const raw of scope.references) {
            const ref = raw as {
              identifier: Node;
              resolved: null | { name: string; defs: { type: string; name: Node; parent?: { kind?: string } }[] };
            };
            const variable = ref.resolved;
            const def = variable?.defs[0];
            if (!def) continue;
            // `var` is hoisted: the read yields `undefined` rather than throwing, which is a
            // different (quieter) defect and not what this rule is for.
            if (def.type === 'Variable' && def.parent?.kind === 'var') continue;
            if (def.type !== 'Variable' && def.type !== 'ClassName') continue;
            if (ref.identifier.range[0] >= def.name.range[0]) continue;   // declared first; fine

            let node: Node | undefined = ref.identifier;
            let eagerCall: Node | null = null;
            while (node && node !== program) {
              if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
                eagerCall = isEagerlyInvoked(node);
                if (eagerCall) break;
              }
              node = node.parent;
            }
            // Not an immediate callback, or one that only runs after the declaration anyway.
            if (!eagerCall || eagerCall.range[0] >= def.name.range[0]) continue;

            context.report({
              node: ref.identifier as never,
              message: `'${variable!.name}' is read here by a callback that runs immediately, but its declaration is on line `
                + `${source.getLocFromIndex(def.name.range[0]).line}. That is a temporal dead zone: this throws ReferenceError `
                + `whenever the callback actually runs. Move the declaration above this statement.`,
            });
          }
          for (const child of scope.childScopes) walk(child as never);
        };
        walk(source.getScope(program as never) as never);
      },
    };
  },
} as unknown as Rule.RuleModule;

const linter = new Linter();

function lint(code: string, filename: string): string[] {
  const astro = filename.endsWith('.astro');
  const messages = linter.verify(code, {
    // **Every extension spelled out, and the filename must be RELATIVE.** Both were found the
    // hard way while writing this file: `files: ['**/*']` matches nothing in ESLint's flat config
    // (a bare universal pattern only carries settings, it never selects a file) and an absolute
    // path matches nothing either. Each mistake produced one "No matching configuration found"
    // message per file and ZERO findings — a tree scan that examined nothing and passed. The
    // assertion below is what turns that back into a failure instead of a green vacuum.
    files: ['**/*.ts', '**/*.mjs', '**/*.astro'],
    plugins: { guard: { rules: { 'tdz-eager-callback': rule } } },
    languageOptions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- two parsers, one seam
      parser: (astro ? astroParser : tsParser) as any,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ...(astro ? { parser: tsParser } : {}) },
    },
    rules: { 'guard/tdz-eager-callback': 'error' },
  }, filename);

  const unconfigured = messages.find((m) => m.message.startsWith('No matching configuration'));
  if (unconfigured) throw new Error(`${filename} was never linted: ${unconfigured.message}`);

  return messages
    // Only this rule's own findings. The scanned files carry `eslint-disable` comments naming rules
    // this one-rule config has never heard of, and every one of them comes back as a "rule not
    // found" message — the real lint run's noise leaking into a guard asking one narrow question.
    .filter((m) => m.ruleId === 'guard/tdz-eager-callback')
    .map((m) => `${filename}:${m.line} ${m.message}`);
}

/** Every file the rule can parse, under the directories that ship. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|astro|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const REPO = join(import.meta.dirname, '..');

describe('a const read by a callback that runs before it is declared', () => {
  it('catches the shape it exists for — the original /api/returns code', () => {
    // The counter-example is the real thing, trimmed to the two statements that matter.
    const mustReject = `
      const order = { items: [] };
      const asked = [{ position: 0, qty: 1 }];
      const returnedLinesRaw = asked
        .filter((l) => Number.isInteger(l.position) && l.position < order.items.length)
        .filter((l) => !allowedPositions || allowedPositions.has(l.position));
      const allowedPositions = new Set([0]);
      export default { returnedLinesRaw, allowedPositions };
    `;
    const found = lint(mustReject, 'counter-example.ts');
    expect(found.length, 'the rule accepted the very code it exists to catch').toBeGreaterThan(0);
    expect(found[0]).toContain('allowedPositions');
  });

  it('leaves a DEFERRED callback alone — the 39 legal cases a blunt rule would break', () => {
    const legal = `
      document.addEventListener('click', () => console.log(later));
      setTimeout(() => console.log(later), 0);
      fetch('/x').then(() => console.log(later));
      const later = 1;
      export default later;
    `;
    expect(lint(legal, 'legal.ts')).toEqual([]);
  });

  it('finds none in src/ or scripts/', { timeout: 120_000 }, () => {
    const failures = sourceFiles(join(REPO, 'src'))
      .concat(sourceFiles(join(REPO, 'scripts')))
      // Relative, because `Linter#verify` resolves a config's file patterns against the working
      // directory — an absolute path matches nothing and comes back as "no matching configuration",
      // which is a scan that silently examined zero files.
      .map((file) => file.slice(REPO.length + 1))
      .flatMap((file) => lint(readFileSync(join(REPO, file), 'utf8'), file));
    expect(failures).toEqual([]);
  });
});
