/** Thumbnails come from the one shared delivery module (src/lib/cdn.ts) — the
 *  client bundle must not carry a second, weaker copy of that logic. */
export { cdnThumb as thumbUrl } from '../../lib/cdn.js';

/**
 * Cloudinary's unsigned-upload ceiling on the free tier. Checked here rather than at the provider
 * so an oversized photo fails with a sentence the seller can act on, instead of a 400 five seconds
 * into an upload.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * What Cloudinary accepts from an unsigned upload. A phone photo is very often HEIC — the file
 * picker's `accept="image/*"` admits it, the browser will happily show a preview of it, and the
 * upload is then rejected at the provider. Naming the formats here is what turns that into
 * "convert it to JPG" instead of "Image upload failed. Please try again."
 */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/**
 * Upload one image and return its delivered URL.
 *
 * **The failure path is the point of this function, not the happy path.** It used to throw
 * `Upload failed: 400` and discard the response body — so the seller saw a generic retry message,
 * retried, and got the same thing, while the ONE sentence explaining why (Cloudinary always sends
 * `{"error":{"message":…}}`) was read off the wire and dropped on the floor. That is how a broken
 * upload survives: nobody, including whoever is debugging it, is ever told the reason.
 */
export async function cloudinaryUpload(blob: Blob, cloud: string, preset: string): Promise<string> {
  if (blob.size === 0) throw new Error('הקובץ ריק');
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(`הקובץ גדול מדי (${(blob.size / 1024 / 1024).toFixed(1)}MB, המקסימום ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`);
  }
  // A Blob built by the cropper/background remover has no type of its own; only a file the seller
  // picked does, and that is the one that can be HEIC.
  if (blob.type && !ACCEPTED.includes(blob.type)) {
    throw new Error(`פורמט לא נתמך (${blob.type}) — נסה JPG או PNG`);
  }

  const fd = new FormData();
  // The third argument is the filename. Without it a Blob is sent as "blob" with no extension,
  // which leaves the provider guessing at the format.
  fd.append('file', blob, 'upload');
  fd.append('upload_preset', preset);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await uploadErrorMessage(res));
  const json = await res.json() as { secure_url: string };
  return json.secure_url;
}

/** Cloudinary's own words where it sent any, the status where it did not. */
async function uploadErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch { /* not JSON — fall through to the status */ }
  return `Upload failed: ${res.status}`;
}
