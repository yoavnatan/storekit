import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveImageRenders, deriveBannerRenders } from '../src/lib/image-derive.js';
import { LIGHTBOX_WIDTHS, BANNER_WIDTHS, BANNER_RATIO } from '../src/lib/cdn.js';

const UPLOAD = 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg';

function mockFetch() {
  const calls: Array<{ url: string; method?: string }> = [];
  const spy = vi.fn(async (url: unknown, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('deriveImageRenders', () => {
  it('renders each image at every lightbox width, so no width is left cold', async () => {
    const calls = mockFetch();
    await deriveImageRenders([UPLOAD]);
    expect(calls).toHaveLength(LIGHTBOX_WIDTHS.length);
    for (const w of LIGHTBOX_WIDTHS) {
      expect(calls.some((c) => c.url.includes(`w_${w}/`))).toBe(true);
    }
  });

  it('uses HEAD — the derivation is the point, the bytes are not', async () => {
    const calls = mockFetch();
    await deriveImageRenders([UPLOAD]);
    expect(calls.every((c) => c.method === 'HEAD')).toBe(true);
  });

  it('de-duplicates and caps the fan-out so one call cannot burst the CDN', async () => {
    const calls = mockFetch();
    const many = Array.from({ length: 40 }, (_, i) => `${UPLOAD}?${i}`);
    await deriveImageRenders([...many, many[0]]);
    expect(calls).toHaveLength(5 * LIGHTBOX_WIDTHS.length); // MAX_IMAGES = 5
  });

  it('skips URLs the CDN cannot improve rather than hitting their origin', async () => {
    const calls = mockFetch();
    // A dev-only host is handed back unchanged by cdnSrc — warming it would be a
    // pointless request against the origin itself.
    await deriveImageRenders(['http://localhost:4321/img.png', '/relative.png', '']);
    expect(calls).toHaveLength(0);
  });

  it('never throws or rejects when the CDN fails — a save must not break', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(deriveImageRenders([UPLOAD])).resolves.toBeUndefined();
  });

  it('does nothing when there is nothing to warm', async () => {
    const calls = mockFetch();
    await deriveImageRenders([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The banner is the store page's LCP element, so a cold render there is the most expensive one on
 * the site — and it was the only image nobody pre-derived. What matters is that the widths warmed
 * here are byte-identical to the ones the page's `srcset` and `<head>` preload request: warming a
 * transform nobody asks for costs a request and leaves the visitor paying for the one they do.
 */
describe('deriveBannerRenders', () => {
  it('warms the CROPPED rungs the store page actually requests, not cdnSrc ones', async () => {
    const calls = mockFetch();
    await deriveBannerRenders(UPLOAD);
    expect(calls).toHaveLength(BANNER_WIDTHS.length);
    for (const w of BANNER_WIDTHS) {
      expect(calls.some((c) => c.url.includes(`c_fill,g_auto,f_auto,q_auto,w_${w},h_${Math.round(w / BANNER_RATIO)}/`))).toBe(true);
    }
  });

  it('uses HEAD, like the product path', async () => {
    const calls = mockFetch();
    await deriveBannerRenders(UPLOAD);
    expect(calls.every((c) => c.method === 'HEAD')).toBe(true);
  });

  it('does nothing for no banner, or one the CDN cannot improve', async () => {
    const calls = mockFetch();
    await deriveBannerRenders('');
    await deriveBannerRenders(undefined);
    await deriveBannerRenders('http://localhost:4321/banner.png');
    expect(calls).toHaveLength(0);
  });

  it('never throws — saving store settings must not depend on the CDN answering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(deriveBannerRenders(UPLOAD)).resolves.toBeUndefined();
  });
});
