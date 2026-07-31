// @vitest-environment jsdom
//
// The header cart/wishlist badge is painted TWICE on every page load: once by an
// inline seed script in Header.astro (synchronous, so the number is on screen in
// the first paint) and once by the deferred module script, which reads the same
// localStorage through lib/cart.js. Two implementations of one rule.
//
// When they disagree, the badge shows the seed's number and then odometer-rolls
// to the module's — on EVERY page load, forever, because the disagreement is a
// property of the stored cart, not of anything the shopper did. That shipped once
// (the seed counted `gone` lines that getCount() excludes, so a cart holding an
// unavailable product flickered N→N-1 on every navigation), which is what these
// tests exist to prevent a second time.
//
// The seed is run here as real code — extracted from the .astro source — so this
// can't pass by asserting on a copy that has drifted from what ships.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCount } from '../src/lib/cart.js';
import { getWishlistCount } from '../src/lib/wishlist.js';
import { updateBadge } from '../src/lib/badge-ticker.js';

// `import.meta.url` is the jsdom document URL under this environment, not a file
// path — resolve from the project root instead.
const HEADER_SRC = readFileSync(resolve(process.cwd(), 'src/components/Header.astro'), 'utf8');

/** The literal body of Header.astro's `<script is:inline>` cart/wishlist seed. */
function extractSeedScript(): string {
  const blocks = [...HEADER_SRC.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const seed = blocks.filter((b) => b.includes("getElementById('cart-count')"));
  expect(seed, 'Header.astro must have exactly one inline script seeding #cart-count').toHaveLength(1);
  return seed[0]!;
}

function paintBadges(): void {
  document.body.innerHTML = '<span id="cart-count" hidden></span><span id="wishlist-count" hidden></span>';
  new Function(extractSeedScript())();
}

const seededCart = () => document.getElementById('cart-count')!.dataset.tickerValue;

function writeCart(storeSlug: string, items: Record<string, unknown>): void {
  localStorage.setItem(
    `store_cart_v2_${storeSlug}`,
    JSON.stringify({ storeSlug, storeName: storeSlug, items }),
  );
}

const line = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, name: slug, price: 10, qty: 1, image: `${slug}.png`, ...extra,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
});

describe('header cart badge: inline seed agrees with lib/cart getCount()', () => {
  const cases: Array<[string, () => void]> = [
    ['an empty browser', () => {}],
    ['one line in one store', () => writeCart('alpha', { 'widget|': line('widget') })],
    ['several lines in one store', () => writeCart('alpha', {
      'a|': line('a'), 'b|': line('b'), 'c|': line('c'),
    })],
    ['lines spread over several stores', () => {
      writeCart('alpha', { 'a|': line('a'), 'b|': line('b') });
      writeCart('beta', { 'c|': line('c') });
    }],
    // The regression: an unavailable line is listed in the drawer but is not part
    // of what the buyer is buying, so neither counter may include it.
    ['a cart holding one unavailable line', () => writeCart('alpha', {
      'a|': line('a'), 'b|': line('b', { gone: true }),
    })],
    ['a cart whose lines are ALL unavailable', () => writeCart('alpha', {
      'a|': line('a', { gone: true }), 'b|': line('b', { gone: true }),
    })],
    ['one store fully unavailable beside a healthy one', () => {
      writeCart('alpha', { 'a|': line('a', { gone: true }) });
      writeCart('beta', { 'b|': line('b'), 'c|': line('c') });
    }],
    ['a store cart with no lines left', () => writeCart('alpha', {})],
    ['a corrupt cart entry', () => localStorage.setItem('store_cart_v2_alpha', '{not json')],
    ['unrelated localStorage keys', () => {
      localStorage.setItem('some_other_key', '{"items":{"x|":{}}}');
      writeCart('alpha', { 'a|': line('a') });
    }],
    ['qty above 1 (the badge counts LINES, not units)', () => writeCart('alpha', {
      'a|': line('a', { qty: 7 }),
    })],
  ];

  for (const [name, setup] of cases) {
    it(`agrees for ${name}`, () => {
      setup();
      paintBadges();
      const truth = getCount();
      expect(seededCart() ?? '0').toBe(String(truth > 0 ? truth : 0));
    });
  }

  it('leaves the badge hidden when the seed counts nothing', () => {
    writeCart('alpha', { 'a|': line('a', { gone: true }) });
    paintBadges();
    expect(document.getElementById('cart-count')!.hidden).toBe(true);
    expect(getCount()).toBe(0);
  });

  it('seeds the exact markup the ticker expects, so the module skips its rebuild', () => {
    writeCart('alpha', { 'a|': line('a') });
    paintBadges();
    const el = document.getElementById('cart-count')!;
    expect(el.firstElementChild?.className).toBe('badge-ticker__track');
    expect(el.hidden).toBe(false);

    const before = el.innerHTML;
    updateBadge(el, String(getCount()));
    expect(el.innerHTML).toBe(before); // untouched: no re-layout, no roll
  });

  it('seeds the wishlist badge to the same number lib/wishlist reports', () => {
    localStorage.setItem('wishlist_v1', JSON.stringify([
      { slug: 'a', name: 'a', price: 1, image: 'a.png', storeSlug: 's', storeName: 's' },
      { slug: 'b', name: 'b', price: 1, image: 'b.png', storeSlug: 's', storeName: 's' },
    ]));
    paintBadges();
    expect(document.getElementById('wishlist-count')!.dataset.tickerValue).toBe(String(getWishlistCount()));
  });
});

