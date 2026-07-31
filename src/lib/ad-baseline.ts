/** The platform-funded baseline: is this store actually IN it, and what has it accrued?
 *
 *  The baseline card is the first thing a seller reads on the Advertising tab, and it made two
 *  claims it could not keep:
 *    1. It said "impressions in the last 30 days" while showing a flat seeded number with no
 *       period behind it at all — a figure that never moved, under a label that promised a window.
 *    2. It said "active" for every store, including one that is not in the product feed. A store
 *       with no visible product is deliberately kept out of discovery, search and the sitemap
 *       (store-readiness.ts), so the baseline campaign has nothing of its to promote — and the
 *       card was telling that seller the platform was advertising him anyway.
 *
 *  Both numbers now come from the same place as the campaign metrics (ad-metrics.ts), over the
 *  same window the label names, and the card says plainly when the store is not in the feed —
 *  which is the one case where the seller has something to DO about it.
 *
 *  Pure: takes the two facts it needs rather than reading the store or its products, so the seller
 *  tab and the admin's per-store twin can't answer this differently.
 */
import { baselineImpressionsInRange } from './ad-metrics.js';
import { isStoreReady } from './store-readiness.js';
import { presetRange } from './date-range.js';

export interface BaselineInput {
  storeId: string;
  /** Is the store on platform surfaces at all — stores.ts#isStoreDiscoverable? False for an
   *  admin block, for a store its seller paused, and for a closed one; all three are out of the
   *  product feed, so the platform campaign has nothing of theirs to carry and the card must not
   *  claim otherwise. Passed in rather than read here so this stays pure. */
  discoverable: boolean;
  /** Products a shopper can see (already gated for hidden/blocked). */
  visibleProductCount: number;
}

export interface BaselineStatus {
  /** Whether the platform-funded campaign carries this store at all. */
  active: boolean;
  /** Impressions over the window the card's label names. Zero when not carried — a store outside
   *  the feed accrues nothing, and showing a number there would be the original lie again. */
  impressions: number;
}

/** The window the baseline card reports on, matching its own label ("last 30 days"). */
const BASELINE_WINDOW = '30d' as const;

export function storeBaselineStatus(input: BaselineInput, today: Date = new Date()): BaselineStatus {
  const active = input.discoverable && isStoreReady({ visibleProductCount: input.visibleProductCount });
  if (!active) return { active: false, impressions: 0 };
  const { from, to } = presetRange(BASELINE_WINDOW, today)!;
  return { active: true, impressions: baselineImpressionsInRange(input.storeId, from, to) };
}
