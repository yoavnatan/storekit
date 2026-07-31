import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "Is this store on the site?" has one answer, and it lives in `lib/store-status.ts`.
 *
 * It used to be `!store.blocked`, short enough that call sites re-typed it inline instead of
 * importing the helper — and that is exactly what broke when the rule grew. Adding the seller's
 * own pause and closure turned every surviving `!s.blocked` into a copy that answers the OLD
 * question: the admin's "products in the ad feed" counter went on counting a paused store's
 * catalog, and three of the four admin store lists went on reporting it as perfectly normal.
 * Both were found by grepping, not by anything failing.
 *
 * Same shape as the product-visibility, safe-redirect and email-address guards: extract the rule,
 * then make it mechanically hard to hand-roll again.
 *
 * When this fails, use `isStoreVisible` / `isStoreDiscoverable` / `canStoreSell` (re-exported from
 * lib/stores.ts) instead of testing the flags. Add to the allowlist only with a reason beside it.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

const ALLOWED = new Map<string, string>([
  ['lib/store-status.ts', 'the rule itself'],
  ['lib/store-lifecycle.ts', 'the only writer of the flags'],
  ['lib/stores.ts', 'declares the fields and re-exports the predicates'],
  ['lib/platform-performance.ts', 'carries `blocked` on its row shape for backward compatibility, alongside the resolved state'],
  ['lib/store-state-badge.ts', 'owns the one fallback from that legacy row flag to a state'],
  ['lib/admin-stats.ts', 'the admin "blocked only" list filter — genuinely about that one flag, not about visibility'],
  ['components/admin/AdminStoresPanel.astro', 'the block/unblock menu item needs the raw flag to know which verb to offer'],
  ['pages/api/admin/moderation.ts', 'sets it'],
  ['pages/admin/index.astro', 'passes blockedOnly through to the list filter above'],
  ['pages/api/store-feed/[token].ts', 'the seller\'s own outbound catalog pipe — see its comment for why only an admin block stops it'],
]);

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** A store's lifecycle flags being read directly. `.blocked` alone is too common to match
 *  safely (products carry one too), so it is matched only on an identifier that reads as a
 *  store, while the three timestamps are unambiguous — no other record here has them. */
const INLINE_RULE = /\b(?:store|shopStore|s)\??\.(?:blocked)\b|\b\w+\??\.(?:pausedAt|closedAt|closePendingAt)\b/;

/** Ad campaigns carry their own unrelated `pausedAt` — a campaign being paused has nothing to do
 *  with a store being paused, and the modules that read it are about campaigns, not stores. */
const CAMPAIGN_FILE = /campaign|ad-metrics/i;

describe('store visibility is defined once', () => {
  it('nobody reads a store lifecycle flag outside the module that owns it', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR, ['.ts', '.astro'])) {
      const rel = file.slice(SRC_DIR.length);
      if (ALLOWED.has(rel) || CAMPAIGN_FILE.test(rel)) continue;
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*/, '');   // prose about the rule is fine
        if (INLINE_RULE.test(code)) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(
      offenders,
      `Use isStoreVisible / isStoreDiscoverable / canStoreSell (lib/stores.ts) instead of reading the flags:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // Measured, not assumed: a closed store used to be rewritten to `/404?gone=store`, where the
  // page set `Astro.response.status = 410` — and Astro FORCED it back to 404, so the store
  // answered 404 while every line of code said 410. Nothing failed; it was found by curling a
  // real build. `/store-gone` exists because a rewrite to `/404` can never carry another status,
  // and this stops the next "why do we have two error routes?" cleanup from undoing it.
  it('rewrites a closed store to its own 410 route, never to the 404 one', () => {
    for (const rel of ['pages/[storeSlug]/index.astro', 'pages/[storeSlug]/[productSlug].astro']) {
      const src = readFileSync(join(SRC_DIR, rel), 'utf8');
      expect(src, `${rel} must rewrite the gone case to /store-gone`).toContain("'/store-gone'");
      expect(src, `${rel} must not route the gone case through /404`).not.toContain('gone=store');
    }
  });

  it('every allowlist entry still exists, so the list cannot quietly rot', () => {
    const present = new Set(walk(SRC_DIR, ['.ts', '.astro']).map((f) => f.slice(SRC_DIR.length)));
    for (const rel of ALLOWED.keys()) expect(present.has(rel), `${rel} is allowlisted but gone`).toBe(true);
  });
});