describe('page-load reconcile never shows the previous number', () => {
  function badge(seed: string | null): HTMLElement {
    const el = document.createElement('span');
    document.body.appendChild(el);
    if (seed == null) { el.hidden = true; return el; }
    el.hidden = false;
    el.dataset.tickerValue = seed;
    el.innerHTML = `<span class="badge-ticker__track"><span class="badge-ticker__val">${seed}</span></span>`;
    return el;
  }

  it('snaps to the true count instead of rolling off a stale seed', () => {
    const el = badge('3');
    updateBadge(el, '2', { animate: false });
    // A roll stages BOTH numbers in the track; a snap renders only the truth.
    expect(el.querySelectorAll('.badge-ticker__val')).toHaveLength(1);
    expect(el.textContent).toBe('2');
    expect(el.dataset.tickerValue).toBe('2');
  });

  it('hides a badge whose true count is 0 without a pop-out animation', () => {
    const el = badge('1');
    updateBadge(el, null, { animate: false });
    expect(el.hidden).toBe(true);
    expect(el.classList.contains('badge-count--closing')).toBe(false);
    expect(el.dataset.tickerValue).toBeUndefined();
  });

  it('does not pop a badge in when it appears only because the seed was wrong', () => {
    const el = badge(null);
    updateBadge(el, '2', { animate: false });
    expect(el.hidden).toBe(false);
    expect(el.classList.contains('badge-count--entering')).toBe(false);
  });

  it('still rolls for a real change the shopper made', () => {
    const el = badge('1');
    updateBadge(el, '2');
    expect(el.querySelectorAll('.badge-ticker__val')).toHaveLength(2);
  });

  it('is a no-op when the seed already agrees, animated or not', () => {
    for (const opts of [undefined, { animate: false }]) {
      const el = badge('2');
      const before = el.innerHTML;
      updateBadge(el, '2', opts);
      expect(el.innerHTML).toBe(before);
    }
  });
});

