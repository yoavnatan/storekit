/**
 * What PayMe need to open a seller's clearing account, and nothing else.
 *
 * Pure — no database, no request — for the same reason `payout-details.ts` is: this decides whether
 * a real merchant account gets opened in a real person's name, and every case has to be assertable
 * from three literals.
 *
 * ── The product rule these fields live under ──
 * `feedback_seller_form_burden`, in the sharper reading the owner settled on (2026-08-11): what is
 * forbidden is a field that BLOCKS a seller — a gate between them and a working shop — not a field
 * that exists. So none of this is asked at registration, none of it at store opening, and a seller
 * uploads a catalogue and designs a shop having met none of it. It is asked of a seller who wants
 * to take money, because PayMe will not open an account without it and there is no version of this
 * platform where that is negotiable.
 *
 * ── And it is deliberately the MINIMUM ──
 * `create-seller` answers with `seller_dashboard_signup_link` — a page the seller completes his own
 * details on. So the split is: what PayMe make mandatory in the API call, we ask; everything else
 * he does at their end, on his own time, with us out of the middle. That link is why this list is
 * nine fields and not thirty.
 *
 * ── Dates are DD/MM/YYYY because PayMe say so ──
 * Not ISO, and this is exactly the kind of thing that looks like a formatting detail and is not:
 * `06/05/1989` in their format is 6 May, and an ISO-minded implementation sending `1989-05-06`
 * either fails the call or — worse, if their parser is lenient — opens an account against the wrong
 * birth date, which is a KYC mismatch discovered weeks later by a compliance officer. So the wire
 * format is produced HERE, once, from a value stored as ISO, and no call site formats a date.
 */

import { isDayISO } from './business-day.js';

/** What we hold, stored as ISO so it is sortable and unambiguous at rest. Converted to PayMe's
 *  DD/MM/YYYY at the edge, in `paymeDate`. */
export interface MerchantKyc {
  /** ת.ז of the account owner — the human PayMe are onboarding, who may not be the business. */
  ownerSocialId: string;
  /** ISO `YYYY-MM-DD`. */
  ownerBirthdate: string;
  /** ISO `YYYY-MM-DD` — when the ID card was issued. PayMe's own anti-fraud check. */
  ownerSocialIdIssued: string;
  /** PayMe's enum: 0 male, 1 female. Theirs, not a category this platform would otherwise hold. */
  ownerGender: 0 | 1;
  /** Mobile — PayMe reject a landline here, so the label has to say mobile. */
  ownerPhone: string;
  /** ISO `YYYY-MM-DD` — when the business was registered. */
  businessRegisteredOn: string;
  /** PayMe's own five-digit merchant category code — NOT an ISO 18245 MCC. See the block below. */
  businessCategory: string;
  businessCity: string;
  businessStreet: string;
  businessStreetNumber: string;
}

/**
 * ⚠️ **There is no default merchant category, and that is a finding rather than an omission.**
 *
 * This used to fall back to `5999` — ISO 18245's "Miscellaneous and Specialty Retail Stores", the
 * international catch-all. **PayMe do not use ISO 18245.** Their own Israeli MCC list (read from
 * their documentation 2026-08-23) is a private numbering starting at 10000 and enumerated by trade:
 * `10009 מאפיה`, `10200 הלבשה כללית`, `10223 מסחר קמעונאי במוצרי פרזול-חנויות כלליות`, and so on for
 * hundreds of rows. `5999` is not in it at all, so every seller onboarded with that fallback would
 * have been created against a code their system does not recognise.
 *
 * And there is no generic row to replace it with: the closest candidates are all "general" WITHIN a
 * trade, never across trades. So a category is a fact about a particular business that has to be
 * chosen, and a value we invent is worse than a value we do not have — an unrecognised code is a
 * merchant PayMe cannot underwrite, discovered by the seller as a restricted account.
 *
 * `missingMerchantKyc` therefore treats an absent category as missing, exactly like a bank account:
 * the seller is simply not onboarded yet, which is a state the whole flow already handles.
 *
 * ⚠️ **Open product decision:** who picks, and from what. The list is far too long to put in front
 * of a seller, and `feedback_seller_form_burden` forbids a rubric he cannot answer. Mapping our own
 * store categories onto theirs is the obvious route and nobody has done it (GO_LIVE §3.1.2).
 */

