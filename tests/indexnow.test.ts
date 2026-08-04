import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

// Real domain + key so the submit path is genuinely ENABLED in this file. Without
// it every ping is a no-op (dev config has an empty key) and the showcase-store
// guard below would pass vacuously — it would prove nothing.
vi.mock('../src/config/store.config.js', () => ({
  store: { url: 'https://dezabin.co.il', seo: { indexNowKey: 'k123' } },
}));

import {
  isPlaceholderHost,
  indexNowEnabled,
  buildIndexNowPayload,
  pingProductChange,
  pingStoreChange,
  pingProductsChanged,
} from '../src/lib/indexnow.js';

describe('indexnow guards', () => {
  it('treats example.* and unparseable urls as placeholder hosts', () => {
    expect(isPlaceholderHost('https://example.com')).toBe(true);
    expect(isPlaceholderHost('https://shop.example.com')).toBe(true);
    expect(isPlaceholderHost('not-a-url')).toBe(true);
    expect(isPlaceholderHost('https://dezabin.co.il')).toBe(false);
  });

  it('is enabled only with a key AND a real domain', () => {
    expect(indexNowEnabled({ key: '', siteUrl: 'https://dezabin.co.il' })).toBe(false);
    expect(indexNowEnabled({ key: 'abc', siteUrl: 'https://example.com' })).toBe(false);
    expect(indexNowEnabled({ key: '  ', siteUrl: 'https://dezabin.co.il' })).toBe(false);
    expect(indexNowEnabled({ key: 'abc', siteUrl: 'https://dezabin.co.il' })).toBe(true);
  });
});

describe('buildIndexNowPayload', () => {
  const cfg = { key: 'k123', siteUrl: 'https://dezabin.co.il' };

  it('absolutizes relative paths, sets host + keyLocation', () => {
    const p = buildIndexNowPayload(['/store/a/prod', '/store/a'], cfg);
    expect(p.host).toBe('dezabin.co.il');
    expect(p.key).toBe('k123');
    expect(p.keyLocation).toBe('https://dezabin.co.il/k123.txt');
    expect(p.urlList).toEqual(['https://dezabin.co.il/store/a/prod', 'https://dezabin.co.il/store/a']);
  });

  it('keeps absolute urls and dedupes', () => {
    const p = buildIndexNowPayload(['https://dezabin.co.il/x', '/x'], cfg);
    expect(p.urlList).toEqual(['https://dezabin.co.il/x']);
  });

  it('tolerates a trailing slash on the site url', () => {
    const p = buildIndexNowPayload(['/y'], { key: 'k', siteUrl: 'https://dezabin.co.il/' });
    expect(p.urlList).toEqual(['https://dezabin.co.il/y']);
    expect(p.keyLocation).toBe('https://dezabin.co.il/k.txt');
  });
});

// A showcase store's URLs must never be pushed to Bing — that index is what feeds
// ChatGPT/Copilot, so it would put fabricated catalog straight into AI answers
// (lib/demo-stores.ts). Asserted against the real submit path, with the config
// mocked to a live domain+key above so the ping is actually armed.
describe('indexnow — showcase-store guard', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** pingIndexNow is fire-and-forget (`void`), so let its microtasks drain. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('pings for a normal store', async () => {
    pingStoreChange({ slug: 'acme' });
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not ping for a demo store, store page or product page', async () => {
    pingStoreChange({ slug: 'showcase-fashion', demo: true });
    pingProductChange({ slug: 'showcase-fashion', demo: true }, 'demo-shirt');
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still pings a product of a normal store', async () => {
    pingProductChange({ slug: 'acme' }, 'blue-widget');
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as { urlList: string[] };
    expect(body.urlList).toEqual(['https://dezabin.co.il/acme/blue-widget', 'https://dezabin.co.il/acme']);
  });
});

describe('a ping never breaks the mutation it follows', () => {
  it('says nothing when the store could not be resolved, instead of throwing', () => {
    // The ping runs AFTER the write, and isDemoStore() reads `.demo` synchronously — outside
    // pingIndexNow's try/catch. Without this, an unresolved store would turn a successful delete
    // into a 500. Call sites pass `stores.find(...)!`, so the day a guard above one moves, this is
    // what stands between the seller and an error on work that actually succeeded.
    expect(() => pingProductChange(undefined, 'x')).not.toThrow();
    expect(() => pingProductsChanged(undefined, ['x'])).not.toThrow();
  });
});

