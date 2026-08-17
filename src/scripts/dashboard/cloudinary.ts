/** Thumbnails come from the one shared delivery module (src/lib/cdn.ts) — the
 *  client bundle must not carry a second, weaker copy of that logic. */
export { cdnThumb as thumbUrl } from '../../lib/cdn.js';

import { downscaleForUpload, MAX_UPLOAD_BYTES } from './image-downscale.js';
import { moderationRefusal, moderationWentMissing, wasModerated } from '../../lib/image-moderation.js';
import { reportClientError } from '../error-reporter.js';

/** Whether an image-moderation add-on is expected to be running on the upload preset. A `PUBLIC_`
 *  var because the upload — and therefore the verdict — happens in the BROWSER; it is a statement
 *  of intent, not a secret. Read once here rather than per call: `import.meta.env` is inlined at
 *  build time, so this is a constant in the bundle either way. */
const MODERATION_EXPECTED = import.meta.env.PUBLIC_IMAGE_MODERATION_ON === 'true';

/** Once per page, not once per photo. A stopped filter is ONE condition, and the seller who
 *  discovers it is the one doing a bulk upload — without this, a hundred products file a hundred
 *  identical rows and spend the error reporter's whole per-session budget (5), which is how a real
 *  JavaScript error on the same page ends up unrecorded. The badge counts the condition as 1 for
 *  the same reason (`admin-tab-badges.ts`); this keeps the LOG from lying about it too. */
let moderationAlreadyReported = false;

/** The same cap on the other direction. A bulk upload of a hundred photos proves the filter is
 *  running exactly as well on the first one as on the hundredth, and a hundred writes to close the
 *  same report is a hundred round trips inside a seller's save. */
let moderationOkReported = false;

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
 * A refusal the seller has to ACT on, as opposed to a failure they should retry.
 *
 * **The distinction exists because "try again" is wrong advice for most of the errors this file
 * throws, and wrong advice is worse than none.** Every message below is surfaced by
 * `products.ts#uploadErrorText`, which wrapped all of them in "העלאת התמונה נכשלה. נסה שוב." — so a
 * seller told their photo is a HEIC, or too large, or was refused by content moderation, was
 * simultaneously told the fix is to press the same button again. It is not; the fix is a different
 * file. Marking these by NAME rather than by matching their text keeps the two halves from drifting
 * apart in different languages.
 *
 * A network failure and a provider 500 are deliberately NOT refusals: those really are worth
 * retrying, and they keep the retry wording.
 */
export const UPLOAD_REFUSED = 'UploadRefused';

function refuse(message: string): Error {
  const err = new Error(message);
  err.name = UPLOAD_REFUSED;
  return err;
}

/** Is this an error the seller must fix rather than repeat? */
export function isUploadRefusal(err: unknown): err is Error {
  return err instanceof Error && err.name === UPLOAD_REFUSED;
}

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
  if (original.size === 0) throw refuse('הקובץ ריק');
  // The format check runs on the ORIGINAL, before any re-encode: HEIC is what a seller actually
  // picked and what the message has to name, and `downscaleForUpload` would hand back a JPEG that
  // hides the real problem behind a confusing success.
  if (original.type && !ACCEPTED.includes(original.type)) {
    throw refuse(`פורמט לא נתמך (${original.type}) — נסה JPG או PNG`);
  }

  const blob = await downscaleForUpload(original);
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw refuse(`הקובץ גדול מדי (${(blob.size / 1024 / 1024).toFixed(1)}MB, המקסימום ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`);
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
  if (!res.ok) throw await uploadFailure(res);
  const json = await res.json() as { secure_url: string };

  // Content moderation, when the preset has an add-on on it: a judged-unusable asset must not
  // become a product photo, and the ONE place that can be enforced is here, where the URL is
  // about to be handed back to the form. `image-moderation.ts` carries the whole rationale —
  // including why it says nothing at all while the add-on is off.
  const refusal = moderationRefusal(json);
  if (refusal) throw refuse(refusal);

  // …and the other half: an add-on that was switched on and has since STOPPED (quota) is
  // indistinguishable from one that was never enabled, so the only thing that can tell the
  // difference is our own declared expectation. Reported, never thrown — a spent quota must not
  // stop sellers working, and the owner is the one who can act on it. Every upload samples it, so
  // there is nothing to schedule and nothing to remember.
  const missing = moderationWentMissing(json, MODERATION_EXPECTED);
  if (missing && !moderationAlreadyReported) {
    moderationAlreadyReported = true;
    reportClientError(missing);
  }

  // **And the signal that turns the alarm back OFF.** Without it the admin's card knew about
  // failures only: an unjudged upload raised it, a judged one said nothing, and silence cannot clear
  // a warning — so it sat there until somebody clicked "סמן כטופל" or the report aged out three
  // weeks later (owner, 2026-08-17: *"הוא לא יתעדכן אוטומטית בשום מצב?!"*). This is the missing half,
  // reported through the same mechanism as the fault and with the same once-per-page cap: the
  // uploads are the sampling, and one is enough to prove the filter ran.
  if (MODERATION_EXPECTED && !missing && wasModerated(json) && !moderationOkReported) {
    moderationOkReported = true;
    // silent: nothing was lost — this closes a stale admin note, and the seller it is fired from is
    // not the person it is for. A dropped request leaves the card up, which is the safe direction to
    // fail in, and the next upload asks again. A seller's save must never wait on, or fail because
    // of, our own bookkeeping.
    void fetch('/api/seller/moderation-ok', { method: 'POST', keepalive: true }).catch(() => {});
  }

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

  // Same account-level detection as the image path — an exhausted quota takes the whole Cloudinary
  // account down, so it blocks a seller's invoice exactly as readily as their product photo.
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/raw/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw await uploadFailure(res);
  const json = await res.json() as { secure_url: string };
  return json.secure_url;
}

