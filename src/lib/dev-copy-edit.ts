/**
 * The decisions the inline copy editor makes about a string, as pure functions — so they can be
 * tested without a running dev server and without writing to the working tree.
 *
 * They are the same three the file-based review already makes (`scripts/copy-review.mjs`), and they
 * are here rather than inline in `src/pages/api/dev/copy.ts` for one reason: every one of them
 * decides whether a string is DAMAGED or merely reworded, and a route that writes to disk is the
 * worst possible place to leave that untested. All three damage cases below happened for real on the
 * first file-based review round (2026-08-07).
 */

/** `{name}`, `{n}` — the holes a sentence is printed with, sorted so two lists compare directly. */
export function placeholdersOf(text: string): string[] {
  return (text.match(/\{\w+\}/g) ?? []).sort();
}

/**
 * A stray space where a word was deleted, two where a line was joined. Tidied rather than refused,
 * matching `copy:apply` — a textarea leaves the same marks a hand-edited text file does.
 */
export function tidy(raw: string): string {
  return raw.trim().replace(/ {2,}/g, ' ');
}

export type EditResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Judge a proposed replacement for `current`.
 *
 * Errors are in Hebrew because they are read in the editor's own panel, on the page, by the person
 * who typed the text — not in a log.
 */
export function validateEdit(current: string, raw: string): EditResult {
  const value = tidy(raw);
  if (!value) return { ok: false, error: 'הטקסט לא יכול להיות ריק' };

  const lost = placeholdersOf(current).filter((p) => !placeholdersOf(value).includes(p));
  if (lost.length) {
    return { ok: false, error: `חסר ${lost.join(', ')} — בלי זה המשפט יודפס עם חור באמצע` };
  }

  return { ok: true, value };
}

/**
 * Whether the hard-coded copies of `oldValue` in client renderers (`d.strX ?? 'טקסט'`) may be
 * rewritten along with the dictionary, given every Hebrew value in it.
 *
 * `copy-review.mjs` always reports and never rewrites, because it applies a whole section at once
 * and cannot tell which of several identical strings a given literal belongs to. Editing ONE string
 * narrows that: when the old text is the value of exactly one key, a literal equal to it can only be
 * that key's fallback. When two keys share the words, the ambiguity is real and the copies are
 * reported instead — the wrong screen quietly rewritten is the failure worth avoiding here.
 */
export function mayRewriteFallbacks(allValues: string[], oldValue: string): boolean {
  return allValues.filter((v) => v === oldValue).length === 1;
}

/**
 * Add `key` to the list of keys whose English is now behind the Hebrew.
 *
 * `parsed` is whatever came out of `.tmp-copy-en-todo.json`, which is hand-editable and
 * hand-deletable by design — so it is `unknown`, not `string[]`. An object left in that file would
 * make `.includes` throw INSIDE a save that has already rewritten translations.ts: the edit lands,
 * the response is a 500, and the editor reports a failure that did not happen. Anything unreadable
 * starts the list over instead.
 */
export function mergeEnglishTodo(parsed: unknown, key: string): string[] {
  const list = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  return list.includes(key) ? list : [...list, key];
}

/**
 * Strings that are DRAWN into committed files rather than read at runtime, and the command that
 * redraws them.
 *
 * This exists because the first real edit made with this editor was `brand.tagline`, and it went
 * green: the dictionary was right, every test passed, and six files under `public/` — both lockup
 * SVGs, their rasters, the email logo and the OG card — still said the old words, because the
 * tagline is drawn there as OUTLINES and no test can read a path. A generated image is invisible to
 * the suite (memory `project_migration_not_applied_class`), so the only place this can be caught is
 * at the moment of the edit, by the tool that made it.
 *
 * Keyed by the dotted key, not by a substring: the point is to be silent for the ~1,200 strings
 * that need nothing.
 */
export const REGENERATE_AFTER: Record<string, string> = {
  'brand.tagline': 'npm run brand:wordmark && npm run brand:assets',
};

/** The command this key leaves stale, or null when the edit is complete on its own. */
export function regenerateFor(key: string): string | null {
  return REGENERATE_AFTER[key] ?? null;
}
