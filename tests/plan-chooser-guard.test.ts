/**
 * There is ONE plan, so there is no chooser anywhere — and this is the guard that keeps it that way.
 *
 * ── What this file used to hold, and why it is worth reading before re-adding a chooser ──
 * Until 2026-09-08 a seller could move between four tiers, and the rule here was the opposite: the
 * pills that let him must exist in exactly ONE place, and must render in BOTH of a shop's lives.
 * That rule was written because the chooser had been built inside `GoLiveSteps.astro`, which renders
 * only while something is still holding a shop off the site — so the moment a seller succeeded (paid,
 * live, selling) his plan was fixed, with `/pricing` a marketing page that changes nothing. The owner
 * asked where a running shop changes plan three times and the honest answer each time was "nowhere".
 *
 * ── Why the ladder went ──
 * The tiers differed in exactly one thing: a higher fee bought a lower per-sale commission. The
 * commission went when the seller started clearing into his OWN account (`docs/pivot-saas.md`) —
 * the buyer's money never passes through us, so there is nothing to take a percentage of. Four rows
 * differing only in price is four prices for one product, and nobody would choose any but the
 * cheapest. Owner, 2026-09-08: one plan.
 *
 * ── Why a scan, still ──
 * A chooser is not one component. It is markup carrying `data-role="plan"`, a route that patches a
 * running standing order at the processor, and a handler that repaints figures from the pressed
 * pill — and it grew back once already, in a second hand-written copy. Holding "there is none" by
 * grep is the only form of the rule that covers a component nobody has written yet. If a ladder is
 * ever wanted again, the paragraph above is the design brief, not a reason to skip this file.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { readSource } from './helpers/source-guard.js';
import { join } from 'node:path';
import { SELLER_TIERS } from '../src/lib/pricing.js';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(astro|ts)$/.test(name)) out.push(full);
  }
  return out;
}

const SRC = walk('src');

describe('one plan, and nothing that offers a choice of plans', () => {
  it('the price table itself holds exactly one row, and it takes no commission', () => {
    // Everything below is about screens. This is the fact they render, and if it changes the
    // screens are supposed to change with it — which is why the assertion sits at the top of the
    // file that forbids them.
    expect(SELLER_TIERS).toHaveLength(1);
    expect(SELLER_TIERS[0]!.commissionPercent).toBe(0);
  });

  it('nothing renders a plan pill', () => {
    // `data-role="plan"` was the contract the click handler read — the tier, the fee and the
    // commission it repainted from. Its absence is what says the chooser is gone rather than
    // merely hidden.
    const offenders = SRC.filter((f) => readSource(f).includes('data-role="plan"'));
    expect(offenders, 'a plan chooser is back').toEqual([]);
  });

  it('no route patches a seller onto a different plan', () => {
    // `/api/seller/tier` amended the standing order at PayMe and recorded the new tier only if they
    // accepted it. With one plan there is nothing to amend, and the only change a seller can make
    // to his subscription is ending it (`subscription-cancel.ts`).
    // Comments stripped: three of the files that REPLACED this route name it, explaining what they
    // replaced. A guard broken by its own documentation is the first trap `helpers/source-guard.ts`
    // exists for, and it caught this on the first run.
    const offenders = SRC.filter((f) => readSource(f).includes('/api/seller/tier'));
    expect(offenders, 'the plan-change route is back').toEqual([]);
    expect(() => statSync(join('src', 'pages', 'api', 'seller', 'tier.ts'))).toThrow();
  });

  it('no seller-facing screen quotes a per-sale commission', () => {
    // The seller pays a monthly fee and nothing else. A surface still printing a percentage would
    // be describing a charge that cannot occur — and this is the direction that costs trust, since
    // he would read it before ever seeing a bill.
    // Screens only. `pages/api/` is excluded deliberately: `/api/checkout` still computes a
    // `market_fee` from the rate and now sends zero, which is the true number and the shape that
    // keeps the split transport working the day it is switched back on. What must not exist is a
    // surface TELLING a seller he is charged a percentage.
    const offenders = SRC
      .filter((f) => /components|pages/.test(f) && !f.includes(join('pages', 'api')))
      .filter((f) => /commissionPercent|feeSchedCommissionValue|subCommission\b/.test(readSource(f)));
    expect(offenders, 'a screen still quotes a commission').toEqual([]);
  });
});
