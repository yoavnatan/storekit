/**
 * Shrink an oversized photo in the browser, before it is uploaded.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Cloudinary's unsigned upload rejects anything over 10MB, and a seller with a good camera hits
 * that easily — a 6000×4000 export is routinely 12–18MB. Rejecting it is the wrong answer twice
 * over: it punishes exactly the sellers whose photographs are worth having, and it protects
 * nothing, because **the site never delivers an image above 2048px wide** (`cdn.ts`'s
 * `BANNER_WIDTHS` tops out there and `LIGHTBOX_WIDTHS` at 1600). Every pixel past that is uploaded,
 * stored, and then discarded by the CDN on the way to the shopper.
 *
 * So the limit stays where the provider put it, and this makes almost nothing reach it: the longest
 * edge comes down to `MAX_EDGE`, which is still comfortably above anything the site asks for, and
 * the bytes fall by an order of magnitude. The seller sees a fast upload instead of an error.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * It does not touch an image that is already small enough. Re-encoding a JPEG always loses a
 * little, so a photo under both thresholds is uploaded byte-for-byte as the seller chose it — this
 * is a rescue for the oversized case, not a compression pass over everyone's work.
 *
 * It also never upscales. A 700px image stays 700px; the CDN's `c_limit` would refuse to enlarge it
 * anyway, and enlarging here would only invent detail and cost bytes.
 *
 * ── Transparency ────────────────────────────────────────────────────────────
 * A background-removed PNG has an alpha channel, and re-encoding it to JPEG would fill every
 * transparent pixel with black — silently ruining exactly the images a seller worked hardest on.
 * Those keep an alpha-capable format (`image/webp`), which also happens to compress far better than
 * PNG. Everything else becomes JPEG.
 */

/**
 * The longest edge we reduce to. 3200 is well above the 2048 the CDN's largest rung ever asks for,
 * so the stored source stays bigger than anything a shopper is served even on a 2× large screen —
 * and it means a rescued photo is still a large photograph, not a web-sized copy of one.
 */
const MAX_EDGE = 3200;

/**
 * **Only a file that would otherwise be REJECTED is touched** (owner, 2026-08-13: "רק שלא תהרוס את
 * התמונות שהיוזר מעלה, המטרה היא לא לגרוע מהאיכות שלהן. ממש לא").
 *
 * This was 6MB for about ten minutes, which was wrong: a 7MB photograph uploads perfectly well
 * today, and re-encoding it would have spent a little of the seller's quality to solve a problem
 * that did not exist. The threshold is now the actual failure point, so the rule is simple and
 * safe — anything that works today is uploaded byte-for-byte exactly as it always was, and the
 * re-encode only ever happens instead of an error message.
 */
const SIZE_THRESHOLD_BYTES = 10 * 1024 * 1024;

/**
 * 0.92, not the usual 0.85. These are the seller's own product photographs and the file was going
 * to be refused outright, so the trade is "slightly recompressed" against "not uploaded at all" —
 * the quality is worth more here than the extra kilobytes, and Cloudinary re-encodes for delivery
 * from this source anyway.
 */
const QUALITY = 0.92;

/** Steps to try if 0.92 is still over the ceiling — a very large photograph can be. */
const FALLBACK_QUALITIES = [0.85, 0.75];

/** Cloudinary's unsigned-upload ceiling. Shared with the caller, which keeps it as a final guard. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Formats whose transparency must survive the round trip. */
const ALPHA_TYPES = ['image/png', 'image/webp', 'image/avif', 'image/gif'];

/**
 * Returns a blob small enough to upload — the original when it already was.
 *
 * Never throws for image reasons: if the browser cannot decode or re-encode the file, the original
 * is returned unchanged and the caller's own size check decides what the seller is told. A rescue
 * that turns a working upload into an exception would be worse than no rescue.
 */
export async function downscaleForUpload(blob: Blob): Promise<Blob> {
  if (blob.size <= SIZE_THRESHOLD_BYTES) return blob;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return blob;

  let bitmap: ImageBitmap;
  try {
    // `from-image` applies the EXIF orientation, without which a portrait phone photo is re-encoded
    // on its side — the rotation lives in metadata that a canvas round trip throws away.
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return blob;
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    const type = ALPHA_TYPES.includes(blob.type) ? 'image/webp' : 'image/jpeg';
    for (const quality of [QUALITY, ...FALLBACK_QUALITIES]) {
      const out = await toBlob(canvas, type, quality);
      // Only accept the re-encode if it actually helped. A pathological source can come back
      // larger, and uploading a bigger file than the seller picked is the one outcome worth
      // refusing outright.
      if (out && out.size < blob.size) return out;
      if (out && out.size <= MAX_UPLOAD_BYTES) return out;
    }
    return blob;
  } catch {
    return blob;
  } finally {
    bitmap.close();
  }
}

/** `canvas.toBlob` as a promise. Returns null when the browser declines the format. */
function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => { canvas.toBlob(resolve, type, quality); });
}
