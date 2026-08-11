/**
 * THE SEAM: everywhere our data has to satisfy a system that is not ours.
 *
 * **What this file is for.** The bugs it guards share one shape, and it is not the shape a normal
 * test catches. Each side is correct on its own — the feed validates, the page renders, the event
 * fires, the slug resolves — and only the JOIN between them is wrong. Nothing anywhere reports it:
 * Google drops the row, Meta matches nothing, the crawler records an error, and every screen we own
 * keeps showing a product that looks perfectly fine. Three of them shipped and lived for months
 * (the slug-as-catalog-id, the raw Hebrew IndexNow submission, the over-length variant id), and all
 * three were found by accident, while building something else that happened to touch both sides.
 *
 * So the rule this file enforces is not "these values are right today". It is: **a value crossing
 * out of this app obeys the published contract of the system receiving it, and two surfaces
 * describing one thing describe it identically.** Written to fail for code that does not exist yet
 * — a new feed attribute, a new redirect, a new machine-readable URL — because the class is
 * "someone added a surface and nobody compared it to the others".
 *
 * The four contracts, and where each is stated:
 *   1. an HTTP header is a byte string          → RFC 9110 / the `Response` constructor itself
 *   2. Merchant/Catalog attribute limits        → Google's product data spec (checked 2026-08-04)
 *   3. a URL given to a parser is percent-encoded → the sitemap protocol, Merchant, IndexNow
 *   4. one product has ONE public URL and ONE catalog id, whoever is asking
 *   5. a URL published to an ad network is on a domain that network's ACCOUNT can claim, and it
 *      neither redirects nor canonicals away from it → Merchant Center website claiming, Meta
 *      Business domain verification (§5 below states the rule and why two fixes got it wrong)
 *
 * When a limit here and one in `product-feed.ts` disagree, THIS file is the copy of the external
 * spec and the lib is the code that has to meet it — fix the lib, and only change a number here
 * against the published spec, with the date.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildFeedItems, toMerchantXml } from '../src/lib/product-feed.js';
import { adItemId, adComboItemId } from '../src/lib/ad-item-id.js';
import { productCanonicalUrl, storeCanonicalUrl, adLandingUrl, isPlatformAdLanding } from '../src/lib/custom-domain.js';
import { store as platform } from '../src/config/store.config.js';
import { buildUrlSetXml } from '../src/lib/sitemap.js';
import { buildIndexNowPayload } from '../src/lib/indexnow.js';
import { machineUrl, urlSegment } from '../src/lib/url-base.js';
import { safeRedirectPath } from '../src/lib/safe-redirect.js';
import { isReservedSlug } from '../src/lib/stores.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { Store } from '../src/lib/stores.js';

// ── 1. A Location header is a byte string ────────────────────────────────────

describe('a redirect destination has to survive being a header value', () => {
  const HEBREW_PATH = '/חנות-הנעליים/נעל-ריצה';

  it('proves the failure it exists to prevent: a raw Hebrew Location THROWS', () => {
    // Not "renders oddly" — `Astro.redirect(p)` is exactly this expression, so the page throws and
    // the visitor gets a 500 where a 301 was intended. Pinned here so the rule below can never be
    // argued down to a style preference.
    expect(() => new Response(null, { status: 301, headers: { Location: HEBREW_PATH } })).toThrow();
  });

  it('machineUrl() output is always emittable', () => {
    expect(() => new Response(null, { status: 301, headers: { Location: machineUrl(HEBREW_PATH) } })).not.toThrow();
    expect(machineUrl(HEBREW_PATH)).toBe('/%D7%97%D7%A0%D7%95%D7%AA-%D7%94%D7%A0%D7%A2%D7%9C%D7%99%D7%99%D7%9D/%D7%A0%D7%A2%D7%9C-%D7%A8%D7%99%D7%A6%D7%94');
  });

  it('is idempotent, so a caller never has to know which form it holds', () => {
    // The trap `indexnow.ts` documents: re-encoding an encoded path gives `%25D7%2597`, which is a
    // different URL that resolves to nothing.
    const once = machineUrl(HEBREW_PATH);
    expect(machineUrl(once)).toBe(once);
  });

  it('keeps the query and the origin', () => {
    expect(machineUrl('/חנות?category=נעליים&page=2')).toBe('/%D7%97%D7%A0%D7%95%D7%AA?category=%D7%A0%D7%A2%D7%9C%D7%99%D7%99%D7%9D&page=2');
    expect(machineUrl('https://shop.example/נעל')).toBe('https://shop.example/%D7%A0%D7%A2%D7%9C');
  });

  it('the request-supplied-destination gate emits an encoded path', () => {
    // `?next=` arrives decoded from `searchParams.get`, and on this catalogue "the page you were
    // on" is a Hebrew path — so the safety gate and the emittability gate are the same call.
    expect(safeRedirectPath('/חנות/נעל', '/')).toBe('/%D7%97%D7%A0%D7%95%D7%AA/%D7%A0%D7%A2%D7%9C');
    expect(safeRedirectPath('https://evil.example', '/')).toBe('/');
  });
});

// ── 2. Every redirect that interpolates a value encodes it ───────────────────

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|astro)$/.test(full) ? [full] : [];
  });
}

/**
 * Deliberately blunt, and tree-wide rather than a file list: any `redirect(` whose argument
 * interpolates something must hand it to `machineUrl(`. No parser, no judgement call about whether
 * this particular value "is obviously ASCII" — that judgement is what produced four broken
 * redirects, because `/${storeSlug}` reads perfectly well right up until the slug is Hebrew. A call
 * site with a real reason to opt out has to come here and say so.
 */
