export const prerender = false;
/**
 * The write-back half of the DEV-ONLY inline copy editor: one string, edited on the page it appears
 * on, straight into `src/i18n/translations.ts`.
 *
 * **Why this exists at all.** Reviewing Hebrew wording used to mean finding the sentence on screen,
 * grepping the repo for it, pasting it into a chat, and getting a rewrite back — for every string,
 * one at a time (owner, 2026-09-08: *"אם רק היה אפשר לערוך את זה אינליין בתוך האתר"*). The round
 * trip through `scripts/copy-review.mjs` is still the right tool for reviewing a whole section in
 * one pass; this is the other case, the one that was costing the most: seeing a single bad phrase
 * in place and fixing it there.
 *
 * **It never reaches production, twice over.** `import.meta.env.DEV` is a compile-time constant, so
 * the body below is dropped from a production build; the guard is repeated at runtime anyway, since
 * "the bundler removes it" is a claim about a build nobody re-checks. `tests/dev-copy-editor.test.ts`
 * holds both. The route writes to the working tree, which is exactly what a dev server should be
 * able to do and exactly what a deployed server must never do.
 *
 * CSRF is the ordinary site-wide gate (`src/middleware.ts` + `scripts/csrf-client.ts` attaching the
 * token to every mutating fetch). Nothing is exempted here — an exemption is the one thing
 * `tests/csrf.test.ts` pins, and this route needs none.
 */
import type { APIRoute } from 'astro';
import fs from 'node:fs';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import {
  validateEdit,
  mayRewriteFallbacks,
  mergeEnglishTodo,
  regenerateFor,
} from '../../../lib/dev-copy-edit.js';
import {
  ROOT,
  SOURCE,
  scanLanguageBlock,
  escapeLiteral,
  replaceLeaves,
  sourceFiles,
} from '../../../../scripts/lib/translations-source.mjs';

/** Keys edited here, so the English can be brought level afterwards. Gitignored via `.tmp-`. */
const EN_TODO = `${ROOT}/.tmp-copy-en-todo.json`;

type Body = { key?: unknown; value?: unknown };

function reject(message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Rewrite the hard-coded copies of a string that live in client renderers as `d.strX ?? 'טקסט'`.
 *
 * Whether a rewrite is allowed at all is `mayRewriteFallbacks` in lib/dev-copy-edit.ts, which
 * carries the reasoning; `unique` is its answer. When it says no, the copies are located and
 * reported and nothing is written.
 *
 * Matching is on the quoted literal, so a string containing an apostrophe (escaped in source) is
 * not found. That is the same blind spot the reporter has always had; it surfaces as "0 rewritten"
 * rather than as a wrong rewrite.
 */
function rewriteFallbacks(oldValue: string, newValue: string, unique: boolean) {
  const found: { file: string; line: number; rewritten: boolean }[] = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(`'${oldValue}'`) && !text.includes(`"${oldValue}"`)) continue;

    const relative = file.slice(ROOT.length + 1);
    text.split('\n').forEach((line, index) => {
      if (line.includes(`'${oldValue}'`) || line.includes(`"${oldValue}"`)) {
        found.push({ file: relative, line: index + 1, rewritten: unique });
      }
    });

    if (!unique) continue;
    const updated = text
      .split(`'${oldValue}'`)
      .join(`'${escapeLiteral(newValue)}'`)
      .split(`"${oldValue}"`)
      .join(`"${newValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    fs.writeFileSync(file, updated, 'utf8');
  }
  return found;
}

function noteForEnglish(key: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(EN_TODO, 'utf8'));
  } catch {
    // No file yet, or one left half-written by an interrupted run — either way the list starts over.
    parsed = [];
  }
  fs.writeFileSync(EN_TODO, JSON.stringify(mergeEnglishTodo(parsed, key), null, 2), 'utf8');
}

export const POST: APIRoute = async ({ request }) => {
  if (!import.meta.env.DEV) return new Response('Not found', { status: 404 });

  const body = await readJsonBody<Body>(request, BODY_LIMIT.control);
  if (!body.ok) return reject('bad body', body.status);

  const key = typeof body.value.key === 'string' ? body.value.key : '';
  const raw = typeof body.value.value === 'string' ? body.value.value : '';
  if (!key) return reject('missing key');

  const src = fs.readFileSync(SOURCE, 'utf8');
  const leaves = scanLanguageBlock(src, 'he');
  const leaf = leaves.find((l) => l.key === key);
  if (!leaf) return reject(`המפתח ${key} לא קיים ב-translations.ts`, 404);

  const edit = validateEdit(leaf.value, raw);
  if (!edit.ok) return reject(edit.error);
  const { value } = edit;

  if (value === leaf.value) {
    return new Response(JSON.stringify({ ok: true, key, was: leaf.value, now: value, unchanged: true, fallbacks: [], regenerate: null }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  fs.writeFileSync(SOURCE, replaceLeaves(src, [{ leaf, value }]), 'utf8');

  const unique = mayRewriteFallbacks(leaves.map((l) => l.value), leaf.value);
  const fallbacks = rewriteFallbacks(leaf.value, value, unique);
  noteForEnglish(key);

  // A few strings are drawn into committed files rather than read at runtime; the editor says so
  // on the spot, because nothing downstream can. See `regenerateFor` for why that is the only place.
  return new Response(
    JSON.stringify({
      ok: true,
      key,
      was: leaf.value,
      now: value,
      unchanged: false,
      fallbacks,
      regenerate: regenerateFor(key),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
