/**
 * The verdict half of image moderation: what the app does with an upload the provider has judged.
 *
 * **What was and was not protected before this file (audited 2026-08-13).** Text was covered and
 * still is — `spam-filter.ts` blocks adult/gambling/pharma vocabulary in product names, categories
 * and tags at write time, and `image-url.ts` refuses anything that is not a well-formed https URL,
 * which stops injection but says nothing at all about what the picture shows. The image BYTES were
 * never looked at by anything. A seller could upload any photograph and it would render on a public
 * product page, in the sitemap, and — the expensive one — in the Google Merchant Center / Meta
 * Catalog feed that the whole platform shares one account for. One seller's photo is every seller's
 * ads (memory `project_ad_platform_account_risk`).
 *
 * **Why the check cannot live in our code.** Uploads go straight from the seller's browser to
 * Cloudinary with an unsigned preset (`scripts/dashboard/cloudinary.ts`); our server never sees the
 * bytes and putting it in the path would mean proxying every photo through a Node process. So the
 * classifier is Cloudinary's — an add-on enabled ON THE PRESET, in the console — and the only thing
 * that belongs in code is refusing to KEEP a URL the provider judged unusable. That is this file.
 *
 * **It is deliberately silent when the add-on is off.** No `moderation` array means nothing was
 * checked, and inventing a verdict from that would be worse than none. Enabling it is an owner step
 * (GO_LIVE §2.6) — until then this function returns `null` for every upload, which is the honest
 * description of an unmoderated pipeline, and the human backstop is the report flow
 * (`/api/report` → admin Alerts) plus admin block.
 *
 * **Use an AUTOMATIC add-on, never `manual`.** Manual moderation parks every upload in `pending`
 * until a person approves it in the Cloudinary console, and the asset is not delivered before that.
 * On this platform that would make a seller's product photo wait on the owner — the exact
 * admin-gatekeeping the zero-touch rule forbids (AI_INSTRUCTIONS → What we're building).
 *
 * **`pending`/`queued` let the upload THROUGH, and that is the one decision here worth arguing.**
 * It was the other way round for half a day, on the reasoning that an unapproved asset is not
 * delivered so its URL would render nothing. The reasoning is sound and the behaviour was still
 * wrong, because it assumed the verdict arrives IN the upload response. Cloudinary's own docs point
 * both ways and neither can be settled without an account (asked 2026-08-13): the Rekognition page
 * shows an example response already carrying `status: approved`, while the moderation page defines
 * `pending` as "in the process of being moderated but an outcome hasn't been reached yet" and
 * documents `notification_url` as the way to hear the result — i.e. asynchronous. **If it is
 * asynchronous, refusing `pending` refuses EVERY photo the moment the add-on is switched on**, and
 * a seller who cannot upload anything is a far worse failure than a photo that has to be re-picked.
 * So the ambiguity is resolved toward the recoverable side: an image that turns out not to render
 * is visible in the form's own preview and the seller replaces it in seconds.
 * ⚠️ The consequence, and it is why GO_LIVE §2.6 carries a row rather than a note: under the
 * asynchronous reading a `rejected` verdict arrives AFTER the product is saved, and pulling that
 * image back off the product needs the `notification_url` webhook, which is not built. Settle which
 * reading is true on the first real upload after enabling the add-on.
 *
 * Statuses are Cloudinary's own, verified against its moderation docs (2026-08-13):
 * `queued` · `pending` · `approved` · `rejected` · `aborted` (rejected by an earlier moderation).
 */

/** One entry of the `moderation` array Cloudinary adds to an upload response when an add-on ran. */
interface ModerationEntry {
  status?: unknown;
  kind?: unknown;
}

/** Refusals a person reads. Hebrew, like every other upload error in `cloudinary.ts` — the seller
 *  is the only one who ever sees them, and a rejection with no reason reads as a broken uploader. */
const REJECTED = 'התמונה נדחתה בבדיקת תוכן — בחר/י תמונה אחרת';

/**
 * The sentence to fail the upload with, or `null` when there is nothing to object to.
 *
 * Takes the parsed upload response rather than a `Response`, so it is a pure function the tests can
 * drive with the shapes the provider documents instead of a live account.
 */
export function moderationRefusal(uploadResponse: unknown): string | null {
  const list = (uploadResponse as { moderation?: unknown })?.moderation;
  // Not an array = the add-on is not enabled on this preset. Nothing was checked, so nothing is
  // claimed — see the module note.
  if (!Array.isArray(list) || list.length === 0) return null;

  const statuses = (list as ModerationEntry[])
    .map((entry) => (typeof entry?.status === 'string' ? entry.status : ''));

  // A single rejection decides it, whatever the other add-ons said — that is what `aborted` means
  // on the entries that never got to run. Everything else, `pending` and `queued` included, is not
  // a refusal: only an explicit NO stops a seller's upload. See the module note.
  return statuses.some((s) => s === 'rejected' || s === 'aborted') ? REJECTED : null;
}
