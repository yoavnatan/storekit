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
import { productCanonicalUrl, storeCanonicalUrl } from '../src/lib/custom-domain.js';
import { buildUrlSetXml } from '../src/lib/sitemap.js';
import { buildIndexNowPayload } from '../src/lib/indexnow.js';
import { machineUrl, urlSegment } from '../src/lib/url-base.js';
import { safeRedirectPath } from '../src/lib/safe-redirect.js';
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

// ── 5. One product, one public URL and one catalog id ────────────────────────

describe('two surfaces describing one product describe it identically', () => {
  const CUSTOM = storeFixture({
    customDomain: { hostname: 'shoes.example', status: 'active', addedAt: '2026-01-01T00:00:00.000Z' },
  } as Partial<Store>);

  it('the feed <link> IS the page canonical, custom domain included', () => {
    // The feed used to build `${platform.url}/${store}/${product}` itself. A store on a verified
    // domain 301s that URL away, and Merchant Center disapproves an item whose landing page
    // redirects off the claimed domain — so the sellers who looked most professional were the ones
    // whose ads stopped. Both sides now call one function; this asserts the endpoint still does.
    const rows = buildFeedItems(adversarialProduct(), {
      ...FEED_CTX,
      productLink: (slug) => productCanonicalUrl(CUSTOM, slug),
    });
    for (const row of rows) {
      expect(row.link).toBe(productCanonicalUrl(CUSTOM, 'מוצר-קיצון'));
      expect(row.link.startsWith('https://shoes.example/')).toBe(true);
    }
  });

  it('the feed endpoint takes that URL from the canonical helper, not from a template', () => {
    const source = readFileSync(join(SRC, 'pages/api/feed/products.xml.ts'), 'utf8');
    expect(source, 'the feed link must be the page canonical').toContain('productCanonicalUrl');
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