// The header row is `justify-content: space-between`. Anything that appears in it
// after first paint doesn't merely fade in — it re-divides the row's free space and
// slides its siblings. The back-to-store pill used to be revealed from the deferred
// module script, which shifted the nav on every navigation to a non-store page.
describe('back-to-store pill is seeded before first paint', () => {
  const pillSeed = [...HEADER_SRC.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .filter((b) => b.includes('back-to-store-pill'));

  it('has exactly one inline script that reveals it', () => {
    expect(pillSeed).toHaveLength(1);
  });

  it('is not revealed from the deferred module script', () => {
    const moduleScript = HEADER_SRC.slice(HEADER_SRC.indexOf('function fadeClose'));
    expect(moduleScript).not.toMatch(/back-to-store-pill/);
  });

  it('reads the same sessionStorage key lib/last-store.ts writes', () => {
    const lastStoreSrc = readFileSync(resolve(process.cwd(), 'src/lib/last-store.ts'), 'utf8');
    const key = /const KEY = '([^']+)'/.exec(lastStoreSrc)?.[1];
    expect(key).toBeTruthy();
    expect(pillSeed[0]).toContain(`'${key}'`);
  });

  it('reveals the pill from a stored visit and writes the name inertly', () => {
    document.body.innerHTML =
      '<a id="back-to-store-pill" hidden><span id="back-to-store-pill__name"></span></a>';
    sessionStorage.setItem('last_store_v1', JSON.stringify({
      slug: 'alpha', name: '<img src=x onerror=alert(1)>', url: '/alpha',
    }));
    new Function(pillSeed[0]!)();

    const pill = document.getElementById('back-to-store-pill')!;
    expect(pill.hidden).toBe(false);
    const nameEl = document.getElementById('back-to-store-pill__name')!;
    expect(nameEl.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(nameEl.querySelector('img')).toBeNull(); // textContent, never innerHTML
  });

  it('refuses a stored destination that is not a site-relative path', () => {
    // saveLastStore() only ever writes `location.pathname + location.search`, so
    // nothing else can legitimately be here — and an href is exactly where a
    // `javascript:` string stops being data. Same rule lib/safe-redirect.ts
    // enforces for a request-supplied destination.
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', '//evil.example/x', 'https://evil.example/x', 'data:text/html,x', 'alpha']) {
      document.body.innerHTML =
        '<a id="back-to-store-pill" hidden><span id="back-to-store-pill__name"></span></a>';
      sessionStorage.clear();
      sessionStorage.setItem('last_store_v1', JSON.stringify({ slug: 'alpha', name: 'Alpha', url }));
      new Function(pillSeed[0]!)();
      const pill = document.getElementById('back-to-store-pill') as HTMLAnchorElement;
      expect(pill.hidden, url).toBe(true);
      expect(pill.getAttribute('href'), url).toBeNull();
    }
  });

  it('leaves the pill hidden when there is no stored visit, and survives junk', () => {
    for (const stored of [null, 'not json', '{}', 'null', '{"name":"a"}']) {
      document.body.innerHTML =
        '<a id="back-to-store-pill" hidden><span id="back-to-store-pill__name"></span></a>';
      sessionStorage.clear();
      if (stored != null) sessionStorage.setItem('last_store_v1', stored);
      expect(() => new Function(pillSeed[0]!)()).not.toThrow();
      expect(document.getElementById('back-to-store-pill')!.hidden).toBe(true);
    }
  });
});

describe('the header wires its first read to the silent path', () => {
  const script = HEADER_SRC.slice(HEADER_SRC.indexOf('function refresh('));

  it('calls refresh/refreshWishlistCount with animate:false on load', () => {
    expect(script).toMatch(/\brefresh\(\{ animate: false \}\)/);
    expect(script).toMatch(/\brefreshWishlistCount\(\{ animate: false \}\)/);
  });

  it('does not hand the change listener an Event as its options bag', () => {
    expect(script).not.toMatch(/addEventListener\('cart:change', refresh\)/);
    expect(script).not.toMatch(/addEventListener\('wishlist:change', refreshWishlistCount\)/);
  });

  it('reconciles the bell against its SSR seed silently too', () => {
    expect(script).toMatch(/setBadge\(d\.unreadCount \?\? 0, \{ animate: false \}\)/);
  });
});
