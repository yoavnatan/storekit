import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveImageRenders } from '../src/lib/image-derive.js';
import { LIGHTBOX_WIDTHS } from '../src/lib/cdn.js';

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