describe('a Hebrew slug reaches IndexNow encoded', () => {
  // Store and product slugs keep Hebrew (url-base.ts#toSlug, owner's decision 2026-08-02), and
  // IndexNow is a machine surface like the sitemap and the feed. Before 2026-08-05 this payload was
  // built by string concatenation, so a Hebrew store submitted a raw non-ASCII URL — invalid, and
  // rejectable together with every other URL in the same batch. Invisible on the seed catalog,
  // whose slugs are all latin, which is why it survived.
  it('percent-encodes the path, and never double-encodes an already-encoded one', () => {
    const cfg = { key: 'k', siteUrl: 'https://dezabin.co.il' };
    const raw = buildIndexNowPayload(['/חנות-הנעליים/נעל-ריצה'], cfg);
    expect(raw.urlList[0]).toBe('https://dezabin.co.il/%D7%97%D7%A0%D7%95%D7%AA-%D7%94%D7%A0%D7%A2%D7%9C%D7%99%D7%99%D7%9D/%D7%A0%D7%A2%D7%9C-%D7%A8%D7%99%D7%A6%D7%94');
    // ASCII-only is the property that matters; expressed without a control-char range so the
    // linter's no-control-regex rule stays on for the cases where it is a real smell.
    expect([...raw.urlList[0]!].every((c) => c.charCodeAt(0) < 128)).toBe(true);

    // Idempotent: feeding the encoded form back must not turn % into %25.
    expect(buildIndexNowPayload([raw.urlList[0]!], cfg).urlList[0]).toBe(raw.urlList[0]);
  });

  it('drops an unparseable entry instead of sending a broken batch', () => {
    const p = buildIndexNowPayload(['http://', '/ok'], { key: 'k', siteUrl: 'https://dezabin.co.il' });
    expect(p.urlList).toEqual(['https://dezabin.co.il/ok']);
  });
});

describe('pingProductsChanged — the bulk shape', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('submits every product plus the store page in ONE request, not one per product', async () => {
    // The whole reason this function exists: a 500-row CSV import must be one POST. Looping
    // pingProductChange would be 500, which is how a best-effort ping earns a rate limit.
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    pingProductsChanged({ slug: 'acme' }, ['a', 'b', 'c']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.urlList).toEqual([
      'https://dezabin.co.il/acme/a',
      'https://dezabin.co.il/acme/b',
      'https://dezabin.co.il/acme/c',
      'https://dezabin.co.il/acme',
    ]);
  });

  it('says nothing at all for an empty list, and for a showcase store', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    pingProductsChanged({ slug: 'acme' }, []);
    pingProductsChanged({ slug: 'demo-shop', demo: true }, ['a']);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('every product mutation announces itself', () => {
  /**
   * A grep guard, in the style of tests/safe-redirect.test.ts.
   *
   * The bug this exists to prevent already shipped once (fixed 2026-08-05): `/api/product`
   * pinged IndexNow when a product was CREATED or hidden, and stayed silent when one was edited,
   * re-priced, re-photographed, bulk-discounted or DELETED — while AI_INSTRUCTIONS claimed every
   * update pinged. The feed and sitemap are built per request so they never went stale; what was
   * missing was telling anyone, so a change waited on an organic crawl and a deleted product went
   * on being offered in results.
   *
   * Asserting on the branch list rather than on behaviour is deliberate: the failure mode is a
   * NEW mutating action added later with no ping, which no behavioural test would ever cover
   * because nobody writes a test for the thing they forgot.
   */
  it('every mutating action in /api/product pings, or is listed here as deliberately silent', async () => {
    const src = await readFile(new URL('../src/pages/api/product.ts', import.meta.url), 'utf8');

    // Stock-only writes. A quantity change alters no indexable text, and checkout decrements
    // stock on every purchase — pinging there would submit the whole catalog on a busy day.
    // `availability` in the feed self-corrects, because the feed is built per request.
    const SILENT = new Set(['patch-variant-stock']);

    const actions = [...src.matchAll(/if \(action === '([a-z-]+)'\) \{/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(5); // the regex still matches the file's shape

    const bodies = new Map<string, string>();
    for (const [i, action] of actions.entries()) {
      const start = src.indexOf(`if (action === '${action}') {`);
      const next = actions[i + 1];
      const end = next ? src.indexOf(`if (action === '${next}') {`) : src.length;
      bodies.set(action, src.slice(start, end));
    }

    const silentButShouldSpeak = actions.filter(
      (a) => !SILENT.has(a) && !/ping(ProductChange|ProductsChanged|StoreChange)\(/.test(bodies.get(a)!),
    );
    expect(silentButShouldSpeak, 'these mutate a public page but never tell IndexNow').toEqual([]);
  });
});
