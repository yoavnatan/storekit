import { countRealStores, filterShopperStores, isLiveStore } from './demo-stores.js';
import { seededShuffle, type FeedStore } from './home-feed.js';
import { getStorePreviews, STORE_PREVIEW_SLOTS } from './store-products.js';
import { getVisibleStores } from './stores.js';

/** A handful of stores to keep browsing, for a page that is NOT the homepage — today the
 *  order-confirmation page (`checkout/success.astro`), where the shopper has just finished
 *  paying and has nothing else to do. The homepage builds its own rows through
 *  `home-feed.ts`, which decides between liked / bought-before / new / category shelves; this
 *  is the small, unpersonalised version of only the last of those: a few stores, at random.
 *
 *  Kept out of the page for the usual reason — the page renders, it does not query — and out
 *  of `home-feed.ts` because that module is deliberately pure and database-free (its own
 *  header says why). This one is the opposite: it exists to do the two reads.
 *
 *  The same eligibility rules as the homepage's rows, and reusing the same three helpers
 *  rather than re-deciding them here is the point: a blocked store, a store with no visible
 *  product, and the platform's own showcase stores once there are enough real ones, are all
 *  invisible on discovery surfaces, and this is a discovery surface. A card that leads to a
 *  404 is worse on this page than on any other — it is the first thing a new customer sees
 *  after handing over money.
 */
export async function pickDiscoverStores(
  limit: number,
  /** Store slugs already on the page — the ones just bought from, and any cart still
   *  waiting. Offering a shopper "discover" cards for shops they are demonstrably already
   *  in reads as the page not knowing what just happened. */
  excludeSlugs: readonly string[],
  /** Anything stable per visit — the order id. A refresh of a confirmation page must not
   *  deal a different set of stores; that is what makes the row read as a recommendation
   *  rather than as a slot machine. */
  seed: string,
): Promise<FeedStore[]> {
  const visible = await getVisibleStores();
  if (!visible.length) return [];

  // One query for every store, exactly as the homepage does it — the alternative (shuffle
  // first, then read previews for the winners) would have to re-shuffle whenever a chosen
  // store turned out to have nothing to sell.
  const previews = await getStorePreviews(visible.map((s) => s.id), STORE_PREVIEW_SLOTS);
  const liveRealCount = countRealStores(visible.filter((s) => isLiveStore(previews.get(s.id))));
  const excluded = new Set(excludeSlugs);

  const eligible: FeedStore[] = filterShopperStores(visible, liveRealCount)
    .filter((s) => !excluded.has(s.slug))
    .map((store) => ({ store, preview: previews.get(store.id) }))
    .filter((e) => e.preview?.hasProducts === true)
    .map(({ store, preview }) => ({ store, previewImages: preview!.images }));

  return seededShuffle(eligible, seed).slice(0, limit);
}
