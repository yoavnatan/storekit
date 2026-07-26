// Recently-visited STORES — the list behind the homepage "ביקרת לאחרונה" shelf.
// A *store* visit counts (opening /[slug] or any product page inside it),
// so the shelf fills from ordinary browsing instead of demanding a product open
// — the earlier product-level version left it empty too easily. Stored in a
// first-party cookie (not localStorage) on purpose: the homepage is SSR and
// reads the cookie to render real StoreCards server-side, exactly like the
// "גלה עוד" shelf. Logged-in users also get the list synced to their account
// (cart-sync + /api/user-cart) so it follows them across devices.
//
// Only `parseRecentStores`/`mergeStoreSlugs` are used server-side; they touch no
// DOM, and nothing at module top level does either, so this file is safe to
// import from Astro frontmatter and API routes.
const COOKIE = 'sn_recent_stores';
const CAP = 12;
const MAX_AGE = 60 * 60 * 24 * 90; // 90 days

// Pure. Splits the stored comma-separated, URI-encoded slug list, newest-first.
export function parseRecentStores(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => { try { return decodeURIComponent(s); } catch { return ''; } })
    .filter(Boolean)
    .slice(0, CAP);
}

// Pure union preserving order (a first, then b's extras), deduped + capped.
export function mergeStoreSlugs(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...a, ...b]) if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  return out.slice(0, CAP);
}

export function readRecentStores(): string[] {
  if (typeof document === 'undefined') return [];
  const m = document.cookie.match(/(?:^|;\s*)sn_recent_stores=([^;]*)/);
  return parseRecentStores(m ? m[1] : '');
}

function write(slugs: string[]): void {
  const value = slugs.slice(0, CAP).map(encodeURIComponent).join(',');
  document.cookie = `${COOKIE}=${value};path=/;max-age=${MAX_AGE};samesite=lax`;
}

// Prepend (most-recent-first), dedup, cap. Returns true only when the list
// actually changed, so a caller can skip firing a sync for a repeat visit to
// the store already at the front (e.g. store page → product page in it).
export function recordStoreVisit(slug: string): boolean {
  if (!slug || typeof document === 'undefined') return false;
  const cur = readRecentStores();
  if (cur[0] === slug) return false;
  write([slug, ...cur.filter((s) => s !== slug)]);
  return true;
}

// Overwrite this browser's cookie — used by cart-sync after a login merge/switch
// to fold in the account's cross-device list.
export function setRecentStores(slugs: string[]): void {
  if (typeof document === 'undefined') return;
  write(mergeStoreSlugs(slugs, []));
}
