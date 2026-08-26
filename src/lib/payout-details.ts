/**
 * The seller's bank account and business identity — validated, normalised, and nothing else.
 *
 * Pure, with no database and no request in sight, for the same reason `seller-account.ts` is pure:
 * this decides where a bank transfer goes, and every case has to be assertable from three literals.
 *
 * ── The product rule these fields live under, AMENDED 2026-08-11 ──
 * The rule is `feedback_seller_form_burden`, and what it forbids is a field that BLOCKS a seller —
 * a gate they cannot pass, or a rubric they cannot answer, standing between them and a working
 * shop. For a long time that was read as "never at registration or store-opening", and the owner
 * has replaced that reading with a sharper one: *"אני גם חושב שזה כן צריך להיות חלק מההרשמה…
 * או שזה יהיה חלק שאפשר לדלג עליו אבל שהוא כן יופיע"*.
 *
 * So the block IS on the store-opening card now (`CreateStoreCard.astro`), collapsed, headed "לא
 * חובה", with nothing `required` and a form that submits empty. **Optional is the invariant, not
 * absent.** A seller still uploads a catalogue, opens a store and takes orders without filling any
 * of it in; the balance accrues and is never forfeited, which `terms.astro` says in those words and
 * `payout-run.ts` implements by rolling the seller over rather than dropping them. What changed is
 * that they meet the question while they are thinking about being paid, instead of finding it weeks
 * later behind a banner.
 *
 * ⚠️ If you are about to "restore" the old rule by deleting that block: don't. It was a deliberate
 * reversal, and the thing to preserve is that no field there is ever required.
 *
 * ── Why the bank is all-four-or-nothing ──
 * `payout-run.ts#bankOf` returns null unless every field is present, because a transfer missing any
 * one of them cannot be made. A half-filled form must therefore read as "not ready" rather than
 * produce a payout that bounces — a bounced payout is a `failed` row, a seller asking why their
 * money did not arrive, and a month of delay. So the form is validated as a UNIT here, and a
 * partial submission is refused with the field that is missing rather than half-saved.
 *
 * ── Why the business id is checked for SHAPE and not for its check digit ──
 * Israeli identifiers (ת"ז, ח"פ, עמותה) carry a check digit, and enforcing it would catch a typo.
 * It is deliberately not enforced: the classes of number a registered business may hold here are
 * wider than the one algorithm, and this project's rule is not to state as verified what has not
 * been verified against the issuer. **A false rejection is unrecoverable from the seller's side** —
 * it blocks them from ever being paid, over a number that is correct. Nine digits is the shape
 * every one of them has, and it is what is enforced.
 */

export interface PayoutDetailsInput {
  bankCode?: unknown;
  bankBranch?: unknown;
  bankAccount?: unknown;
  bankAccountHolder?: unknown;
  businessId?: unknown;
  businessType?: unknown;
}

/** The stored shape. Every field optional and ABSENT rather than empty — `seller-auth.ts#toSeller`
 *  turns SQL nulls back into absent fields, and `payout-run.ts` reads a missing field as "not ready
 *  to be paid", which `''` would not satisfy in a form. */
export interface PayoutDetails {
  bankCode?: string;
  bankBranch?: string;
  bankAccount?: string;
  bankAccountHolder?: string;
  businessId?: string;
  businessType?: BusinessType;
}

export const BUSINESS_TYPES = ['exempt', 'licensed', 'company'] as const;

/** Which invoice a seller may issue — an עוסק פטור charges no VAT (`lib/vat.ts`), so it is not
 *  cosmetic and not derivable from anything else we hold. Declared HERE rather than imported from
 *  `seller-auth.ts` so the two modules stay one-directional: that one imports this. */
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Longest each field may be. Bank identifiers in Israel are short; the account holder is a name. */
const LIMITS = { code: 2, branch: 3, account: 20, holder: 120, businessId: 9 } as const;

/** Digits only. A seller types `12-345`, `12 345` or `‎12345` depending on where they copied it
 *  from, and all three name the same branch — normalising here is what stops three sellers with the
 *  same account producing three different bank files. */
