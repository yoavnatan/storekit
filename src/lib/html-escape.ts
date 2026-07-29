/**
 * THE HTML escaper. One implementation, imported everywhere — before 2026-07-29
 * there were 20 hand-written copies of it across components, page scripts and
 * libs, and they did NOT agree: several escaped only `&<>` while being used
 * inside `attr="…"`, which is exactly how the same stored-XSS bug got fixed
 * three separate times on three separate surfaces (memory
 * `project_attribute_escaping_xss`). A single definition is the only version of
 * this that stays fixed.
 *
 * Escapes the full attribute-safe set — `&`, `<`, `>`, `"`, `'` — so ONE function
 * is correct in both places a value can land: a text node and a quoted attribute.
 * Callers keep their historic local name via an import alias (`esc`, `escH`,
 * `escHtml`, …) rather than churning every call site.
 *
 * Pure string work, no DOM: usable from Astro frontmatter (SSR), from a browser
 * bundle, and from the email builder alike. The previous implementation went
 * through `document.createElement`, which made it client-only AND — since HTML
 * serialization never escapes quotes — silently unsafe in an attribute.
 *
 * Takes `unknown` so a number/null/undefined can't reach a template as the string
 * "undefined" via an unchecked `String()` at the call site.
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => ENTITIES[char] as string);
}
