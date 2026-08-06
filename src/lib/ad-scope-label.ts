/** How an ad campaign's SCOPE and TARGETING are worded — one rule for the seller dashboard's
 *  server-rendered cards, the admin's per-store twin, and the client-side rebuild in
 *  scripts/dashboard/advertising.ts.
 *
 *  Pure and isomorphic (no fs, no category tree, no i18n import) so those three surfaces cannot
 *  word the same campaign differently. The targeting line already lived as three private copies
 *  that had to be edited in lockstep; a campaign may now cover several products or several
 *  categories, which is exactly the kind of new state that rots a copy nobody remembers to open.
 */
import { formatScopeNames } from './sale-scope-label.js';
import { roundMoney } from './money.js';

/** 'product' (one) and 'products' (several) are one decision in the UI — the seller ticks a
 *  list. They stay two stored values so a single-product campaign keeps the exact row shape it
 *  has always had (productId/productName), which every pre-existing reader still understands. */
export type AdScopeKind = 'store' | 'product' | 'products' | 'categories';

/** The label bag both callers can satisfy: the dashboard's typed translation table (extra keys
 *  are ignored) and the client's plain `Record<string, string>` i18n bag (Partial = no key is
 *  structurally required). */
export type AdScopeLabels = Partial<Record<
  | 'adScopeStore' | 'adScopeAndMore' | 'adAutoPerProduct' | 'adAudienceAll'
  | 'adGenderWomen' | 'adGenderMen' | 'adAgeInfant' | 'adAgeKids' | 'adAgeAdult'
  | 'adDuration7' | 'adDuration14' | 'adDuration30' | 'adDurationOngoing'
  | 'adHealthStarved' | 'adHealthPartial' | 'adHealthSoldOut' | 'adHealthPartialStock'
  | 'adHealthNoImage',
  string>>;

/** How much of what a campaign advertises is still on the storefront, how much of THAT the ad
 *  platforms will carry, and how much a shopper can actually buy right now (ad-campaign-health.ts). */
export interface CampaignHealthView { total: number; live: number; advertisable?: number; buyable?: number }

/** The one line that tells a seller his campaign stopped, or is running on less than he chose.
 *  '' when everything it names is still live — a card with nothing wrong says nothing.
 *
 *  Two different messages on purpose: a campaign the platform paused has to say so (a bare
 *  "paused" badge reads as something the seller did himself and forgot), while one that merely
 *  lost part of its list keeps running and only reports the gap. */
export function campaignHealthNote(
  health: CampaignHealthView | undefined,
  pausedReason: string | undefined,
  l: AdScopeLabels,
): string {
  // Ordered by what the seller has to do about it: a campaign the platform stopped comes first
  // (and says which kind of stop it is), then a campaign still running on less than he chose.
  // One line only — two stacked warnings on one card read as noise and get skimmed past.
  // The stored reason is why it STOPPED; `health` is what is true now, and they can disagree —
  // a seller who puts a blocked product back on the shelf, sold out, is still looking at a paused
  // campaign whose stored reason says "nothing on the storefront". Believe the live counts for
  // the wording (the resume guard reads them too), and keep the stored reason for the case they
  // agree on. Otherwise the card tells him to do something he already did.
  const starved = !health || health.live === 0;
  if (pausedReason === 'unavailable' && starved) return l.adHealthStarved ?? '';
  if (pausedReason && health && health.buyable === 0) return l.adHealthSoldOut ?? '';
  if (pausedReason === 'out-of-stock') return l.adHealthSoldOut ?? '';
  if (!health) return '';
  const fill = (template: string, missing: number): string =>
    template.replace('{gone}', String(missing)).replace('{total}', String(health.total));
  if (health.live < health.total) return fill(l.adHealthPartial ?? '', health.total - health.live);
  // Ahead of the stock line because it outranks it on "what can he do about it": a product with no
  // photo is not in Merchant Center at all, and uploading one is entirely in his hands, where a
  // stock-out resolves itself. Silent until now — the campaign counted the product and the feed
  // dropped it (product-feed.ts#isProductAdvertisable).
  if (health.advertisable !== undefined && health.advertisable < health.live) {
    return fill(l.adHealthNoImage ?? '', health.live - health.advertisable);
  }
  if (health.buyable !== undefined && health.buyable < health.live) {
    return fill(l.adHealthPartialStock ?? '', health.live - health.buyable);
  }
  return '';
}

/** The management fee inside a campaign's spend — what the seller paid MINUS what reached
 *  Google/Meta. Zero (→ null, so the card says nothing) for a campaign with no spend yet, or on
 *  a legacy stats object from before the split existed. Derived here rather than re-multiplying
 *  a percentage per card: the percentage lives in pricing.ts and this is simply its consequence,
 *  so the card can never quote a fee the books disagree with. */
export function campaignFeeOf(stats: { spend: number; adSpend?: number } | undefined): number | null {
  if (!stats || typeof stats.adSpend !== 'number') return null;
  const fee = roundMoney(stats.spend - stats.adSpend);
  return fee > 0 ? fee : null;
}

/** The campaign fields these two labels read — deliberately narrower than AdCampaign so the
 *  client's own Campaign interface (no fs types) satisfies it too. */
export interface CampaignScopeView {
  scope?: string;
  productName?: string;
  productNames?: string[];
  categoryNames?: string[];
  durationDays?: number;
  audience?: { gender: string; age: string };
}

/** The card's headline: what this campaign advertises. Names, not "3 products" — a named
 *  product/category is something the seller can act on; past a couple the tail collapses into a
 *  count, the same rule the storefront sale banner uses (sale-scope-label.ts). */
export function campaignScopeName(c: CampaignScopeView, l: AdScopeLabels): string {
  const andMore = l.adScopeAndMore ?? '+{n}';
  if (c.scope === 'categories') return formatScopeNames(c.categoryNames ?? [], andMore);
  if (c.scope === 'product' || c.scope === 'products') {
    // Legacy rows (and any single-product campaign) carry only the flat productName.
    const names = c.productNames?.length ? c.productNames : c.productName ? [c.productName] : [];
    return formatScopeNames(names, andMore);
  }
  return l.adScopeStore ?? '';
}

/** Compact "women · kids · 14 days" summary under the headline. A store-wide campaign has no
 *  single audience — each product self-targets by its own feed attributes — so it says so
 *  instead of implying an untargeted campaign. */
export function campaignTargetingLabel(c: CampaignScopeView, l: AdScopeLabels): string {
  const parts: string[] = [];
  if (c.scope === 'store') {
    parts.push(l.adAutoPerProduct ?? '');
  } else {
    const ages: Record<string, string | undefined> = {
      infant: l.adAgeInfant, kids: l.adAgeKids, adult: l.adAgeAdult,
    };
    if (c.audience?.gender === 'women') parts.push(l.adGenderWomen ?? '');
    else if (c.audience?.gender === 'men') parts.push(l.adGenderMen ?? '');
    const age = c.audience?.age ? ages[c.audience.age] : undefined;
    if (age) parts.push(age);
    if (parts.length === 0) parts.push(l.adAudienceAll ?? '');
  }
  parts.push(
    c.durationDays === 7 ? (l.adDuration7 ?? '')
    : c.durationDays === 14 ? (l.adDuration14 ?? '')
    : c.durationDays === 30 ? (l.adDuration30 ?? '')
    : (l.adDurationOngoing ?? ''),
  );
  return parts.filter(Boolean).join(' · ');
}