function digits(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

export type PayoutDetailsResult =
  | { ok: true; details: PayoutDetails }
  /** `field` names the input to focus, so the form can point at the problem rather than
   *  showing one message above four boxes. */
  | { ok: false; field: string; error: string };

/**
 * Validate and normalise what the seller typed.
 *
 * The bank block is optional as a WHOLE (a seller may fill in only their business details, or clear
 * the account entirely) and mandatory as a UNIT once any part of it is given. That distinction is
 * the whole rule: "no bank yet" is a normal state for a seller's first month and must stay
 * expressible, while "three of four fields" is not a state a transfer can be made from.
 */
export function parsePayoutDetails(input: PayoutDetailsInput): PayoutDetailsResult {
  const bank = {
    code: digits(input.bankCode).slice(0, LIMITS.code),
    branch: digits(input.bankBranch).slice(0, LIMITS.branch),
    account: digits(input.bankAccount).slice(0, LIMITS.account),
    holder: text(input.bankAccountHolder, LIMITS.holder),
  };
  const filled = Object.entries(bank).filter(([, v]) => v !== '');
  if (filled.length > 0 && filled.length < 4) {
    // Written out rather than derived from the key. A `bank` + capitalised-key rule looks tidier
    // and produced `bankHolder` for a field the form calls `bankAccountHolder` — so the refusal
    // pointed at an input that does not exist and focused nothing. A four-entry map cannot be
    // subtly wrong; a naming convention across two files can.
    const INPUT_NAME = {
      code: 'bankCode', branch: 'bankBranch', account: 'bankAccount', holder: 'bankAccountHolder',
    } as const;
    const missing = (Object.keys(bank) as (keyof typeof bank)[]).find((k) => bank[k] === '')!;
    return { ok: false, field: INPUT_NAME[missing], error: 'חסרים פרטי בנק — צריך את כל ארבעת השדות כדי להעביר כסף' };
  }

  const businessId = digits(input.businessId).slice(0, LIMITS.businessId);
  if (businessId !== '' && businessId.length !== LIMITS.businessId) {
    return { ok: false, field: 'businessId', error: 'מספר עוסק/ח״פ הוא 9 ספרות' };
  }

  const businessType = typeof input.businessType === 'string' ? input.businessType : '';
  if (businessType !== '' && !(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
    return { ok: false, field: 'businessType', error: 'סוג העסק לא מוכר' };
  }

  // Absent, not empty — see `PayoutDetails`. An explicit clear reaches the caller as an absent
  // field and is written as SQL NULL there, which is the same thing "never filled in" looks like,
  // and deliberately so: both mean "there is nowhere to send this money".
  const details: PayoutDetails = {};
  if (filled.length === 4) {
    details.bankCode = bank.code;
    details.bankBranch = bank.branch;
    details.bankAccount = bank.account;
    details.bankAccountHolder = bank.holder;
  }
  if (businessId) details.businessId = businessId;
  if (businessType) details.businessType = businessType as BusinessType;
  return { ok: true, details };
}

/**
 * The two business fields, validated on their own.
 *
 * Split out of `parsePayoutDetails` on 2026-08-25, when they moved to the business-details form
 * (owner: *"פרטי העסק לא כוללים את סוג העסק, מספר הח״פ"* — and a form of that name that contains
 * neither is one a seller reasonably believes he has finished). Two forms now submit them, so the
 * rule about what they may contain is asked in one place rather than copied into the second.
 *
 * `undefined` means the submission did not carry the field at all, which is left alone rather than
 * cleared: the two forms can be open in two tabs and a save from either must not blank the other's
 * value (`project_multitab_concurrency`).
 */
export function parseBusinessFields(
  input: { businessId?: unknown; businessType?: unknown },
): { ok: true; businessId?: string | null; businessType?: string | null } | { ok: false; field: string; error: string } {
  const out: { ok: true; businessId?: string | null; businessType?: string | null } = { ok: true };

  if (input.businessId !== undefined) {
    const businessId = digits(input.businessId).slice(0, LIMITS.businessId);
    if (businessId !== '' && businessId.length !== LIMITS.businessId) {
      return { ok: false, field: 'businessId', error: 'מספר עוסק/ח״פ הוא 9 ספרות' };
    }
    out.businessId = businessId || null;
  }

  if (input.businessType !== undefined) {
    const businessType = typeof input.businessType === 'string' ? input.businessType : '';
    if (businessType !== '' && !(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
      return { ok: false, field: 'businessType', error: 'סוג העסק לא מוכר' };
    }
    out.businessType = businessType || null;
  }

  return out;
}

/**
 * Does the business number agree with the owner's ת.ז — and must it?
 *
 * ── The question (owner, סשן א׳ §13, 2026-08-26) ──
 * *"במקרה של עוסק פטור, אם אני מקליד מספר עוסק/ח״פ שלא תואם לת״ז צריך שם ולידציה?"* Yes, and it is
 * PayMe who make it necessary rather than us: an **עוסק פטור** and an **עוסק מורשה** are individuals
 * trading under their own name, so their business number IS their ת.ז — and PayMe enforce exactly
 * that when they open the account (GO_LIVE §3.1.0, and the sandbox note that records their refusal).
 * A **חברה** has a ח״פ, which is a different number by definition, so the rule must not be applied
 * to it.
 *
 * Without this the mismatch surfaces days later as a refusal from a processor, worded for a
 * merchant, about a form the seller filled in correctly as far as anything on screen said.
 *
 * ── It is a WARNING and never a refusal, and that is the whole shape ──
 * It returns a reason; it does not reject. The route saves everything first and reports this beside
 * the save, exactly the way an outstanding field is reported — because the two ways this can be
 * "wrong" are (a) he mistyped one of them, in which case losing the other nine fields is a
 * punishment for a typo, and (b) **we are wrong**, which the check-digit note above spends a
 * paragraph on: a false rejection is unrecoverable from the seller's side. Marking the field says
 * what PayMe will say, early enough to matter, without staking his account on our being right.
 *
 * Pure, so both surfaces that ask can ask it the same way.
 */
export function businessIdMatchesOwner(input: {
  businessType?: string | null;
  businessId?: string | null;
  ownerSocialId?: string | null;
}): boolean {
  // Only for the two types that trade under a person. Anything not yet answered is not a mismatch:
  // an incomplete form is the normal state of this screen.
  if (input.businessType !== 'exempt' && input.businessType !== 'licensed') return true;
  if (!input.businessId || !input.ownerSocialId) return true;
  return digits(input.businessId) === digits(input.ownerSocialId);
}

/**
 * Did this submission carry ANYTHING at all?
 *
 * Separate from `parsePayoutDetails` on purpose. An all-empty result is legitimate — it is how a
 * stored account is CLEARED, and `tests/payout-details.test.ts` pins that — so the parser cannot
 * refuse it. What is not legitimate is an all-empty submission from a seller who has nothing
 * stored: it writes nothing and used to answer "the details were saved", which is a confirmation
 * for an act that did not happen, on the screen where a seller is deciding whether to trust us
 * with an account number (owner, 2026-08-25).
 *
 * Only the ROUTE can tell the two apart, because only it knows what is on file. This is the half of
 * the question that is pure.
 */
export function isEmptyPayoutSubmission(details: PayoutDetails): boolean {
  return Object.keys(details).length === 0;
}

/** Can a payout actually be sent to this seller? The same all-four question `payout-run.ts#bankOf`
 *  asks, exported so the screen and the run cannot answer it differently — a banner that says
 *  "add your bank details" while the run would happily pay, or the reverse, is worse than neither. */
export function hasPayableBank(seller: PayoutDetails): boolean {
  return Boolean(seller.bankCode && seller.bankBranch && seller.bankAccount && seller.bankAccountHolder);
}

/**
 * The condition every red dot about money-with-nowhere-to-go is drawn from.
 *
 * It is a rule, not a query, so it lives beside `hasPayableBank` and takes the amount as a
 * parameter. Two callers supply that amount from two different places and both are correct:
 * the seller's own dashboard already holds their account and passes `payableNowAgorot` straight
 * from it, while the site header cannot afford to build one and asks the database for the same
 * figure (`payouts.ts#getPayableNowForSeller`). What must not vary is the TEST — a header dot
 * drawn on one condition and a tab dot on another is a seller following a dot to a screen with
 * nothing on it (owner, סשן א׳ §5).
 *
 * Both halves matter. Without money there is nothing to ask for, and asking anyway is the
 * registration-time entry barrier this project refuses to build (`feedback_seller_form_burden`).
 * Without the bank test the dot never clears.
 */
export function needsBankDetails(details: PayoutDetails, payableNowAgorot: number): boolean {
  return payableNowAgorot > 0 && !hasPayableBank(details);
}

/**
 * The business half of the closed summary card: `512345678 · עוסק מורשה`, or the "not set" label.
 *
 * **A composition rule with the WORDS passed in**, which is the shape this repo's client-renderer
 * rule asks for (`project_client_renderer_i18n_drift`). Two renderers draw this line — the panel's
 * `.astro` and the post-save patch in `scripts/dashboard/payouts.ts` — and if each assembled it
 * itself, the day a separator or the empty case changed one of them would stop matching. The
 * strings still come from `getT` on both sides; only the assembly is here.
 */
export function businessSummaryLine(
  details: PayoutDetails,
  typeLabels: Record<string, string>,
  missingLabel: string,
): string {
  if (!details.businessId) return missingLabel;
  const type = details.businessType ? typeLabels[details.businessType] : '';
  return type ? `${details.businessId} · ${type}` : details.businessId;
}

/** `12 · 345 · ****6789` — enough for a seller to recognise their own account, never the whole
 *  number. It is rendered inside their own dashboard, so this is not a secrecy boundary; it is so
 *  a screen-share or a support screenshot does not carry a full account number for no reason. */
export function maskedBankLine(seller: PayoutDetails): string | null {
  if (!hasPayableBank(seller)) return null;
  const account = seller.bankAccount!;
  const tail = account.length > 4 ? account.slice(-4) : account;
  return `${seller.bankCode} · ${seller.bankBranch} · ${'•'.repeat(Math.max(0, account.length - tail.length))}${tail}`;
}
