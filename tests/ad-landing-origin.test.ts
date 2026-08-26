/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://dezabin.co.il/acme/shirt?ad=1" }
 */
/**
 * An ad session must stay on ONE origin.
 *
 * The 301 that moves a custom-domain store's platform URL onto the seller's domain is per-REQUEST,
 * and `?ad=1` stands it down for exactly the request that carries it. So the exemption used to
 * cover the landing and nothing after it: every in-store link on that page pointed at an unmarked
 * platform path, and the first click 301'd the shopper to a second origin — where the localStorage
 * cart and the session cookie do not exist (memory `project_custom_domain_host_surfaces`). A paid
 * click could add to cart and lose it on the next navigation.
 *
 * Both halves are asserted here, because they are opposites that share a module and must not be
 * allowed to both fire: on the custom domain the store slug is STRIPPED from in-store links, and on
 * a platform ad landing the marker is ADDED to them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initAdLandingLinks, initCustomDomainLinks } from '../src/lib/custom-domain-links.js';

const SLUG = 'acme';

function page(html: string): void {
  document.body.innerHTML = html;
}
function hrefs(): string[] {
  return [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
}
/** The observer fires on a microtask, so a mutation has to be awaited before it can be asserted. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('initAdLandingLinks', () => {
  it('marks every in-store link so no click leaves the platform origin', () => {
    page(`
      <a href="/acme">back to store</a>
      <a href="/acme/other">related product</a>
      <a href="/acme?category=shoes">category</a>
    `);
    initAdLandingLinks(SLUG, true);
    expect(hrefs()).toEqual(['/acme?ad=1', '/acme/other?ad=1', '/acme?category=shoes&ad=1']);
  });

  it('leaves everything that is not an in-store link alone', () => {
    // `/checkout` is on this origin already; `/` and another store are deliberately elsewhere, and
    // a marker they ignore would only pollute their URLs.
    page(`
      <a href="/checkout?store=acme">checkout</a>
      <a href="/">home</a>
      <a href="/acme-supplies/x">a DIFFERENT store whose slug starts the same</a>
      <a href="https://elsewhere.example/acme">absolute</a>
    `);
    initAdLandingLinks(SLUG, true);
    expect(hrefs()).toEqual([
      '/checkout?store=acme', '/', '/acme-supplies/x', 'https://elsewhere.example/acme',
    ]);
  });

  it('keeps a fragment after the query, not before it', () => {
    page('<a href="/acme/shirt#reviews">reviews</a>');
    initAdLandingLinks(SLUG, true);
    expect(hrefs()).toEqual(['/acme/shirt?ad=1#reviews']);
  });

  it('never marks a link twice', () => {
    page('<a href="/acme/shirt?ad=1">already marked</a>');
    initAdLandingLinks(SLUG, true);
    expect(hrefs()).toEqual(['/acme/shirt?ad=1']);
  });

  it('reaches links added after load — load-more, the quick-view modal, related products', async () => {
    page('<div id="grid"></div>');
    initAdLandingLinks(SLUG, true);
    document.getElementById('grid')!.innerHTML = '<a href="/acme/late">loaded later</a>';
    await settle();
    expect(hrefs()).toEqual(['/acme/late?ad=1']);
  });

  it('does nothing at all when this is not an ad landing', () => {
    // Every ordinary visit: the 301 to the seller's domain is the whole point and must still fire.
    page('<a href="/acme/shirt">product</a>');
    initAdLandingLinks(SLUG, false);
    expect(hrefs()).toEqual(['/acme/shirt']);
  });

  it('does nothing without a slug', () => {
    page('<a href="/acme/shirt">product</a>');
    initAdLandingLinks('', true);
    expect(hrefs()).toEqual(['/acme/shirt']);
  });
});

describe('the two link rewriters are opposites and never both apply', () => {
  it('on the custom domain the slug is stripped and no marker is added', () => {
    // `initCustomDomainLinks` compares the host it is GIVEN against `location.hostname`, so what
    // this passes is the document's own host — the document cannot be moved to another origin from
    // inside a test, and the value itself is not what the rule turns on: the MATCH is.
    page('<a href="/acme/shirt">product</a><a href="/acme">store</a>');
    initCustomDomainLinks(SLUG, location.hostname);
    // An ad landing is a PLATFORM-host condition (custom-domain.ts#isPlatformAdLanding), so this
    // call is what the page makes on the seller's domain: false, and a no-op.
    initAdLandingLinks(SLUG, false);
    expect(hrefs()).toEqual(['/shirt', '/']);
  });

  it('on a platform ad landing the slug is kept and the marker is added', () => {
    page('<a href="/acme/shirt">product</a>');
    initCustomDomainLinks(SLUG, 'acme.co.il'); // no-op: we are not on that host
    initAdLandingLinks(SLUG, true);
    expect(hrefs()).toEqual(['/acme/shirt?ad=1']);
  });
});
