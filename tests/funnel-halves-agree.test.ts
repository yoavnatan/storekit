/**
 * The buyer funnel has TWO halves and they must not drift apart.
 *
 * `lib/tracking.ts` states the arrangement: our own funnel is counted server-side, where it cannot
 * be blocked or forged, and Google/Meta are told separately from the browser. The halves are
 * reported independently on purpose — a gap in one must not cost the other its event — and that
 * independence is exactly what let them silently diverge twice.
 *
 *   · `purchase` — counted server-side by `/api/checkout` since it was written, and reported to
 *     neither network until 2026-08-23. Both were being taught to find people who reach the payment
 *     form, no ROAS had a numerator, and Meta's catalog retargeting was missing the event that says
 *     STOP following a buyer with the item they already bought.
 *   · `view_item` — counted server-side by `/api/store-product` for every quick-view open, and
 *     reported by neither network for the SAME opens. That endpoint is how a product is opened from
 *     a store's grid and from the related-products row, so "viewed and did not buy" — the largest
 *     retargeting audience there is — was built only from shoppers who happened to land on a full
 *     product page.
 *
 * Both were invisible in the same way: every test passed, every screen looked right, and the only
 * symptom lived in an ad account nobody has opened yet.
 *
 * So the rule this file holds is narrow and checkable: **a browser surface that causes the server to
 * count a `view_item` must either report `ViewContent`, or carry a written reason why not.** Same
 * shape as `tests/silent-failure-guard.test.ts`, which bans silence that was never DECIDED rather
 * than banning silence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FUNNEL_EVENTS } from '../src/lib/analytics.js';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|astro)$/.test(e.name) ? [p] : [];
  });
}

/** The endpoint whose GET the server records as a product view. */
const VIEW_COUNTING_FETCH = '/api/store-product?';
/** The opt-out marker, which has to be followed by a reason on the same line. */
const OPT_OUT = /no-viewcontent:\s*\S/;

describe('a counted view is a reported view', () => {
  it('every surface that triggers a server-side view_item reports ViewContent, or says why not', () => {
    const offenders = walk('src')
      .filter((f) => readFileSync(f, 'utf8').includes(VIEW_COUNTING_FETCH))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return !src.includes('trackViewContent') && !OPT_OUT.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it('the guard is actually looking at something', () => {
    // A scan that matches no files passes for the wrong reason, which is how a guard quietly stops
    // guarding. Both modals fetch this endpoint; if neither does any more, this rule needs rewriting
    // rather than deleting.
    const surfaces = walk('src').filter((f) => readFileSync(f, 'utf8').includes(VIEW_COUNTING_FETCH));
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the funnel the platform measures', () => {
  it('is the five stages both halves are expected to cover', () => {
    // Pinned so that ADDING a stage is a deliberate act that lands here — and whoever adds one is
    // asked, by this failing test, the question nobody was asked the last two times: does the other
    // half report it too? A stage counted server-side and never sent is not a smaller version of
    // working, it is an ad account optimising towards the wrong thing.
    expect([...FUNNEL_EVENTS]).toEqual(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
  });

  it('every reportable stage below page_view has a reporter in lib/tracking.ts', () => {
    // `page_view` is deliberately absent: it is our own volume measure and neither network has an
    // equivalent worth sending — GTM counts its own page views from the container.
    const tracking = readFileSync('src/lib/tracking.ts', 'utf8');
    for (const [stage, reporter] of [
      ['view_item', 'trackViewContent'],
      ['add_to_cart', 'trackAddToCart'],
      ['begin_checkout', 'trackInitiateCheckout'],
      ['purchase', 'trackPurchase'],
    ] as const) {
      expect(tracking, stage).toContain(`export function ${reporter}`);
      expect(tracking, stage).toContain(stage);
    }
  });
});
