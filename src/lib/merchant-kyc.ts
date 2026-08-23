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
  /** Merchant category code. See `MERCHANT_CATEGORY_FALLBACK`. */
  businessCategory: string;
  businessCity: string;
  businessStreet: string;
  businessStreetNumber: string;
}

/**
 * The MCC used when a seller has not chosen one.
 *
 * `5999 — Miscellaneous and Specialty Retail Stores` is the ISO 18245 catch-all for exactly this
 * platform's population: a general online shop selling goods. It is a real code and not a
 * placeholder, which matters because an invented one would be rejected at underwriting and the
 * seller would be the one waiting.
 *
 * ⚠️ It is nonetheless a DEFAULT and not a claim about any particular seller. PayMe price and
 * underwrite by category, and a store selling something they treat differently is exactly the kind
 * of mismatch that surfaces as a restricted account rather than as an error. Whether sellers pick
 * their own category — and from what list — is a product decision that has not been made
 * (GO_LIVE §3.1.2).
 */
export const MERCHANT_CATEGORY_FALLBACK = '5999';

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

  // `=== 0` and `=== 1` explicitly. A `Number()` would turn '' into 0, i.e. would silently record
  // every seller who skipped the question as male.
  const gender = typeof raw.ownerGender === 'string' ? Number(raw.ownerGender) : raw.ownerGender;
  if (gender === 0 || gender === 1) out.ownerGender = gender;

  // Israeli mobile: 10 digits starting 05, or 12 with the country code. Normalised to the local
  // form PayMe's examples use (`0540123456`) so one seller's `+972-54-…` and another's `054 …`
  // reach them identically.
  const phone = digits(raw.ownerPhone, 15);
  const local = phone.startsWith('972') ? `0${phone.slice(3)}` : phone;
  if (/^05\d{8}$/.test(local)) out.ownerPhone = local;

  const registered = isoDate(raw.businessRegisteredOn);
  if (registered) out.businessRegisteredOn = registered;

  // Falls back rather than staying absent: a seller cannot be blocked from selling over a code he
  // has never been shown a list of. See `MERCHANT_CATEGORY_FALLBACK`.
  out.businessCategory = digits(raw.businessCategory, 4) || MERCHANT_CATEGORY_FALLBACK;

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
 * PayMe's `seller_inc` enum, from the business type we already hold.
 *
 * Their list is wider than ours (corporation, partnership, non-profit, LLC), and ours is the three
 * that decide how a seller invoices a buyer (`payout-details.ts`). Mapped rather than merged: an
 * `exempt` seller is PayMe's `5 — Exempt Company`, a `licensed` one is a sole trader (`1`), and a
 * `company` is `2 — Licensed Company`. **`0` is a private individual, which this platform never
 * has** — sellers are registered businesses only (AI_INSTRUCTIONS → Business model) — so it is not
 * a fallback here: an unknown value maps to sole trader, the commonest case, rather than to a
 * category we have contractually excluded.
 */
export function paymeIncorporation(businessType: string | undefined): number {
  if (businessType === 'company') return 2;
  if (businessType === 'exempt') return 5;
  return 1;
}
