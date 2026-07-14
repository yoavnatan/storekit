// Isomorphic (no fs/DOM) — safe to import from both Astro server frontmatter
// and browser-bundled client scripts, unlike the DOM-dependent helpers below.
export function formatHeDateTime(iso: string): string {
  return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
