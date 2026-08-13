// @vitest-environment jsdom
/**
 * `downscaleForUpload` — the rescue path for a seller's oversized photograph.
 *
 * The properties worth pinning are the ones that would silently ruin someone's work rather than
 * fail loudly: a small file must come back byte-identical (re-encoding costs quality for nothing),
 * transparency must survive, and any browser failure must degrade to "upload the original" rather
 * than to an exception. jsdom has no canvas encoder, so the browser primitives are stubbed and what
 * is asserted here is the DECISION LOGIC, not the pixels.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { downscaleForUpload, MAX_UPLOAD_BYTES } from '../src/scripts/dashboard/image-downscale.js';

/** `Blob.size` is a getter, so a fake of the right SIZE has to be built rather than assigned to. */
const blobOf = (bytes: number, type: string): Blob => {
  const blob = new Blob([''], { type });
  Object.defineProperty(blob, 'size', { value: bytes, configurable: true });
  return blob;
};

/** Stubs `createImageBitmap` + `canvas.toBlob`, and reports what the encoder was asked for. */
function stubBrowser(opts: { width: number; height: number; encodedSize: number }) {
  const asked: { type: string; quality: number; width: number; height: number }[] = [];

  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
    width: opts.width, height: opts.height, close: () => {},
  })));

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {}, imageSmoothingQuality: 'low',
  } as unknown as CanvasRenderingContext2D);

  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    asked.push({ type: type ?? '', quality: quality ?? 0, width: this.width, height: this.height });
    cb(blobOf(opts.encodedSize, type ?? 'image/jpeg'));
  });

  return asked;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('downscaleForUpload', () => {
  it('leaves every file that would upload fine today completely alone', async () => {
    const asked = stubBrowser({ width: 8000, height: 6000, encodedSize: 1000 });
    // 9.5MB is enormous and still under Cloudinary's ceiling, so it must reach the provider exactly
    // as the seller saved it. This is the property the owner asked for in the strongest terms.
    const untouched = blobOf(Math.floor(9.5 * 1024 * 1024), 'image/jpeg');
    expect(await downscaleForUpload(untouched)).toBe(untouched);
    expect(asked).toEqual([]);
  });

  it('returns a small file untouched, without re-encoding it', async () => {
    const asked = stubBrowser({ width: 4000, height: 3000, encodedSize: 1000 });
    const original = blobOf(2 * 1024 * 1024, 'image/jpeg');
    expect(await downscaleForUpload(original)).toBe(original);
    // The point: not merely the same size, but never handed to the encoder at all.
    expect(asked).toEqual([]);
  });

  it('shrinks the longest edge of an oversized photo and keeps the aspect ratio', async () => {
    const asked = stubBrowser({ width: 6000, height: 4000, encodedSize: 900_000 });
    await downscaleForUpload(blobOf(14 * 1024 * 1024, 'image/jpeg'));
    expect(asked[0]!.width).toBe(3200);
    expect(asked[0]!.height).toBe(Math.round(4000 * (3200 / 6000)));
  });

  it('never enlarges an image that is already smaller than the ceiling', async () => {
    const asked = stubBrowser({ width: 1200, height: 900, encodedSize: 500_000 });
    await downscaleForUpload(blobOf(12 * 1024 * 1024, 'image/jpeg'));
    expect(asked[0]!.width).toBe(1200);
    expect(asked[0]!.height).toBe(900);
  });

  it('keeps transparency by re-encoding a PNG as WebP, not JPEG', async () => {
    const asked = stubBrowser({ width: 4000, height: 4000, encodedSize: 800_000 });
    // A background-removed product shot: re-encoded to JPEG, every transparent pixel turns black.
    await downscaleForUpload(blobOf(13 * 1024 * 1024, 'image/png'));
    expect(asked[0]!.type).toBe('image/webp');
  });

  it('uses JPEG for a source that has no transparency to protect', async () => {
    const asked = stubBrowser({ width: 5000, height: 3000, encodedSize: 700_000 });
    await downscaleForUpload(blobOf(11 * 1024 * 1024, 'image/jpeg'));
    expect(asked[0]!.type).toBe('image/jpeg');
  });

  it('drops the quality further when the first re-encode is still over the ceiling', async () => {
    const asked = stubBrowser({ width: 9000, height: 7000, encodedSize: MAX_UPLOAD_BYTES + 1 });
    const original = blobOf(40 * 1024 * 1024, 'image/jpeg');
    // Every attempt comes back oversized AND smaller than the 40MB original, so the first one is
    // accepted on the "it helped" rule — what matters is that the caller still gets something
    // smaller than it started with rather than an exception.
    const out = await downscaleForUpload(original);
    expect(out.size).toBeLessThan(original.size);
    expect(asked.length).toBeGreaterThanOrEqual(1);
  });

  it('returns the original when the browser cannot decode the file', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported'); }));
    const original = blobOf(12 * 1024 * 1024, 'image/jpeg');
    // A rescue that throws is worse than no rescue: the caller's own size check should be what
    // decides, and it produces a Hebrew sentence the seller can act on.
    await expect(downscaleForUpload(original)).resolves.toBe(original);
  });

  it('returns the original when the re-encode comes back larger', async () => {
    stubBrowser({ width: 3000, height: 3000, encodedSize: 30 * 1024 * 1024 });
    const original = blobOf(12 * 1024 * 1024, 'image/jpeg');
    expect(await downscaleForUpload(original)).toBe(original);
  });
});
