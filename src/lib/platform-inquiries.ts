/**
 * Somebody writing to the platform — a fault, a complaint about content, a question.
 *
 * **This is `user-reports.ts` after the inbox merge (owner, 2026-08-19), and the change is where it
 * LANDS, not what it validates.** A report used to be a row in `user_reports`, rendered as a
 * one-way slip on the "התראות ושגיאות" tab: no reply, no thread, no way for the sender to see an
 * answer. The owner's ruling was about that tab — *"המטרה של הלשונית הזאת הייתה לוגים של כשלים
 * באפליקציה, לא פניות ממוכרים. בשביל זה יש את הודעות"* — so an inquiry is now a THREAD in the
 * Messages inbox, which the platform can answer.
 *
 * **What did NOT change is the rule that made the record worth having, and it is restated here
 * verbatim because it is the whole reason this is a module rather than a call:
 * the sender describes, the SERVER attributes.** `message` and `kind` are theirs. `pageUrl`,
 * `storeSlug`, the role and the id are read off the request and the session, never off the body. An
 * inquiry that let its sender name the store it is about would be a way to point the admin at a
 * competitor; one that let it name its own role would be a guest claiming to be a seller.
 *
 * Identity resolution is `lib/request-actor.ts`, shared with the error log — the same question
 * answered twice in two places is how one of the two answers ends up wrong. The only thing added
 * on top is the third role: a person writing here need never have signed in, so an unresolved actor
 * is a `guest` rather than a blank.
 */

import type { AstroCookies } from 'astro';
import { resolveRequestActor } from './request-actor.js';
import { safeRedirectPath } from './safe-redirect.js';
import { createInquiryThread, type InquiryKind } from './admin-messages.js';

/** Long enough for someone to describe what happened in their own words, short enough that the
 *  column is not a place to paste a file. The form counts down against the same number. */
export const MAX_REPORT_LEN = 2000;
const MAX_EMAIL_LEN = 200;
/** Matches `MAX_MESSAGE_SUBJECT_LEN`, which is the column's own limit. */
const MAX_SUBJECT_LEN = 120;
const MAX_PATH_LEN = 500;

/**
 * The sender's own classification — a triage hint, not a routing decision.
 *
 * Kept short for the reason migration 0025 gave and this inherits: a long menu makes a reporter
 * classify instead of describe. `question` joined the set with the merge — it is what a seller
 * writing to the platform is doing, and the old form had no word for it, which is part of why a
 * seller had no way in at all.
 */
export const REPORT_KINDS = ['fault', 'content', 'store', 'question', 'other'] as const;
export type ReportKind = InquiryKind;

/**
 * The subject each kind falls back to.
 *
 * A visitor reporting a fault is not asked for one: the three facts that make THAT actionable are
 * the three nobody types (which page, which store, who), and a subject box is a fourth field
 * standing between a person and the thing they came to say.
 *
 * **A seller writing to us IS asked** (owner, 2026-08-19: *"אני גם רוצה שיהיה שם נושא, שיהיה ברור
 * על מה הוא פונה… לא סתם בקלות ככה"*), and the asymmetry is the point rather than an inconsistency:
 * a seller is a business partner opening a conversation that will be answered, so naming it costs
 * them one line and saves the inbox from a column of identical headings. A visitor is a stranger
 * whose report is worth more than its filing.
 */
const SUBJECT: Record<ReportKind, string> = {
  fault: 'דיווח על תקלה',
  content: 'דיווח על תוכן',
  store: 'פנייה בנוגע לחנות',
  question: 'שאלה לפלטפורמה',
  other: 'פנייה',
};

export interface NewInquiryInput {
  kind: unknown;
  message: unknown;
  /** What the sender called it, when the surface asked. Falls back to the kind's own heading — an
   *  empty one must never reach the column, or the thread renders as "הודעת מערכת" and the inbox
   *  says nothing about which inquiry it is. */
  subject?: unknown;
  /** Optional, and an unusable one is DROPPED rather than made a reason to refuse: an inquiry is
   *  worth more than the way back to its author. Dropping it is also what keeps the panel honest —
   *  it says "ללא כתובת לחזרה" instead of offering a mailto that bounces. */
  senderEmail: unknown;
  /** The page they were on, as the browser reported it. Validated here, not by the caller. */
  pageUrl: unknown;
  /** The published review this is a complaint about, when the sender arrived from one. */
  reviewId?: unknown;
  cookies: AstroCookies;
}

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeKind(value: unknown): ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(value as string) ? (value as ReportKind) : 'other';
}

/** A site-relative path or nothing. `safeRedirectPath` is the shared rule for every
 *  request-supplied destination on this platform (Hard rules → Security review gate) and it applies
 *  here for the same reason: the admin panel renders this value as a link. */
function normalizePath(value: unknown): string | null {
  const raw = clamp(value, MAX_PATH_LEN);
  return raw ? (safeRedirectPath(raw, '') || null) : null;
}

/**
 * Record one inquiry as a thread. Returns `false` only when there is nothing to record (an empty
 * message) — a database failure THROWS, unlike `logError`, because here the caller can tell the
 * person their message did not go through, and silently swallowing it is the one outcome worse than
 * an error message.
 */
export async function createPlatformInquiry(input: NewInquiryInput): Promise<boolean> {
  const message = clamp(input.message, MAX_REPORT_LEN);
  if (!message) return false;

  const pageUrl = normalizePath(input.pageUrl);
  const actor = await resolveRequestActor(pageUrl ?? '', input.cookies);
  const role = actor.actorRole ?? 'guest';
  const kind = normalizeKind(input.kind);

  await createInquiryThread({
    subject: clamp(input.subject, MAX_SUBJECT_LEN) ?? SUBJECT[kind],
    content: message,
    party: {
      role,
      // The typed, foreign-keyed column only when the sender really holds a seller account — so a
      // buyer can never be read back as the owner of a store (`createInquiryThread` re-checks).
      ...(role === 'seller' && actor.actorId ? { sellerId: actor.actorId } : {}),
      ...(actor.actorId ? { id: actor.actorId } : {}),
      // The address to answer at: what they typed, or — for a signed-in sender who typed nothing —
      // the one on their account, which `request-actor.ts` already resolved for the admin screens
      // (`actorLabel`). No extra query, and it closes the case where a seller writes from inside
      // the product and the inbox has no way back to them.
      //
      // No NAME is resolved here on purpose: that would be a second lookup on the path of every
      // fault report, including the ones filed while the site is already failing.
      ...(clamp(input.senderEmail, MAX_EMAIL_LEN) ?? clamp(actor.actorLabel, MAX_EMAIL_LEN)
        ? { email: (clamp(input.senderEmail, MAX_EMAIL_LEN) ?? clamp(actor.actorLabel, MAX_EMAIL_LEN))! }
        : {}),
    },
    kind,
    ...(pageUrl ? { pageUrl } : {}),
    ...(actor.storeSlug ? { storeSlug: actor.storeSlug } : {}),
    ...(typeof input.reviewId === 'string' && input.reviewId ? { reviewId: input.reviewId } : {}),
  });
  return true;
}
