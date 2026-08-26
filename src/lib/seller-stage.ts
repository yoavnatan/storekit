/**
 * Where a seller stands, as ONE word — the vocabulary the whole platform uses to talk about a shop
 * on its way to being open.
 *
 * ── Why it exists (owner, סשן א׳ §17, 2026-08-26) ──
 * *"לכל שלב צריך איזושהי הגדרה מסויימת: פתח חנות וטרם שילם, הזין פרטי אשראי ולא הזין פרטי עסק, הזין
 * את שניהם וממתין לאישור הסליקה, וכו׳. כלומר תכין כבר תשתית שיהיה אפשר להשתמש בה בשאר האתר, בעברית
 * פשוטה לא מורכב מדי."*
 *
 * Every screen that had to answer this was answering it for itself. The overview card read the
 * first `PublishHold`; the go-live screen derived three booleans of its own; the payments tab asked
 * `clearingStatusFor`; the admin's seller list showed none of it. Four readings of one fact, and
 * they had already disagreed twice — a green tick over a review nobody had requested (2026-08-25),
 * and "חסרים פרטים" shown to a seller with nothing missing (the same week). A stage is not a fifth
 * reading: it is the one the others are derived from.
 *
 * ── What a stage is, and what it is NOT ──
 * It is a description, never a gate. **Nothing may branch on it to decide whether money moves or a
 * shop is published** — publication stays derived from `publishHoldsFor` and a sale stays gated by
 * `merchantBlockFor`, because those two answer "is it blocked" and this answers "where is he". A
 * second gate computed from a summary is exactly how the two would drift apart.
 *
 * ── The order is the funnel, and that is what makes it useful ──
 * `SELLER_STAGES` runs from "just registered" to "selling", so an admin screen can count sellers by
 * stage and read the drop-off straight down the list (session ד׳). The three terminal states are at
 * the end: they are not steps on the way anywhere.
 *
 * ── Plain Hebrew, one line each ──
 * The labels are in `translations.ts` under `stage<Id>`, because they are shown to people — the
 * seller on his own overview and the owner on the admin roster — and a phrase invented per screen
 * is how the same state acquires three names.
 */
import type { PublishHold } from './store-publication.js';
import type { StoreLifecycle } from './store-status.js';

export type SellerStage =
  /** Registered, and has not created a shop. Nothing is owed and nothing is pending. */
  | 'no-store'
  /** Building a shop. He has not started on the money at all — no business details, no card. */
  | 'building'
  /** He put a card on file and has not finished (or started) the business details. Real, and it is
   *  the reason the two steps are open at once: the plan is ours and the card is charged to OUR
   *  merchant, so it waits on the processor for nothing (`GoLiveSteps.astro`). */
  | 'card-only'
  /** The business details are complete and no card is on file — the mirror of the above. */
  | 'details-only'
  /** Everything he can do is done, and the processor is examining the business. Up to seven
   *  business days, and nobody can shorten it (agreement §11). */
  | 'awaiting-approval'
  /** The processor REFUSED the business (agreement §11 lets them, at their sole discretion). Not a
   *  step in the funnel and not a wait: it is the funnel stopping, and it is the one stage whose
   *  next action is a conversation rather than a click (`seller-merchant.ts#setMerchantApproval`
   *  logs it for us and notifies him). */
  | 'rejected'
  /** Approved and paying, and the shop is not up yet — the minutes between the last hold lifting
   *  and the publication sweep running. Narrow, and a real state a seller can be looking at. */
  | 'going-live'
  /** Selling. */
  | 'live'
  /** He paused it himself; it is still his and one click brings it back. */
  | 'paused'
  /** Closed, or blocked by us. Terminal from the funnel's point of view. */
  | 'closed';

export const SELLER_STAGES: readonly SellerStage[] = [
  'no-store', 'building', 'card-only', 'details-only', 'awaiting-approval', 'rejected', 'going-live', 'live', 'paused', 'closed',
];

/** The translation key for a stage's one-line label. Derived rather than mapped, so a stage added
 *  above cannot be given a label here and forgotten in the copy — the same rule
 *  `subscription-cancel.ts#cancelReasonKey` follows. */
export function sellerStageKey(stage: SellerStage): string {
  const camel = stage.replace(/-([a-z])/g, (_, c: string) => (c as string).toUpperCase());
  return `stage${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

export interface SellerStageInput {
  /** The lifecycle of the shop in question, or `null` for a seller with no shop at all. */
  lifecycle: StoreLifecycle | null;
  /** What is holding the ACCOUNT off the site (`store-publication.ts#publishHoldsFor`). */
  holds: readonly PublishHold[];
  /** A card is on file and nothing has been charged (`subscription-arm.ts`). */
  cardOnFile: boolean;
  /** The processor has refused or suspended the business — `clearingStatusFor` answering
   *  `'rejected'`. Checked before everything else in the funnel, because it is the only state in
   *  which the remaining steps do not matter. */
  clearingRejected?: boolean;
  /** The processor holds an APPROVED merchant account. Derived from the account's own state and
   *  never from the absence of a hold — an absent hold covers both "finished" and "never started",
   *  and reading it as the first is the bug of 2026-08-25 (`GoLiveSteps.astro`). */
  clearingReady: boolean;
}

/**
 * The seller's stage, from facts that are already computed elsewhere.
 *
 * Pure and synchronous on purpose: every caller already holds these four things, so this adds no
 * query to any page, and it can be asserted without a database.
 */
export function sellerStage(input: SellerStageInput): SellerStage {
  const { lifecycle, holds, cardOnFile, clearingReady, clearingRejected = false } = input;
  if (lifecycle === null) return 'no-store';
  // The live shop's own states come first: once a shop is up, nothing about the funnel describes
  // it, and a paused shop whose seller happens to be mid-something is paused.
  if (lifecycle === 'active') return 'live';
  if (lifecycle === 'paused') return 'paused';
  if (lifecycle === 'closing' || lifecycle === 'closed' || lifecycle === 'blocked') return 'closed';

  // A refusal outranks every step: the shop is down, and none of what is left to type would change
  // that. Placed after the live states on purpose — a shop that is already selling when the
  // processor suspends the account is a different problem, and `merchantBlockFor` is what stops the
  // sale; describing it as "not approved yet" on a live storefront would be the wrong sentence.
  if (clearingRejected) return 'rejected';

  // Unpublished, so the funnel applies. `holds` is ordered by the flow, but the answer here is not
  // "the first hold" — it is which of HIS two jobs are done, because they can be done in either
  // order and the overview must not tell him to do one he has finished.
  const detailsDone = !holds.includes('clearing-details');
  if (clearingReady && !holds.length) return 'going-live';
  if (detailsDone && cardOnFile) return 'awaiting-approval';
  if (cardOnFile) return 'card-only';
  if (detailsDone) return 'details-only';
  return 'building';
}
