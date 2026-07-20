// Qualitative benchmarking for a campaign's quality metrics (CURRENT_TASK.md →
// סשן ג׳ #4). ROAS (revenue per ₪ spent) and CTR (share of viewers who clicked)
// are the two campaign figures with a real good/bad benchmark — impressions/
// clicks/spend are volume/inputs that scale with the budget, so a "low/high"
// label there would mislead. This turns each into a low/mid/high tier + a
// color-coded chip so a non-PPC seller can tell at a glance whether the campaign
// is working.
//
// Pure + isomorphic (no node deps) so the same chip renders SSR and inside the
// client campaign-card builder — kept separate from ad-metrics.ts/ad-campaigns.ts,
// which import node:crypto and can't be bundled into client code.

export type Tier = 'low' | 'mid' | 'high';
export interface TierLabels { low: string; mid: string; high: string }

// x2 = revenue is twice the ad spend (a common "worth it" floor once product
// cost is accounted for); x4+ = a strongly profitable campaign.
export function roasTier(roas: number): Tier {
  if (roas >= 4) return 'high';
  if (roas >= 2) return 'mid';
  return 'low';
}

// CTR benchmarks blend Google + Meta e-commerce norms: under ~1% is weak, ~1–3%
// is typical, 3%+ means the creative/audience is pulling well.
export function ctrTier(ctr: number): Tier {
  if (ctr >= 3) return 'high';
  if (ctr >= 1) return 'mid';
  return 'low';
}

const CHIP_CLASSES: Record<Tier, string> = {
  high:
    'text-[color:var(--color-success)] bg-[color:color-mix(in_srgb,var(--color-success)_14%,transparent)]',
  mid:
    'text-[color:var(--color-warning)] bg-[color:color-mix(in_srgb,var(--color-warning)_16%,transparent)]',
  low:
    'text-[color:var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_14%,transparent)]',
};

// Labels are fixed i18n copy, no user data — safe to inject via set:html.
function tierChip(tier: Tier, labels: TierLabels): string {
  const label = tier === 'high' ? labels.high : tier === 'mid' ? labels.mid : labels.low;
  return `<span class="inline-block align-middle ms-1 text-[0.62rem] font-bold px-[0.4rem] py-[0.05rem] rounded-full ${CHIP_CLASSES[tier]}">${label}</span>`;
}

/** A נמוך/בינוני/גבוה pill for ROAS. '' for a paused/zero campaign (all-0 stats). */
export function roasTierChipHtml(roas: number, labels: TierLabels): string {
  return roas > 0 ? tierChip(roasTier(roas), labels) : '';
}

/** A נמוך/בינוני/גבוה pill for CTR. '' for a paused/zero campaign (all-0 stats). */
export function ctrTierChipHtml(ctr: number, labels: TierLabels): string {
  return ctr > 0 ? tierChip(ctrTier(ctr), labels) : '';
}
