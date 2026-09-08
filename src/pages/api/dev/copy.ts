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
  tidy,
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
  removeLeafLine,
  insertLeafLine,
  arrayIndexOf,
  siblingsOf,
  sourceFiles,
} from '../../../../scripts/lib/translations-source.mjs';

/** Keys edited here, so the English can be brought level afterwards. Gitignored via `.tmp-`. */
const EN_TODO = `${ROOT}/.tmp-copy-en-todo.json`;

type Body = {
  key?: unknown;
  value?: unknown;
  allowEmpty?: unknown;
  insert?: unknown;
  /** The English the deletion took with it, handed back on an undo. Nothing else still holds it. */
  valueEn?: unknown;
};

function reject(message: string, status = 400, confirm?: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message, confirm }), {
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

/**
 * Do to the English twin whatever was just done to the Hebrew, when the edit was a DELETION.
 *
 * A reword deliberately leaves English behind — that is what `.tmp-copy-en-todo.json` is for, and a
 * half-translated sentence is still a sentence. A deletion is not like that: `tests/i18n-parity.test.ts`
 * fails on a key that is empty on one side only, and on an array that is not the same length in both
 * blocks. Deleting a bullet in Hebrew and leaving the English array one longer is a red suite the
 * owner would meet with no idea why, and every index past it would name a different line.
 *
 * Sequential, on the text as it stands AFTER the Hebrew edit: the two blocks live in one file, so
 * English offsets taken before the Hebrew side moved are stale.
 */
function mirrorDeletion(src: string, key: string, removed: boolean): { text: string; was: string | null } {
  const twin = scanLanguageBlock(src, 'en').find((l) => l.key === key);
  if (!twin) return { text: src, was: null };
  return {
    text: removed ? removeLeafLine(src, twin) : replaceLeaves(src, [{ leaf: twin, value: '' }]),
    was: twin.value,
  };
}

/** Put a value back into an array at `index`, in whichever language block `lang` names. */
function insertInto(
  src: string,
  lang: 'he' | 'en',
  key: string,
  index: number,
  value: string,
): string | null {
  const siblings = siblingsOf(scanLanguageBlock(src, lang), key);
  const at = siblings.find((l) => arrayIndexOf(l.key) === index);
  const last = siblings[siblings.length - 1];
  if (!at && !last) return null;
  return insertLeafLine(src, at ?? last, value, !at);
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

  // Putting a REMOVED array item back. Its line is gone and every index past it moved up, so there
  // is no leaf left to address — this is an insert at a position, not an edit of a key.
  if (body.value.insert === true) {
    const index = arrayIndexOf(key);
    if (index === null) return reject('רק פריט ברשימה נמחק מהקובץ, וזה לא אחד', 400);
    const restored = tidy(raw);
    if (!restored) return reject('אין מה להחזיר');

    // Hebrew first, then English on the text that came out of it. The English line goes back even
    // when all we have is the Hebrew — an array shorter on one side is what breaks the parity test.
    const withHe = insertInto(src, 'he', key, index, restored);
    if (!withHe) return reject('הרשימה ריקה — אין לְמה להצמיד את השורה', 409);
    const twinValue = typeof body.value.valueEn === 'string' ? body.value.valueEn : restored;
    const withEn = insertInto(withHe, 'en', key, index, twinValue) ?? withHe;

    fs.writeFileSync(SOURCE, withEn, 'utf8');
    return new Response(
      JSON.stringify({ ok: true, key, now: restored, unchanged: false, removed: false, fallbacks: [], regenerate: null }),
      { headers: { 'content-type': 'application/json' } },
    );
  }

  const leaf = leaves.find((l) => l.key === key);
  if (!leaf) return reject(`המפתח ${key} לא קיים ב-translations.ts`, 404);

  // Emptying a string is refused once and done on the second ask — `validateEdit` carries why.
  const edit = validateEdit(leaf.value, raw, body.value.allowEmpty === true);
  if (!edit.ok) {
    // The two emptyings end differently, so they are asked differently: a list item goes away, a
    // plain key keeps the element that prints it and loses only its words.
    const question =
      edit.confirm === 'empty' && arrayIndexOf(key) !== null
        ? 'ריק — השורה תוסר מהרשימה. עוד לחיצה על שמירה מסירה אותה'
        : edit.error;
    return reject(question, 400, edit.confirm);
  }
  const { value } = edit;

  // Restoring a BLANKED plain key: the English was emptied with it, so it comes back with it. That
  // old English value rode out to the browser in `wasEn` and rides back in here.
  const englishBack = typeof body.value.valueEn === 'string' ? body.value.valueEn : null;
  if (englishBack && value) {
    const heBack = replaceLeaves(src, [{ leaf, value }]);
    const twinNow = scanLanguageBlock(heBack, 'en').find((l) => l.key === key);
    if (twinNow?.value === '') {
      fs.writeFileSync(SOURCE, replaceLeaves(heBack, [{ leaf: twinNow, value: englishBack }]), 'utf8');
      return new Response(
        JSON.stringify({ ok: true, key, was: leaf.value, now: value, unchanged: false, removed: false, fallbacks: [], regenerate: regenerateFor(key) }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
  }

  if (value === leaf.value) {
    return new Response(JSON.stringify({ ok: true, key, was: leaf.value, now: value, unchanged: true, fallbacks: [], regenerate: null }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // An emptied ARRAY item is REMOVED, not blanked. Blanking leaves a bullet on screen showing its
  // marker and no words — the thing the owner asked about. A plain key has no such option: the
  // element that prints it belongs to the markup, and taking that away is a code change.
  const removed = value === '' && arrayIndexOf(key) !== null;
  const afterHe = removed ? removeLeafLine(src, leaf) : replaceLeaves(src, [{ leaf, value }]);
  // Only a DELETION crosses into the English block; a reword leaves it behind on purpose.
  const twin = value === '' ? mirrorDeletion(afterHe, key, removed) : { text: afterHe, was: null };
  fs.writeFileSync(SOURCE, twin.text, 'utf8');

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
      removed,
      wasEn: twin.was,
      fallbacks,
      regenerate: regenerateFor(key),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
