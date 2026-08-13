/** Thumbnails come from the one shared delivery module (src/lib/cdn.ts) — the
 *  client bundle must not carry a second, weaker copy of that logic. */
export { cdnThumb as thumbUrl } from '../../lib/cdn.js';

import { downscaleForUpload, MAX_UPLOAD_BYTES } from './image-downscale.js';
import { moderationRefusal, moderationWentMissing } from '../../lib/image-moderation.js';
import { reportClientError } from '../error-reporter.js';

/** Whether an image-moderation add-on is expected to be running on the upload preset. A `PUBLIC_`
 *  var because the upload — and therefore the verdict — happens in the BROWSER; it is a statement
 *  of intent, not a secret. Read once here rather than per call: `import.meta.env` is inlined at
 *  build time, so this is a constant in the bundle either way. */
const MODERATION_EXPECTED = import.meta.env.PUBLIC_IMAGE_MODERATION_ON === 'true';

/**
 * Cloudinary's unsigned-upload ceiling on the free tier, and now a LAST resort rather than the
 * first thing a seller with a good camera meets.
 *
 * The check below still exists and still explains itself in Hebrew, but almost nothing should ever
 * reach it: `downscaleForUpload` shrinks an oversized photo in the browser first, because the site
 * never delivers above 2048px anyway and rejecting a 14MB photograph threw away a seller's work to
 * protect a limit that the CDN was going to enforce for free. Its header carries the reasoning.
 */

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
export async function cloudinaryUpload(original: Blob, cloud: string, preset: string): Promise<string> {
  if (original.size === 0) throw new Error('הקובץ ריק');
  // The format check runs on the ORIGINAL, before any re-encode: HEIC is what a seller actually
  // picked and what the message has to name, and `downscaleForUpload` would hand back a JPEG that
  // hides the real problem behind a confusing success.
  if (original.type && !ACCEPTED.includes(original.type)) {
    throw new Error(`פורמט לא נתמך (${original.type}) — נסה JPG או PNG`);
  }

  const blob = await downscaleForUpload(original);
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(`הקובץ גדול מדי (${(blob.size / 1024 / 1024).toFixed(1)}MB, המקסימום ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`);
  }

  const fd = new FormData();
  // **A picked File keeps its own name; only a nameless Blob is given one.** This is the line most
  // likely to have been the 400 (2026-08-03) and it is worth stating precisely. A `File` from the
  // picker carries `photo.jpg` and FormData uses it. A Blob produced by the cropper or the
  // background remover has no name at all, and FormData then sends `filename="blob"` — no
  // extension, nothing for the provider to key the format off. Passing a filename unconditionally
  // would fix that and simultaneously THROW AWAY the real one, so the two cases are separated.
  if (blob instanceof File) fd.append('file', blob);
  else fd.append('file', blob, `upload.${extensionFor(blob.type)}`);
  fd.append('upload_preset', preset);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await uploadErrorMessage(res));
  const json = await res.json() as { secure_url: string };

  // Content moderation, when the preset has an add-on on it: a judged-unusable asset must not
  // become a product photo, and the ONE place that can be enforced is here, where the URL is
  // about to be handed back to the form. `image-moderation.ts` carries the whole rationale —
  // including why it says nothing at all while the add-on is off.
  const refusal = moderationRefusal(json);
  if (refusal) throw new Error(refusal);

  // …and the other half: an add-on that was switched on and has since STOPPED (quota) is
  // indistinguishable from one that was never enabled, so the only thing that can tell the
  // difference is our own declared expectation. Reported, never thrown — a spent quota must not
  // stop sellers working, and the owner is the one who can act on it. Every upload samples it, so
  // there is nothing to schedule and nothing to remember.
  const missing = moderationWentMissing(json, MODERATION_EXPECTED);
  if (missing) reportClientError(missing);

  return json.secure_url;
}

/**
 * The extension for a nameless blob's MIME type.
 *
 * This used to be `png` or `jpg` and nothing else, which was true while a nameless blob could only
 * come from the cropper. `downscaleForUpload` can now hand back **WebP** — that is how a
 * background-removed PNG keeps its transparency through the re-encode — and sending it as
 * `upload.jpg` tells the provider the wrong thing about bytes it then has to sniff.
 */
function extensionFor(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/avif') return 'avif';
  if (type === 'image/gif') return 'gif';
  return 'jpg';
}

/** What the invoice slot accepts. A PDF is what every invoicing system exports; the two image types
 *  are the seller who tore the page out of a paper book and photographed it. Nothing else: a Word
 *  file is editable (so it is a poor record) and the buyer may have nothing that opens it. */
const INVOICE_ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png'];
export const INVOICE_ACCEPT_ATTR = 'application/pdf,image/jpeg,image/png';

/**
 * Upload a seller's invoice for one order, through the SECOND preset.
 *
 * **`raw`, not `image`, and the difference is not cosmetic.** Cloudinary happily ingests a PDF as an
 * image resource — it rasterises pages and can transform them — and delivering it then depends on an
 * account-level security setting for PDFs. `raw` stores and serves the bytes the seller uploaded, so
 * what the buyer opens is the document the seller issued rather than something Cloudinary rendered
 * from it. A tax document is the one file on this platform that must come back unchanged.
 *
 * The size and empty-file checks are shared with `cloudinaryUpload` above by being repeated in one
 * function rather than two: this one calls it for nothing, because the image path's FORMAT rules are
 * exactly what must not apply here.
 */
export async function cloudinaryUploadInvoice(file: File, cloud: string, preset: string): Promise<string> {
  if (file.size === 0) throw new Error('הקובץ ריק');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`הקובץ גדול מדי (${(file.size / 1024 / 1024).toFixed(1)}MB, המקסימום ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`);
  }
  if (file.type && !INVOICE_ACCEPTED.includes(file.type)) {
    throw new Error(`פורמט לא נתמך (${file.type}) — נסו PDF, JPG או PNG`);
  }
  if (!preset) throw new Error('העלאת חשבוניות לא מוגדרת');

  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', preset);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/raw/upload`, { method: 'POST', body: fd });
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
