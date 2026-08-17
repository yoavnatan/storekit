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
 * **`pending`/`queued` let the upload THROUGH — and the ambiguity that made that a hard call is now
 * SETTLED: the verdict is synchronous.** ✅ Measured 2026-08-17, against the live account, by
 * uploading through the same unsigned preset the browser uses and printing the response:
 *
 *     "moderation": [{ "kind": "aws_rek", "status": "approved",
 *                      "response": { "moderation_labels": [], "moderation_model_version": "7.0",
 *                                    "content_types": [] },
 *                      "updated_at": "2026-08-17T10:47:53Z" }]
 *
 * The verdict is in the upload response itself. That closes the question this file carried open
 * since 2026-08-13, when Cloudinary's own docs pointed both ways and neither reading could be
 * checked without an account: the Rekognition page showed a response already carrying
 * `status: approved`, while the moderation page defined `pending` as "an outcome hasn't been
 * reached yet" and documented `notification_url` as how you hear the result.
 *
 * **What being synchronous means, and it is the good outcome:** a rejected photo is refused HERE,
 * before the product is ever saved, so `moderationRefusal` is the whole enforcement and the
 * `notification_url` webhook is not needed. GO_LIVE §2.6's ⚠️ row — "a `rejected` verdict arrives
 * after the product is saved and pulling it back needs a webhook that is not built" — was written
 * for the asynchronous reading and no longer describes anything.
 *
 * `pending`/`queued` still pass rather than block, and that stays deliberate: this is one account's
 * behaviour on one add-on, a queue under load could still answer `pending`, and refusing on it
 * would mean a seller who can upload nothing at all — far worse than a photo that has to be
 * re-picked, which the form's own preview shows immediately.
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

/** Did an add-on actually judge this upload? The two questions below both need it, and "the array
 *  is missing or empty" is the only evidence either way. */
export function wasModerated(uploadResponse: unknown): boolean {
  const list = (uploadResponse as { moderation?: unknown })?.moderation;
  return Array.isArray(list) && list.length > 0;
}

/**
 * The sentence to fail the upload with, or `null` when there is nothing to object to.
 *
 * Takes the parsed upload response rather than a `Response`, so it is a pure function the tests can
 * drive with the shapes the provider documents instead of a live account.
 */
export function moderationRefusal(uploadResponse: unknown): string | null {
  // Not moderated = the add-on is not enabled on this preset, or it has STOPPED (see
  // `moderationWentMissing` below). Nothing was checked, so nothing is claimed — the module note
  // says why that silence is correct here and where the alarm lives instead.
  if (!wasModerated(uploadResponse)) return null;

  const list = (uploadResponse as { moderation: ModerationEntry[] }).moderation;
  const statuses = list.map((entry) => (typeof entry?.status === 'string' ? entry.status : ''));

  // A single rejection decides it, whatever the other add-ons said — that is what `aborted` means
  // on the entries that never got to run. Everything else, `pending` and `queued` included, is not
  // a refusal: only an explicit NO stops a seller's upload. See the module note.
  return statuses.some((s) => s === 'rejected' || s === 'aborted') ? REJECTED : null;
}

/**
 * **The alarm for a filter that switched itself off.** Returns a message to report when moderation
 * was supposed to run and did not, else `null`.
 *
 * This exists because of one sentence in Cloudinary's own billing documentation (checked
 * 2026-08-13): *"Add-ons with a usage quota hit a hard limit instead: when quota runs out, that
 * add-on stops until it renews or you change tier."* — and, on a free base plan, the quota cannot
 * be raised mid-month. A stopped add-on returns an upload response with no `moderation` key, which
 * is byte-for-byte what an add-on that was never enabled returns. So on the day the quota runs out,
 * every check above starts answering "nothing to object to", and the platform carries on believing
 * it is filtered. **A protection that disappears without saying so is worse than no protection**,
 * because the second one is at least known.
 *
 * The distinguishing fact cannot come from the response — it has to come from US saying whether an
 * add-on is expected. That is `PUBLIC_IMAGE_MODERATION_ON`, and it is the entire mechanism: one
 * declared expectation, compared against what actually arrived. No scheduled job, no Admin API
 * credentials, no quota polling — the uploads themselves are the sampling.
 *
 * Reported, never blocking. A quota that ran out must not also stop sellers from working; the
 * owner is the one who can act on it, and `error-log.ts` is where they already look.
 */
export function moderationWentMissing(uploadResponse: unknown, expected: boolean): string | null {
  if (!expected || wasModerated(uploadResponse)) return null;
  return `${MODERATION_MISSING_MARKER} the upload came back with no moderation verdict — the `
    + 'Cloudinary add-on is off, or its monthly quota has run out and it has stopped. '
    + 'Uploads are NOT being filtered right now. See GO_LIVE §2.6.';
}

/**
 * The constant prefix every such report starts with.
 *
 * It is a prefix rather than a code because the string has two readers with opposite needs: a
 * person scanning the Alerts tab, who wants a sentence, and `image-moderation-health.ts`, which
 * asks the log "has this happened lately" to decide whether the admin's Overview shows a card. That
 * module's header argues why matching a marker we emit ourselves is a different thing from
 * classifying an exception's wording; `tests/image-moderation.test.ts` pins the join so a reworded
 * message fails the suite instead of quietly emptying the card.
 */
export const MODERATION_MISSING_MARKER = 'Image moderation is declared ON but did not run:';