/** Every field of `MerchantKyc`, in the order a form would ask them. The single source for
 *  "what is still missing" — a hand-written list at a call site is the copy that goes stale the
 *  first time a field is added. */
export const MERCHANT_KYC_FIELDS = [
  'ownerSocialId', 'ownerBirthdate', 'ownerSocialIdIssued', 'ownerGender', 'ownerPhone',
  'businessRegisteredOn', 'businessCategory', 'businessCity', 'businessStreet', 'businessStreetNumber',
] as const satisfies readonly (keyof MerchantKyc)[];

export type MerchantKycField = (typeof MERCHANT_KYC_FIELDS)[number];

function digits(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\D/g, '').slice(0, max) : '';
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

/** An ISO day, or '' if it is not one. `isDayISO` and not a local regex, deliberately: the obvious
 *  hand-rolled shape check accepts the 30th of February and the 99th month, and that mistake has
 *  already cost this repo a 500 (`business-day.ts#isDayISO` carries the whole finding). A birth
 *  date that does not exist is a KYC rejection weeks after the account was opened. */
function isoDate(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return isDayISO(raw) ? raw : '';
}

/**
 * ISO `YYYY-MM-DD` → PayMe's `DD/MM/YYYY`.
 *
 * String slicing rather than a `Date`: the value is already known to be a valid ISO date, and
 * constructing a `Date` to reformat it re-introduces a timezone — `new Date('1989-05-06')` is
 * midnight UTC, and rendering it in Israel's local time on any implementation that does so moves it
 * to 5 May. A birth date that is a day early is a KYC mismatch, and it would look like a typo.
 */
export function paymeDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * Normalise whatever a form sent into the stored shape, dropping anything that is not usable.
 *
 * A field that fails validation comes back ABSENT rather than as `''`, so `missingMerchantKyc`
 * reports it and a half-filled record can never be mistaken for a complete one. Refusing the whole
 * submission instead would lose the eight fields the seller did get right.
 */
export function normalizeMerchantKyc(input: unknown): Partial<MerchantKyc> {
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Partial<MerchantKyc> = {};

  // Nine digits — the shape every Israeli ת.ז has. The check digit is deliberately NOT enforced,
  // for the reason `payout-details.ts` gives at length: a false rejection is unrecoverable from the
  // seller's side, and it would block a correct number.
  const socialId = digits(raw.ownerSocialId, 9);
  if (socialId.length === 9) out.ownerSocialId = socialId;

  const birthdate = isoDate(raw.ownerBirthdate);
  if (birthdate) out.ownerBirthdate = birthdate;

  const issued = isoDate(raw.ownerSocialIdIssued);
  if (issued) out.ownerSocialIdIssued = issued;

  // The empty string is excluded from the conversion, not just from the comparison — `Number('')`
  // is `0`, and `0` is PayMe's value for MALE. Without the length check an unanswered gender field
  // is recorded as a definite answer, on a KYC form, for every seller who skipped it. Caught by
  // `tests/merchant-kyc.test.ts` after this was written the obvious way round.
  const gender = typeof raw.ownerGender === 'string'
    ? (raw.ownerGender.trim() === '' ? undefined : Number(raw.ownerGender))
    : raw.ownerGender;
  if (gender === 0 || gender === 1) out.ownerGender = gender;

  // Israeli mobile: 10 digits starting 05, or 12 with the country code. Normalised to the local
  // form PayMe's examples use (`0540123456`) so one seller's `+972-54-…` and another's `054 …`
  // reach them identically.
  const phone = digits(raw.ownerPhone, 15);
  const local = phone.startsWith('972') ? `0${phone.slice(3)}` : phone;
  if (/^05\d{8}$/.test(local)) out.ownerPhone = local;

  const registered = isoDate(raw.businessRegisteredOn);
  if (registered) out.businessRegisteredOn = registered;

  // No fallback — see the header. Their codes are five digits and their own (10000+), not ISO's
  // four, so the WIDTH is theirs too: a four-digit value is an ISO code somebody carried across,
  // and it would not be recognised.
  const category = digits(raw.businessCategory, 5)
  if (category.length === 5) out.businessCategory = category;

  const city = text(raw.businessCity, 60);
  if (city) out.businessCity = city;
  const street = text(raw.businessStreet, 80);
  if (street) out.businessStreet = street;
  const streetNumber = text(raw.businessStreetNumber, 10);
  if (streetNumber) out.businessStreetNumber = streetNumber;

  return out;
}