/** Once per page, for the same reason as `moderationAlreadyReported`: an exhausted account quota is
 *  ONE condition, and a seller mid-bulk-upload would otherwise file one report per photo. */
let accountFailureReported = false;

/**
 * Turn a failed upload into the right error — and tell OUR fault apart from the seller's.
 *
 * Found the hard way on 2026-08-17, generating סהר's catalog: every upload started coming back
 *
 *     420 — Rate Limit Exceeded. Limit of 50 Rekognition AI Moderation operations reached.
 *           Try again on the next monthly billing usage date.
 *
 * because the preset had the moderation add-on on it and the free monthly allowance was spent. When
 * Cloudinary cannot run an add-on the preset demands, it refuses the whole upload — so a spent
 * add-on quota does not degrade image moderation, it takes DOWN image uploading.
 *
 * That message was going straight to sellers, in English, and the owner spotted what it means:
 * "אם זה ייחסם אז אין למוכרים איך להעלות תמונות". Every seller at once, with vendor wording that
 * blames nothing and advises waiting a month. It is the same account-wide blast radius as
 * `project_ad_platform_account_risk`, arriving through the image pipeline instead of the ad feed.
 *
 * So an account-level failure is now: a Hebrew sentence that says it is not their file, a REFUSAL
 * (`products.ts#uploadErrorText` would otherwise wrap it in "נסה שוב", and retrying a spent quota
 * is the one thing guaranteed not to work), and a report, because nobody but us can fix it and no
 * seller is going to describe it accurately.
 *
 * Everything else keeps the old behaviour — Cloudinary's own words where it sent any, which is what
 * turns a mystery 400 into a fixable one.
 */
async function uploadFailure(res: Response): Promise<Error> {
  let vendor = '';
  try {
    const body = await res.json() as { error?: { message?: string } };
    vendor = body?.error?.message ?? '';
  } catch { /* not JSON — the status is all there is */ }

  // 420 is Cloudinary's own rate-limit status and 429 the standard one. The text test catches a
  // quota refusal arriving under some other status, which is likelier than the reverse: the wording
  // is what Cloudinary's docs and its response agreed on, the status is an implementation detail.
  const accountLevel = res.status === 420 || res.status === 429
    || /rate limit|quota|operations reached|usage date/i.test(vendor);

  if (accountLevel) {
    if (!accountFailureReported) {
      accountFailureReported = true;
      reportClientError(`Cloudinary upload blocked account-wide (${res.status}): ${vendor || 'no message'}`);
    }
    // Owner's wording, 2026-08-17, replacing "מסיבה שאצלנו — לא בקובץ שלך": a seller does not need
    // to know whose fault it is, only what to do. Worth recording the caveat he was given and
    // accepted, because it is the one case where this sentence is wrong: a spent MONTHLY quota is
    // weeks, not a moment. It is the right copy anyway, because with the moderation add-on off the
    // realistic cause is a momentary rate limit — and if a monthly quota is ever hit again, the
    // report below is what actually resolves it, not the seller's next attempt.
    //
    // It stays a REFUSAL even though it now advises retrying: `products.ts#uploadErrorText` appends
    // its own "נסה שוב" to everything that is not one, and the sentence must not say it twice.
    return refuse('תקלה זמנית בהעלאת תמונות, אנא נסה שוב בעוד רגע.');
  }

  return new Error(vendor || `Upload failed: ${res.status}`);
}
