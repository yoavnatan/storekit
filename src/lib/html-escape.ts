// Client-only (uses the DOM) — for escaping values inserted into innerHTML
// from browser-bundled scripts. Not usable from Astro server frontmatter.
export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
