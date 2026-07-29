/**
 * The one way to embed data in a `<script>` tag.
 *
 * `JSON.stringify` is NOT safe here, and the reason is easy to miss: it produces
 * valid JSON, but the browser tokenizes a `<script>` body by scanning for the
 * literal `</script`, and the string `"</script><script>alert(1)</script>"` is
 * perfectly valid JSON. So a seller who names a product that way closes the tag
 * and runs script in the viewer's session — on the store page, the product page,
 * every JSON-LD blob, and the dataLayer push, all of which carry seller-supplied
 * names and descriptions to the public.
 *
 * Escaping to JSON's own `\uXXXX` form keeps the payload valid JSON — `JSON.parse`
 * decodes it right back, and JSON-LD consumers read the intended text — while
 * making the breakout impossible:
 *   • `<` and `>`  — the tag-close scan (this is the actual attack)
 *   • `&`          — an HTML-entity-decoding context can otherwise reconstitute `<`
 *   • U+2028/2029  — valid inside JSON, but ILLEGAL as raw line terminators in a JS
 *                    string literal, so they'd break any blob interpolated into
 *                    executable JS (BaseLayout's dataLayer push) rather than JSON
 *
 * Three places had hand-rolled a partial version of this and eleven had none at
 * all (audited 2026-07-29). Use this everywhere; `tests/json-script.test.ts`
 * fails the build on a bare `JSON.stringify` inside `set:html`.
 */

const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

/** Keys written as escape sequences, not literal characters: U+2028/2029 are
 *  invisible in an editor, and a stray copy/paste would silently break the map. */
const ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null).replace(SCRIPT_UNSAFE, (char) => ESCAPES[char] as string);
}
