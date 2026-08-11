/**
 * The seller's bank account and business identity — validated, normalised, and nothing else.
 *
 * Pure, with no database and no request in sight, for the same reason `seller-account.ts` is pure:
 * this decides where a bank transfer goes, and every case has to be assertable from three literals.
 *
 * ── The product rule these fields live under ──
 * **They are never asked for at registration or at store-opening** (`feedback_seller_form_burden`).
 * A seller uploads a catalogue, opens a store and takes orders without ever meeting this form; it
 * exists on the payments screen, and the only thing that ever points at it is a banner that appears
 * when there is real money waiting and no account to send it to. Until then the balance accrues and
 * is never forfeited, which `terms.astro` says in those words and `payout-run.ts` implements by
 * rolling the seller over rather than dropping them.
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

/** `12 · 345 · ****6789` — enough for a seller to recognise their own account, never the whole
 *  number. It is rendered inside their own dashboard, so this is not a secrecy boundary; it is so
 *  a screen-share or a support screenshot does not carry a full account number for no reason. */
export function maskedBankLine(seller: PayoutDetails): string | null {
  if (!hasPayableBank(seller)) return null;
  const account = seller.bankAccount!;
  const tail = account.length > 4 ? account.slice(-4) : account;
  return `${seller.bankCode} · ${seller.bankBranch} · ${'•'.repeat(Math.max(0, account.length - tail.length))}${tail}`;
}