describe('no redirect interpolates a value into a header without encoding it', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(process.cwd(), file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/\bredirect\s*\(/.test(line)) return;
      if (!/\$\{/.test(line)) return;
      if (/machineUrl\s*\(/.test(line)) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }

  it('finds no un-encoded interpolated redirect', () => {
    expect(offenders, 'wrap the destination in machineUrl() — url-base.ts').toEqual([]);
  });

  it('is actually scanning the tree, so a rename cannot make it a no-op', () => {
    const wrapped = walk(SRC).filter((f) => /machineUrl\s*\(/.test(readFileSync(f, 'utf8')));
    expect(wrapped.length).toBeGreaterThanOrEqual(4);
  });
});

// ── 3. The Merchant / Meta feed obeys the published limits ───────────────────

/**
 * Google Merchant Center product data spec, checked 2026-08-04. Over a limit the item is REJECTED,
 * and rejected silently: the seller sees the product on the storefront and no ad behind it.
 *
 * **One table for both networks, and that is a checked claim, not an assumption.** The same document
 * is submitted to Meta Catalog, and Meta's published limits were read the same day: on every shared
 * attribute Google's is the tighter one — id 50 vs 100, title 150 vs 200, description 5000 vs 9999,
 * brand 70 vs 100, colour 40 vs 200, size 100 vs 200, product_type 750 vs 750. So passing this table
 * passes Meta's. If that ever stops being true, the limit that moves goes in here with its source.
 *
 * What a table of lengths CANNOT settle is a vocabulary difference — Meta's docs spell availability
 * `in stock` where Google requires `in_stock` — and no local test can, because only the receiving
 * account's own ingestion report answers it. Logged with its trigger and its fallback in
 * GO_LIVE_CHECKLIST §2.5 layer 1, which is the moment it becomes answerable.
 *
 * The table is exhaustive on purpose — see the "no unknown attribute" test. Every seller-controlled
 * string reaches one of these, and none of them is capped where the seller types it, because none
 * of them is an ad-platform field where the seller types it.
 */
const FEED_LIMITS: Record<string, number> = {
  'g:id': 50,
  'g:item_group_id': 50,
  title: 150,
  description: 5000,
  link: 2000,
  'g:image_link': 2000,
  'g:additional_image_link': 2000,
  'g:brand': 70,
  'g:mpn': 70,
  'g:gtin': 50,
  'g:color': 40,
  'g:size': 100,
  'g:product_type': 750,
  'g:custom_label_0': 100,
  'g:custom_label_1': 100,
  'g:custom_label_2': 100,
  'g:custom_label_3': 100,
  'g:custom_label_4': 100,
  // Enumerations and formats rather than lengths — bounded by the values the spec accepts, checked
  // below. `shipping_weight` is `"<number> <unit>"` with the unit in a fixed English vocabulary
  // (lb/oz/g/kg) and a metric ceiling of 1000 kg; a Hebrew unit is a rejected item, not a localised
  // one, and `lib/product-weight.ts` caps the input at 100 kg well inside that.
  'g:shipping_weight': 20,
  'g:availability': 20,
  'g:condition': 20,
  'g:gender': 20,
  'g:age_group': 20,
  'g:price': 40,
  'g:sale_price': 40,
  // A date RANGE, so like `shipping_weight` the real rule is the format, not a length — two
  // ISO-8601 instants separated by '/', each `YYYY-MM-DDThh:mm±hhmm` (Merchant Center help for the
  // attribute, checked 2026-08-10). That is 43 characters and cannot vary; the number here is only
  // the ceiling this file needs, and the shape is asserted below where it belongs.
  'g:sale_price_effective_date': 60,
  'g:identifier_exists': 5,
};

/** A product built to break every one of them at once: the longest thing each field can hold, in
 *  Hebrew, where one character is six in a URL and two bytes everywhere else. */
function adversarialProduct(): StoreProduct {
  return {
    id: '11111111-1111-4111-8111-000000000001',
    storeId: 's1',
    slug: 'מוצר-קיצון',
    name: 'מ'.repeat(400),
    description: 'ת'.repeat(9000),
    price: 199.99,
    stock: 7,
    weightGrams: 100_000, // the module's own ceiling — the largest value that can ever reach the feed
    sku: 'S'.repeat(120),
    images: Array.from({ length: 14 }, (_, i) => `https://cdn.example/${i}.jpg`),
    variants: [
      { name: 'צבע', options: ['כחול-כהה-במיוחד'.repeat(4), 'אדום'] },
      { name: 'מידה', options: ['ג'.repeat(120), 'L'] },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  } as StoreProduct;
}

const FEED_CTX = {
  storeName: 'ח'.repeat(200),
  productLink: (slug: string) => `https://dezabin.co.il/${urlSegment('חנות')}/${urlSegment(slug)}`,
  baseUrl: 'https://dezabin.co.il',
  categoryPath: 'ק'.repeat(900),
  storeTags: ['ת'.repeat(300)],
};

/** Every `<tag>value</tag>` inside every `<item>`, flattened to [tag, value] pairs. */
function feedTagValues(xml: string): Array<[string, string]> {
  const items = xml.split('<item>').slice(1);
  return items.flatMap((item) =>
    [...item.matchAll(/<((?:g:)?[a-z_0-9]+)>([\s\S]*?)<\/\1>/g)].map(
      ([, tag, value]) => [tag!, (value ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '')] as [string, string],
    ),
  );
}

describe('the Merchant/Catalog feed cannot emit a value the platforms reject', () => {
  const rows = buildFeedItems(adversarialProduct(), FEED_CTX);
  const xml = toMerchantXml(rows, {
    title: 'feed', link: 'https://dezabin.co.il', description: 'feed', currency: 'ILS',
  });
  const pairs = feedTagValues(xml);

  it('produces rows at all, so the assertions below are not vacuous', () => {
    expect(rows.length).toBe(4);
    expect(pairs.length).toBeGreaterThan(20);
  });

  it('every emitted value is inside its published limit', () => {
    const over = pairs
      .filter(([tag, value]) => value.length > (FEED_LIMITS[tag] ?? Infinity))
      .map(([tag, value]) => `${tag}: ${value.length} > ${FEED_LIMITS[tag]}`);
    expect(over, 'clamp it in product-feed.ts — an over-length attribute is a dropped item').toEqual([]);
  });

  it('dates a sale price in the exact shape the spec accepts', () => {
    // Its own fixture rather than a discount on the adversarial product: this is the one attribute
    // whose value is a FORMAT, and a malformed one is not a clamped value, it is a rejected item.
    // The adversarial row carries no discount, so the scan above can only prove the tag is
    // declared — not that what it holds would parse.
    const discounted = { ...adversarialProduct(), discount: { type: 'percent' as const, value: 20, startsAt: '2026-08-01', endsAt: '2026-08-14' } };
    const values = feedTagValues(
      toMerchantXml(buildFeedItems(discounted, { ...FEED_CTX, nowMs: Date.parse('2026-08-10T09:00:00.000Z') }), {
        title: 'feed', link: 'https://dezabin.co.il', description: 'feed', currency: 'ILS',
      }),
    );
    const dates = values.filter(([tag]) => tag === 'g:sale_price_effective_date').map(([, v]) => v);
    expect(dates.length, 'the fixture stopped producing a sale price').toBe(4);
    const ISO_RANGE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{4}\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{4}$/;
    for (const d of dates) {
      expect(d, `not the spec's date-range format: ${d}`).toMatch(ISO_RANGE);
      const [from, to] = d.split('/') as [string, string];
      // A range that ends before it starts is well-formed and meaningless; Google would apply the
      // sale price for no window at all, i.e. advertise a price the landing page contradicts.
      expect(new Date(to).getTime()).toBeGreaterThan(new Date(from).getTime());
    }
    // Never dated without the price it dates.
    expect(values.filter(([tag]) => tag === 'g:sale_price')).toHaveLength(4);
  });

  it('emits no attribute this file has never heard of', () => {
    // The self-extending half: a new feed attribute fails here until someone writes down what the
    // receiving system allows for it. That is the only step that was ever skipped.
    const unknown = [...new Set(pairs.map(([tag]) => tag))].filter((tag) => !(tag in FEED_LIMITS));
    expect(unknown, 'add it to FEED_LIMITS with its limit from the published spec').toEqual([]);
  });

  it('and no attribute the SOURCE can emit is undeclared, whatever this fixture happens to trigger', () => {
    // The test above can only see what the fixture produces, and an optional attribute is exactly
    // the kind that a fixture forgets — `shipping_weight` arrived from another session and slipped
    // through until the product here was given a weight. So the tags are also read off the
    // serializer itself, which cannot forget: every tag `itemXml` is capable of writing must be
    // declared, whether or not any fixture reaches it.
    const source = readFileSync(join(SRC, 'lib/product-feed.ts'), 'utf8');
    const emitted = new Set<string>();
    for (const [, name] of source.matchAll(/\bg\('([a-z_0-9]+)'/g)) emitted.add(`g:${name}`);
    for (const [, name] of source.matchAll(/<(g:[a-z_0-9]+)>/g)) emitted.add(name);
    for (const [, name] of source.matchAll(/<(title|description|link)>/g)) emitted.add(name);
    // The five positional labels are written through a template (`custom_label_${i}`), so they are
    // named once in the source and five times in the document.
    if (/custom_label_\$\{/.test(source)) for (let i = 0; i < 5; i++) emitted.add(`g:custom_label_${i}`);

    expect([...emitted].filter((tag) => !(tag in FEED_LIMITS)), 'declare it in FEED_LIMITS').toEqual([]);
    // …and the reverse, so a limit for an attribute nobody emits any more is noticed rather than
    // quietly outliving its field.
    expect(Object.keys(FEED_LIMITS).filter((tag) => !emitted.has(tag)), 'stale limit, no such attribute').toEqual([]);
  });

  it('the catalog id fits, including the hashed fallback for a long Hebrew combo', () => {
    // The bug: a uuid is 36 of the 50, and `צבע=אדום,מידה=42` alone is 17 — so EVERY row of a
    // two-dimension Hebrew variant product was over. A variant product emits no parent row, so the
    // product was not partly advertised, it was absent.
    for (const row of rows) {
      expect(row.id.length, `id too long: ${row.id}`).toBeLessThanOrEqual(50);
    }
    expect(new Set(rows.map((r) => r.id)).size, 'two combos collapsed onto one id').toBe(rows.length);
  });

  it('caps additional images at the 10 the spec allows', () => {
    for (const row of rows) expect(row.additionalImageLinks.length).toBeLessThanOrEqual(10);
  });

  it('an over-length identifier is dropped, never truncated', () => {
    // Half a part number is a different part number, and `identifier_exists` would then be
    // asserting that a wrong identifier exists.
    for (const row of rows) expect(row.mpn).toBeUndefined();
  });

  it('shipping_weight is a number plus a unit Google actually accepts', () => {
    // The attribute that arrived from another session while this file was being written — which is
    // the test working: an unknown attribute failed here until its contract was written down.
    const weights = pairs.filter(([tag]) => tag === 'g:shipping_weight').map(([, v]) => v);
    expect(weights.length).toBeGreaterThan(0);
    for (const w of weights) {
      expect(w, 'format is "<number> <unit>", unit in lb/oz/g/kg').toMatch(/^\d+(\.\d+)? (lb|oz|g|kg)$/);
      expect(Number(w.split(' ')[0]), 'over Google\'s 1000 kg metric ceiling').toBeLessThanOrEqual(1_000_000);
    }
  });

  it('availability and condition stay inside the accepted vocabulary', () => {
    const values = Object.fromEntries([
      ['g:availability', ['in_stock', 'out_of_stock']],
      ['g:condition', ['new', 'used', 'refurbished']],
      ['g:gender', ['male', 'female', 'unisex']],
      ['g:age_group', ['newborn', 'infant', 'toddler', 'kids', 'adult']],
    ]);
    for (const [tag, value] of pairs) {
      if (tag in values) expect(values[tag], `${tag}=${value}`).toContain(value);
    }
  });
});

// ── 4. Every URL handed to a machine is percent-encoded ──────────────────────

/** A URL a parser will read must be ASCII — the sitemap protocol requires escaped entities in
 *  `<loc>`, Merchant validates `<link>` as a URL, IndexNow rejects the submission outright. */
const isAsciiUrl = (value: string): boolean => /^[\x21-\x7e]*$/.test(value);

function storeFixture(over: Partial<Store> = {}): Store {
  return {
    id: 'store-1', sellerId: 'seller-1', slug: 'חנות-הנעליים', name: 'חנות הנעליים',
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  } as Store;
}

describe('no machine-readable surface publishes an unencoded URL', () => {
  const store = storeFixture();
  const productSlug = 'נעל-ריצה';

  it('the canonical builders', () => {
    expect(isAsciiUrl(storeCanonicalUrl(store))).toBe(true);
    expect(isAsciiUrl(productCanonicalUrl(store, productSlug))).toBe(true);
  });

  it('the feed <link> and <image_link>', () => {
    const rows = buildFeedItems(adversarialProduct(), FEED_CTX);
    for (const row of rows) {
      expect(isAsciiUrl(row.link), row.link).toBe(true);
      expect(isAsciiUrl(row.imageLink), row.imageLink).toBe(true);
    }
  });

  it('the sitemap <loc>', () => {
    const xml = buildUrlSetXml([{ loc: productCanonicalUrl(store, productSlug) }]);
    const loc = /<loc>([\s\S]*?)<\/loc>/.exec(xml)?.[1] ?? '';
    expect(isAsciiUrl(loc), loc).toBe(true);
  });

  it('the IndexNow submission', () => {
    const payload = buildIndexNowPayload(
      [`/${store.slug}/${productSlug}`],
      { key: 'k'.repeat(32), siteUrl: 'https://dezabin.co.il' },
    );
    for (const url of payload.urlList) expect(isAsciiUrl(url), url).toBe(true);
  });
});

// ── 4b. A link we render ourselves goes somewhere ────────────────────────────

/**
 * **The class, and it is the same one as everything else in this file: nothing reports it.**
 * `/terms` and `/contact` were linked from the footer of every page on the site, in a `store.config`
 * the layout renders unconditionally, and neither route existed. Nobody clicks a marketplace's own
 * terms link, so the 404 survived — while being read by the one audience that always looks:
 * Merchant Center suspends an ACCOUNT for "misrepresentation" over a shop that publishes no terms
 * and no way to reach it, and one account here is every seller's advertising at once.
 *
 * Worse than a 404, in fact. Neither word was in `RESERVED_SLUGS`, so `/terms` fell through to the
 * store router: a seller registering the slug `terms` would have put their own storefront behind
 * the platform's "תנאי שימוש" link on every page.
 *
 * So the rule is both halves — the page exists, and the word cannot be taken — and it is enforced
 * over every literal internal link in the tree, not over a list of the two we happen to know about.
 */
describe('every internal link the site renders itself resolves to a route', () => {
  const PAGES = join(SRC, 'pages');

  /** Top-level path segments that are real routes: a file or a directory under src/pages. A
   *  bracketed name is a dynamic route and matches anything, so it is deliberately NOT counted —
   *  "it resolves because the store router catches it" is the bug, not the answer. */
  const routes = new Set(
    readdirSync(PAGES)
      .filter((name) => !name.startsWith('['))
      .map((name) => name.replace(/\.(astro|ts)$/, '').replace(/\.[a-z]+$/, '')),
  );

  // Literal hrefs only: `href="/…"` with no interpolation. A `/${store.slug}` link is a store URL
  // by construction and has its own guards; a literal is someone typing a route from memory.
  const linked = new Map<string, string>();
  for (const file of walk(SRC)) {
    if (!/\.(astro|ts)$/.test(file)) continue;
    // Both spellings: markup (`href="/x"`) and config data (`href: '/x'`) — store.config.ts declares
    // the footer's links as data, and that is where these two came from in the first place.
    for (const m of readFileSync(file, 'utf8').matchAll(/href[=:]\s*["'](\/[a-z0-9-]*)(?=["'/?#])/gi)) {
      const seg = m[1]!.slice(1);
      if (seg) linked.set(seg, relative(process.cwd(), file));
    }
  }

  it('is actually finding links, so a markup change cannot make it a no-op', () => {
    expect(linked.size).toBeGreaterThanOrEqual(5);
  });

  it('every literal top-level link is a page that exists', () => {
    const dead = [...linked].filter(([seg]) => !routes.has(seg)).map(([seg, file]) => `${seg} (${file})`);
    expect(dead, 'a link the site renders on every page must not 404').toEqual([]);
  });

  it('and no seller can register the slug that link points at', () => {
    // Reserving is what stops the store router from answering for it — see RESERVED_SLUGS.
    const takeable = [...linked.keys()].filter((seg) => !isReservedSlug(seg));
    expect(takeable, 'add these to RESERVED_SLUGS in stores.ts').toEqual([]);
  });
});

// ── 4c. The file that tells crawlers where to look must be able to see the host ──

/**
 * A file in `public/` outranks a route of the same name, silently.
 *
 * `robots.txt` is host-dependent: on a seller's verified domain it must name THAT domain's sitemap
 * and no other, because a `Sitemap:` line pointing across hosts is ignored by every engine. A static
 * file cannot do that — it answered every hostname with the platform's two sitemap URLs, leaving the
 * seller's domain declaring none while `sitemap-content.xml` was already serving it a correct one.
 * It is now `src/pages/robots.txt.ts` (tests/robots-txt.test.ts covers what it says).
 *
 * The failure mode this guards is not the bug returning by edit — it is the bug returning by
 * ADDITION: dropping a `robots.txt` back into `public/` restores the old behaviour in full, with the
 * route still sitting there looking correct and never being reached.
 */
describe('robots.txt is a route, not a static file', () => {
  it('no public/ file shadows it', () => {
    const shadowed = readdirSync(join(process.cwd(), 'public'))
      .filter((name) => name.toLowerCase() === 'robots.txt');
    expect(shadowed, 'public/robots.txt outranks src/pages/robots.txt.ts and cannot vary by host').toEqual([]);
  });

  it('the route exists', () => {
    expect(readdirSync(join(SRC, 'pages'))).toContain('robots.txt.ts');
  });
});

// ── 5. One product, one public URL and one catalog id ────────────────────────

describe('two surfaces describing one product describe it identically', () => {
  const CUSTOM = storeFixture({
    customDomain: { hostname: 'shoes.example', status: 'active', addedAt: '2026-01-01T00:00:00.000Z' },
  } as Partial<Store>);

  /**
   * **The rule, and it took two wrong answers to state it.** A URL we publish to an advertising
   * network has to satisfy two conditions at once, and each fix that honoured only one broke the
   * other:
   *
   *   1. it must be on a domain the ADVERTISING ACCOUNT has claimed — we can claim `dezabin.co.il`
   *      and nothing else, because verification is performed from the advertiser's account and a
   *      thousand sellers' domains cannot be claimed from ours at any price;
   *   2. it must not redirect off that domain, and it must not name another one as its canonical —
   *      both are read by Merchant Center as "the real landing page is elsewhere", which is the
   *      same disapproval as failing (1).
   *
   * The feed first published the platform URL, which 301s to the seller's domain → broke (2). It
   * was then changed to publish the seller's domain → satisfied (2), broke (1), and looked *more*
   * correct because both sides finally agreed. Only the platform URL WITH the ad marker satisfies
   * both, because the marker is what stands the redirect down (custom-domain.ts#AD_LANDING_PARAM).
   *
   * A store with no custom domain has no redirect to stand down and gets the plain URL.
   */
  it('every feed <link> is on the platform domain — the only one the ad account can claim', () => {
    for (const store of [CUSTOM, storeFixture()]) {
      const rows = buildFeedItems(adversarialProduct(), {
        ...FEED_CTX,
        productLink: (slug) => adLandingUrl(store, slug),
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(new URL(row.link).origin, row.link).toBe(new URL(platform.url).origin);
      }
    }
  });

  it('the URL it publishes does not then redirect off that domain', () => {
    const link = adLandingUrl(CUSTOM, 'מוצר-קיצון');
    const host = new URL(platform.url).hostname;
    // What the page asks itself before deciding to 301 (both store pages). True here ⇒ the crawler
    // that follows this link is served the product, not a Location header pointing at shoes.example.
    expect(isPlatformAdLanding(CUSTOM, new URL(link), host)).toBe(true);
    // And the marker is inert everywhere it would otherwise cause harm: on a store with no custom
    // domain (nothing to skip), and on the seller's own domain (where it would `noindex` their page
    // and point its canonical at ours).
    expect(isPlatformAdLanding(storeFixture(), new URL(`${platform.url}/my-store/x?ad=1`), host)).toBe(false);
    expect(isPlatformAdLanding(CUSTOM, new URL(link), 'shoes.example')).toBe(false);
  });

  it('a store with no custom domain gets a link with nothing extra on it', () => {
    // The parameter exists to disarm a redirect. Where there is no redirect it would be a tracking
    // parameter on every row of the catalogue, for nothing.
    expect(adLandingUrl(storeFixture(), 'x')).toBe(productCanonicalUrl(storeFixture(), 'x'));
  });

  it('the feed document takes that URL from the helper, not from a template', () => {
    // `lib/feed-document.ts`, not the route: the route stopped assembling the feed on 2026-08-09
    // (it serves a pre-built artifact — GO_LIVE §7), and the rule follows the code that builds the
    // link rather than the file that used to.
    const source = readFileSync(join(SRC, 'lib/feed-document.ts'), 'utf8');
    expect(source, 'the feed link must come from adLandingUrl').toContain('adLandingUrl');
    expect(source, 'the seller-domain canonical is not a feed link — see the rule above')
      .not.toContain('productCanonicalUrl');
  });

  it('both store pages stand their redirect down for it, and neither indexes it', () => {
    // Grep, because the failure is a page that forgot: the redirect runs in page frontmatter, and a
    // future edit that reinstates an unconditional 301 puts every custom-domain seller's items back
    // on an unclaimed domain — silently, one disapproval at a time.
    for (const page of ['pages/[storeSlug]/index.astro', 'pages/[storeSlug]/[productSlug].astro']) {
      const source = readFileSync(join(SRC, page), 'utf8');
      expect(source, `${page} must decide the redirect through isPlatformAdLanding`).toContain('isPlatformAdLanding');
      expect(source, `${page} must not 301 an ad landing`).toMatch(/adLanding\s*\n?\s*\?\s*null/);
      expect(source, `${page} must keep the ad landing out of the index`).toMatch(/noindex=\{[^}]*adLanding/);
    }
  });

  it('llms.txt publishes the same store URL every other machine surface does', () => {
    const source = readFileSync(join(SRC, 'pages/llms.txt.ts'), 'utf8');
    expect(source, 'an answer engine gets the canonical, not a platform path that 301s')
      .toContain('storeCanonicalUrl');
  });

  it('the catalog id is one id: the feed row and a shopper selection agree', () => {
    const rows = buildFeedItems(adversarialProduct(), FEED_CTX);
    const fromEvents = [
      { צבע: 'כחול-כהה-במיוחד'.repeat(4), מידה: 'ג'.repeat(120) },
      { צבע: 'כחול-כהה-במיוחד'.repeat(4), מידה: 'L' },
      { צבע: 'אדום', מידה: 'ג'.repeat(120) },
      { צבע: 'אדום', מידה: 'L' },
    ].map((sel) => adItemId('11111111-1111-4111-8111-000000000001', sel));
    expect(rows.map((r) => r.id).sort()).toEqual(fromEvents.sort());
  });

  it('the hashed fallback is stable and still per-combo', () => {
    const id = '11111111-1111-4111-8111-000000000001';
    const long = 'צבע=כחול-כהה-במיוחד-מאוד,מידה=ענק-במיוחד';
    expect(adComboItemId(id, long)).toBe(adComboItemId(id, long));
    expect(adComboItemId(id, long)).not.toBe(adComboItemId(id, `${long}X`));
    expect(adComboItemId(id, long).length).toBeLessThanOrEqual(50);
  });
});
