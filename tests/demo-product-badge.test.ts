import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoProductBadgeHtml, DEMO_BADGE_CLASS } from '../src/lib/demo-badge.js';

/**
 * "מוצר לדוגמה" has to be on the product, everywhere the product is.
 *
 * `demo-store-isolation.test.ts` guards the opposite direction — that a showcase product never
 * leaks OUT to Google or Meta. This guards the inward one: the disclosure rule in
 * `lib/demo-stores.ts` is that a shopper must never discover the store was a demo only at the
 * checkout refusal, and that rule is only as good as the surface that forgets it.
 *
 * It had already been forgotten four times over. The badge existed on the store page's grid and on
 * the full product page, and nowhere else — not on the homepage spotlight tiles, not in site
 * search, and not in either product modal, which is the surface a shopper on the store page
 * actually reads before adding to the cart. The two copies that DID exist were hand-written twins
 * that had drifted in icon size, plus a third copy of the same SVG inside the client-side card
 * renderer.
 *
 * So this pins two things, and they are separate claims:
 *   1. one module renders the badge, and every surface calls IT (no fourth hand-written copy);
 *   2. the flag reaches the client surfaces that need a server to tell them.
 *
 * Source-scanning, like the isolation test next to it, and for the same reason: the failure is a
 * surface that silently stops asking. Nothing errors, the page still renders, the words are just
 * gone.
 */

const ROOT = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('lib/demo-badge.ts is the only spelling of the badge', () => {
  it('renders the label, escaped, with the icon', () => {
    const html = demoProductBadgeHtml('מוצר לדוגמה');
    expect(html).toContain('מוצר לדוגמה');
    expect(html).toContain('<svg');
    expect(demoProductBadgeHtml('<script>x</script>')).not.toContain('<script>');
  });

  it('positions the chip absolutely — an in-flow badge retells the grid', () => {
    // Why it matters: in flow it added a line to every card of a showcase store, so the same card
    // was taller in a demo store than in a real one (owner, 2026-08-12).
    expect(DEMO_BADGE_CLASS.chip).toContain('absolute');
    // `start-*`, never `inset-inline-start-*` — the latter is not a Tailwind utility, compiles to
    // nothing, and the chip sits flush against the edge (owner, 2026-08-13).
    expect(DEMO_BADGE_CLASS.chip).toContain('start-2');
    expect(DEMO_BADGE_CLASS.chip).not.toContain('inset-inline-start');
    // In a text column the words are the point; a pill would compete with the name under it.
    expect(DEMO_BADGE_CLASS.inline).not.toContain('absolute');
  });

  it('is not re-implemented anywhere — the badge icon appears in exactly one module', () => {
    // The information-circle path, which is what every hand-written copy carried. If this fails,
    // a surface has grown its own badge again instead of importing this one.
    const MARK = 'M12 7.6v.6';
    const OWNERS = [
      'lib/demo-badge.ts',       // the badge itself
      'components/StoreDemoBadge.astro', // the per-STORE pill — same mark, different statement
    ];
    const files = [
      'pages/[storeSlug]/index.astro',
      'pages/[storeSlug]/[productSlug].astro',
      'pages/search.astro',
      'pages/index.astro',
      'components/HomeProductCard.astro',
      'components/ProductQuickView.astro',
      'components/StoreProductModal.astro',
      'components/Header.astro',
    ];
    for (const f of files) expect(read(f), `${f} hand-wrote the badge icon`).not.toContain(MARK);
    for (const f of OWNERS) expect(read(f)).toContain(MARK);
  });
});

describe('every surface that can show a showcase product shows the badge', () => {
  const CALLERS: [string, string][] = [
    ['pages/[storeSlug]/[productSlug].astro', 'the full product page'],
    ['pages/search.astro', 'site search results'],
    ['components/HomeProductCard.astro', 'the homepage spotlight tiles'],
  ];
  for (const [file, what] of CALLERS) {
    it(`${what} renders ProductDemoBadge`, () => {
      expect(read(file)).toMatch(/<ProductDemoBadge\b/);
    });
  }

  it('the store page renders it server-side AND hands the SAME html to its card renderer', () => {
    // SSR/AJAX parity: "load more" rebuilds cards in the browser, and a client renderer that
    // rebuilds the badge from parts is how the two drifted the first time
    // (memory `project_client_renderer_i18n_drift`).
    const src = read('pages/[storeSlug]/index.astro');
    expect(src).toContain("demoProductBadgeHtml(t.demo.productBadge, 'chip')");
    expect(src).toContain('data-demo-badge=');
    expect(src).toContain('dataset.demoBadge');
  });

  it('both product modals render it from the endpoint flag', () => {
    for (const f of ['components/ProductQuickView.astro', 'components/StoreProductModal.astro']) {
      const src = read(f);
      expect(src, `${f} does not import the badge`).toContain("from '../lib/demo-badge.js'");
      expect(src, `${f} ignores storeDemo`).toContain('storeDemo');
    }
  });

  it('the header search dropdown labels a showcase hit', () => {
    // Too small for the chip, so it rides the store line — but it is a shopper's shortest path
    // from a search box to a demo product, so it cannot be the one surface that says nothing.
    expect(read('components/Header.astro')).toContain('p.demo && strDemo');
  });
});

describe('the flag reaches the client', () => {
  it('/api/store-product sends storeDemo', () => {
    const src = read('pages/api/store-product.ts');
    expect(src).toContain('storeDemo: isDemoStore(store)');
  });

  it('site search marks a hit from a showcase store', () => {
    const src = read('lib/site-search.ts');
    expect(src).toContain('isDemoStore(store)');
  });
});