/** Which of PayMe's required fields we still do not hold. Empty means the account can be opened. */
export function missingMerchantKyc(kyc: Partial<MerchantKyc> | null | undefined): MerchantKycField[] {
  const held = kyc ?? {};
  return MERCHANT_KYC_FIELDS.filter((field) => held[field] === undefined || held[field] === '');
}

export function isCompleteMerchantKyc(kyc: Partial<MerchantKyc> | null | undefined): kyc is MerchantKyc {
  return missingMerchantKyc(kyc).length === 0;
}

/**
 * For an osek murshe, PayMe require the business number to EQUAL the owner's social id.
 *
 * Their refusal, verbatim (measured 2026-08-23 on a real `create-seller`):
 *
 *     114 - for business type "osek murshe" the business number must equal the owner's ID number
 *
 * **This would reject a real seller, and quietly.** The two values are collected by two different
 * forms - `businessId` by `payout-details.ts`, `ownerSocialId` here - with labels that invite an
 * osek murshe to type his business number in one and his ID in the other. Nothing compared them, so
 * the refusal would happen at PayMe, on a screen he never sees, and his store would simply never be
 * able to sell. `seller_inc` 2 is the commonest kind of seller this platform will have.
 *
 * Reported as a MISSING FIELD rather than silently corrected: which of the two numbers is wrong is
 * his to say, and overwriting one with the other would file a business under an identifier nobody
 * chose.
 */
export function businessIdMismatch(
  businessType: string | undefined,
  businessId: string | undefined,
  ownerSocialId: string | undefined,
): boolean {
  if (businessType !== 'licensed') return false;
  if (!businessId || !ownerSocialId) return false;
  return businessId !== ownerSocialId;
}

/**
 * PayMe's `seller_inc` enum, from the business type we already hold.
 *
 * **CORRECTED 2026-08-23 against their real list, and two of the three were wrong.** The values had
 * been taken from their old raw spec, which describes a different enum entirely
 * (`0/1 individual, 2 licensed company, 5 exempt`). Their documentation's Israeli list is:
 *
 *     1 private individual | 2 osek murshe | 3 limited company | 4 partnership | 5 osek patur | ...
 *
 * So a `company` is **3**, not 2; and a `licensed` seller (osek murshe) is **2**, not 1. Only
 * `exempt` happened to land on the right number.
 *
 * **The old fallback was the worst part:** an unknown type returned `1`, which in this list is a
 * PRIVATE INDIVIDUAL - precisely the category the platform excludes (sellers are registered
 * businesses only, AI_INSTRUCTIONS -> Business model) and that PayMe would underwrite differently.
 * It now returns `null` and `create-seller` is not called: a business type we cannot map is a
 * seller we do not yet know enough about, which the onboarding already handles honestly.
 */
export function paymeIncorporation(businessType: string | undefined): number | null {
  if (businessType === 'company') return 3;
  if (businessType === 'licensed') return 2;
  if (businessType === 'exempt') return 5;
  return null;
}
