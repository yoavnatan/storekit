import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
