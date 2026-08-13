/**
 * "Is image moderation actually protecting anything right now?" — answered as a section at the top
 * of the admin's Alerts tab (`AdminModerationStatus.astro`, which carries the placement argument
 * and the two placements the owner rejected before it).
 *
 * **Why this file exists at all (owner, 2026-08-13).** The first version reported a stopped filter
 * through `reportClientError`, which lands in the Alerts tab as a `warning` — the quietest level,
 * beside every browser exception the platform has ever collected. His objection was exactly right:
 * *"it will get buried among the operational alerts"*. And it is worse than burial, because the two
 * things are different in kind. An entry in that log says **something happened once**. This says
 * **a protection is not running, and is still not running now** — a condition that persists until
 * somebody acts, which is precisely what a log cannot express: it has no way to stop being true.
 *
 * So the log entry stays as the durable record of WHEN it started, and the answer a person needs is
 * stated in words at the top of the tab that is already about things being wrong — where a reader
 * who has never seen it before can read it as one sentence. Nothing to notice, nothing to remember.
 *
 * **Two causes, one operational meaning: nobody is checking the pictures.**
 *   `off`     — `PUBLIC_IMAGE_MODERATION_ON` is not `true`. No add-on was ever declared. This is
 *               the platform's state today and the card is how it stops being invisible.
 *   `stopped` — it IS declared, and an upload came back with no verdict anyway. Cloudinary's docs:
 *               *"when quota runs out, that add-on stops"*, and on a free base plan the quota
 *               cannot be raised until the billing date. This is the dangerous one — it arrives
 *               mid-month, on its own, while the platform believes it is filtered.
 *
 * **On matching our own marker string.** `error-severity.ts` refuses to classify by message text,
 * and it is right: an exception's wording belongs to a dependency and can be influenced by input.
 * That argument does not reach here. The string matched below is one WE emit, from one place, as a
 * constant — `tests/image-moderation.test.ts` pins that the emitter still starts with it, so a
 * reworded message fails the suite instead of silently emptying this card.
 */

import { firstRow } from './db.js';
import { MODERATION_MISSING_MARKER } from './image-moderation.js';

/** How far back a "the filter stopped" report still describes NOW. Exported because the tab badge
 *  asks the same question with the same window — two windows would mean the tab could carry a "(1)"
 *  for a condition the section below it no longer shows. A quota resets on the billing
 *  date, so the window has to be long enough to cover most of a month — but a report from five
 *  weeks ago is history, and a warning that never clears is furniture (memory
 *  `feedback_no_standing_screen_prose`). */
export const MODERATION_STALE_DAYS = 21;

export type ImageModerationState = 'ok' | 'off' | 'stopped';

/** Whether an add-on is DECLARED to be running. Read from the same variable the browser reads, so
 *  the card and the uploader cannot disagree about what was promised. `PUBLIC_` vars are inlined at
 *  build time for the client and available through `process.env` on the server. */
export function moderationDeclaredOn(): boolean {
  return (process.env.PUBLIC_IMAGE_MODERATION_ON ?? '').trim() === 'true';
}

/**
 * The state to show. One query, and only when an add-on is declared — with nothing declared there
 * is nothing to look up, and the answer is already known.
 *
 * Never throws: a tab that 500s because it could not check a warning is a worse outcome than the
 * warning going unshown.
 */
export async function getImageModerationState(): Promise<ImageModerationState> {
  if (!moderationDeclaredOn()) return 'off';
  try {
    const row = await firstRow<{ n: string | number }>(
      `SELECT count(*) AS n FROM error_log
        WHERE message LIKE $1
          AND created_at > now() - make_interval(days => $2)`,
      [`${MODERATION_MISSING_MARKER}%`, MODERATION_STALE_DAYS],
    );
    return Number(row?.n ?? 0) > 0 ? 'stopped' : 'ok';
  } catch {
    // A failed lookup is not evidence of a healthy filter, but it is not evidence of a broken one
    // either — and inventing an alarm from a database hiccup is how a warning gets ignored.
    return 'ok';
  }
}
