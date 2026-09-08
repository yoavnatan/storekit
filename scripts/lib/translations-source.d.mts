/**
 * Types for `translations-source.mjs`, which is plain JavaScript because a Node CLI and a
 * Vite-compiled Astro route both have to import it (see that file's header).
 *
 * Hand-written and deliberately narrow: `scripts/` is otherwise outside the typed surface, and the
 * one consumer inside `src/` — `src/pages/api/dev/copy.ts` — is the reason these exist at all.
 * Without them `astro check` reports the import as untyped and the route's `leaf.start` arithmetic
 * would be `any`, which is exactly the arithmetic that must not go unchecked.
 */

/** One string literal in a language block, with the exact character range it occupies in the file. */
export interface CopyLeaf {
  /** Dotted path, e.g. `nav.openStore`. Array elements appear as their index. */
  key: string;
  /** Index of the opening quote. */
  start: number;
  /** Index just past the closing quote. */
  end: number;
  /** The literal's value, unescaped. */
  value: string;
}

export const ROOT: string;
export const SOURCE: string;

export function scanLanguageBlock(src: string, lang: 'he' | 'en'): CopyLeaf[];
export function unescapeLiteral(raw: string): string;
export function escapeLiteral(value: string): string;
export function replaceLeaves(src: string, changes: { leaf: CopyLeaf; value: string }[]): string;
export function sourceFiles(): Generator<string>;
