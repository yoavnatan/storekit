/**
 * **The iron rule, as a test: a secondary service never sits in the buyer's pipeline.**
 *
 * Analytics, the ad feeds, the approval monitor, the notification senders and the background jobs
 * all exist to serve the seller and the platform. Not one of them is something a shopper is waiting
 * for, so not one of them may be on the path that renders a store, renders a product, or takes
 * money. When Google's API is slow, when a seller's feed URL hangs, when Merchant Center rejects
 * the whole document — the mall stays open. That is the property, and this file is what keeps it
 * from being re-decided by whoever adds the next import.
 *
 * **Why an import guard and not a review note.** The regression is invisible in the diff that causes
 * it. `import { runMerchantStatusCheck } from '…'` at the top of a store page looks like every other
 * import on the page, and it behaves perfectly for as long as Google answers quickly. It misbehaves
 * only during somebody else's outage, which is not reproducible in staging and not visible in a
 * screenshot. Same argument as `outbound-fetch-guard.test.ts`, which catches the neighbouring shape.
 *
 * **DIRECT imports, and the limit is deliberate rather than lazy.** A transitive scan was written
 * first and rejected: `[storeSlug]/index.astro` reaches `outbound-fetch.ts` today, through
 * `custom-domain.ts` → `custom-domain-cloudflare.ts`, and reaching it is not the same as calling it
 * — the page uses only that module's pure URL helpers, and the Cloudflare provider is constructed
 * behind `getCustomDomainProvider()`, which the page never calls. A guard that failed on that would
 * be a guard somebody switches off. What is worth catching mechanically is the deliberate act of
 * writing one of these names into a page a buyer loads, and that is what this checks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pages a shopper's money and attention actually pass through. Not "every public page" — a
 * seller-facing dashboard route is allowed to wait on the ads API, because a seller reading an ads
 * report has asked for exactly that.
 */
const BUYER_PATH = [
  'src/pages/index.astro',
  'src/pages/[storeSlug]/index.astro',
  'src/pages/[storeSlug]/[productSlug].astro',
  'src/pages/checkout.astro',
  'src/pages/search.astro',
  'src/pages/stores.astro',
  'src/pages/api/checkout.ts',
  'src/pages/api/cart/prices.ts',
  'src/components/StoreProductModal.astro',
];

/**
 * Module names that must not appear in an import on any of the above, each with the outage it
 * would import along with itself.
 *
 * `lib/email/` is NOT here, and that is a decision rather than an omission: `/api/checkout` genuinely
 * does send the order confirmation, and it is correct that it does. What makes that safe is the
 * `void` in front of it — the order is already written and the send is never waited on — and the
 * shape is enforced tree-wide by `async-lib-awaited.test.ts`, which is the right instrument for it.
 * Banning the import here would have said the wrong thing: the problem was never the email.
 */
const FORBIDDEN: { fragment: string; because: string }[] = [
  { fragment: 'merchant-status', because: "Google's and Meta's approval APIs — the buyer's page would wait on somebody else's rate limit" },
  { fragment: 'product-feed', because: 'building the platform-wide ad feed; catalogue-sized work, and a shopper is looking at one product' },
  { fragment: 'store-feed-sync', because: "pulling a seller's external inventory URL — an outbound request to a server we do not control" },
  { fragment: 'feed-fetch', because: 'the same outbound pull, one layer down' },
  { fragment: 'indexnow', because: 'telling search engines a URL changed; nothing a buyer is waiting for' },
  { fragment: 'lib/jobs/', because: 'the background scheduler. It is ignited from middleware and awaits nothing; a page that imported it would be a page that runs jobs' },
  { fragment: 'google-auth', because: "minting a Google service-account token — a network round trip to Google before the page can render" },
  { fragment: 'image-derive', because: 'warming Cloudinary renders. Correct at SAVE time, on the seller\'s request; on a buyer\'s page it puts the CDN in front of the HTML' },
  { fragment: 'critical-alert', because: 'the alert channel that emails a human. It belongs behind the error log, never in a render' },
];

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** Import specifiers only — a module NAME inside a comment or a string is not a dependency, and
 *  several of these files discuss the feed at length in their headers on purpose. */
function importedModules(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) found.push(m[1]!);
  return found;
}

describe('the buyer path imports no secondary service', () => {
  for (const file of BUYER_PATH) {
    it(`${file}`, () => {
      const specifiers = importedModules(read(file));
      const offences = FORBIDDEN.flatMap(({ fragment, because }) =>
        specifiers.filter((s) => s.includes(fragment)).map((s) => `${s} — ${because}`),
      );
      expect(offences).toEqual([]);
    });
  }
});

describe('the guard itself', () => {
  it('reads import specifiers and not prose', () => {
    // Every file in the list above discusses the feed, the ad networks or the CDN in its header, so
    // a substring search over the whole source would fail all of them on day one — and the fix for
    // that failure would have been to delete the explanations.
    const sample = [
      "// the merchant-status job reads this feed — see lib/product-feed.ts",
      "import { getStoreBySlug } from '../lib/stores.js';",
      "const note = 'indexnow is pinged from the save path';",
    ].join('\n');
    expect(importedModules(sample)).toEqual(['../lib/stores.js']);
  });

  it('catches the shape it exists for', () => {
    const bad = "import { runMerchantStatusCheck } from '../../lib/merchant-status-check.js';";
    expect(importedModules(bad).some((s) => s.includes('merchant-status'))).toBe(true);
  });

  it('catches a dynamic import too — deferring the load does not defer the outage', () => {
    const lazy = "const feed = await import('../../lib/product-feed.js');";
    expect(importedModules(lazy).some((s) => s.includes('product-feed'))).toBe(true);
  });
});
