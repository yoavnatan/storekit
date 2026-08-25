/**
 * A seller must be able to change plan in **both** of a shop's lives, and the pills that let him
 * must exist in exactly one place.
 *
 * ── What went wrong ──
 * The chooser was written inside `GoLiveSteps.astro`, which renders only while something is still
 * holding a shop off the site. So the moment a seller succeeded — paid, live, selling — his plan
 * was fixed: the card that replaced the go-live screen stated the plan and offered no way off it,
 * and `/pricing` is a marketing page that changes nothing. The owner asked where a running shop
 * changes plan three times (2026-08-24, twice on 2026-08-25) and the honest answer each time was
 * "nowhere". Copy for the button (`subChangePlan`) had existed since the first of those questions
 * with no control under it.
 *
 * ── Why a scan and not a render test ──
 * The pills carry the contract the click handler reads — `data-role="plan"` plus the tier, the
 * commission and the fee it repaints from. A second hand-written copy of that markup is this
 * repo's most repeated bug shape: one of the two gets a new attribute and the other silently keeps
 * working with a stale one. Holding "there is exactly one" by grep is the only form of the rule
 * that covers a component nobody has written yet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(astro|ts)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = walk('src');
const read = (f: string): string => readFileSync(f, 'utf8');

describe('the plan chooser', () => {
  it('is written in exactly one component', () => {
    // The attribute the handler selects on. Its own definition inside the script is not markup, so
    // only files that DRAW a button with it count.
    const drawers = FILES.filter((f) => f.endsWith('.astro') && read(f).includes('data-role="plan"'));
    expect(drawers).toEqual([join('src', 'components', 'dashboard', 'PlanPills.astro')]);
  });

  it('is reachable from a shop that is already live', () => {
    // `SubscriptionCard` is the component that renders in BOTH states — bare inside the go-live
    // step, framed on its own once the shop is up. If the pills ever move back out of it, one of
    // the two states loses them again, and it will be the live one because that is the state
    // nobody is looking at while building the go-live flow.
    const card = read(join('src', 'components', 'dashboard', 'SubscriptionCard.astro'));
    expect(card).toContain('PlanPills');
    // Twice: once for the go-live step, once behind the switch button on a running subscription.
    expect(card.match(/<PlanPills/g)?.length).toBe(2);
    expect(card).toContain('id="sub-plan-toggle"');
  });

  it('does not offer a cheaper plan by sending the seller off the dashboard', () => {
    // The retention step's offer used to be an `<a href="/pricing">` — the only thing it could be
    // when the plan could not be changed from this card. With the chooser here it must DO the
    // thing; a link would abandon the cancel dialog on a marketing page.
    const card = read(join('src', 'components', 'dashboard', 'SubscriptionCard.astro'));
    const offer = card.slice(card.indexOf('subCancelCheaper') - 200, card.indexOf('subCancelCheaper'));
    expect(offer).toContain('data-open-plans');
    expect(offer).not.toContain('href=');
  });
});
