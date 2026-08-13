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
 * admin-gatekeeping the zero-touch rule forbids (AI_INSTRUCTIONS → What we're building). `pending`
 * is therefore treated below as "not usable", not as "probably fine": a URL that does not render
 * is not something to store on a product.
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
const NOT_READY = 'התמונה ממתינה לבדיקת תוכן ועדיין לא ניתנת להצגה — נסה/י שוב בהמשך';

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
  // on the entries that never got to run.
  if (statuses.some((s) => s === 'rejected' || s === 'aborted')) return REJECTED;
  if (statuses.some((s) => s === 'pending' || s === 'queued')) return NOT_READY;
  return null;
}
