/**
 * The banks a seller can be paid into, and the codes PayMe accept for them.
 *
 * ── Why a list at all (owner, 2026-08-25) ──
 * *"אפשר לשים כל קוד בנק גם בלי שום בדיקה אם יש בנק כזה, צריך איכשהו רשימה של הבנקים בישראל ולעשות
 * כזה השלמה."* A two-digit box with no help is a field a seller guesses at, and a guessed bank code
 * is a transfer that bounces weeks later — the failure furthest from the moment that caused it.
 *
 * ── The source, and which one wins ──
 * `docs/payme-api-blueprint.md`'s Note 3: *"the list of all valid codes accepted in the
 * `seller_bank_code` attribute"*. Their Stoplight page (`docs/payme-docs/…list-of-banks`) renders a
 * SHORTER list — it is missing 11 (דיסקונט), 22 (סיטיבנק) and 90 — while agreeing with the
 * blueprint on every code the two share. A truncated page is a likelier explanation than PayMe
 * refusing Bank Discount, so the union is what is stored here, and the discrepancy is written down
 * rather than silently resolved.
 *
 * ── It is an AUTOCOMPLETE, never a gate ──
 * `payout-details.ts` deliberately does not enforce a business-number check digit, and its header
 * says why: a false rejection is unrecoverable from the seller's side — he cannot argue with a
 * form. The same reasoning applies here. If PayMe add a bank, or this list is wrong about one, a
 * seller must still be able to type his own code and get paid; what the list buys is that he
 * almost never has to.
 *
 * Pure data + two lookups. No I/O, importable anywhere, including a client bundle.
 */

export interface IsraeliBank {
  /** PayMe's `seller_bank_code`, as the digits a seller types. */
  code: string;
  name: string;
}

/** Ordered the way a seller thinks of them: the big four first, then the rest by code. */
export const ISRAELI_BANKS: readonly IsraeliBank[] = [
  { code: '12', name: 'בנק הפועלים' },
  { code: '10', name: 'בנק לאומי' },
  { code: '11', name: 'בנק דיסקונט' },
  { code: '20', name: 'בנק מזרחי טפחות' },
  { code: '31', name: 'הבינלאומי הראשון' },
  { code: '4', name: 'בנק יהב' },
  { code: '9', name: 'בנק הדואר' },
  { code: '13', name: 'בנק אגוד לישראל' },
  { code: '14', name: 'בנק אוצר החייל' },
  { code: '17', name: 'בנק מרכנתיל דיסקונט' },
  { code: '22', name: 'סיטיבנק' },
  { code: '23', name: 'HSBC' },
  { code: '26', name: 'UBANK' },
  { code: '34', name: 'בנק ערבי ישראלי' },
  { code: '39', name: 'בנק אוף אינדיה' },
  { code: '46', name: 'בנק מסד' },
  { code: '52', name: 'בנק פאגי' },
  { code: '54', name: 'בנק ירושלים' },
  { code: '68', name: 'דקסיה ישראל' },
  { code: '77', name: 'בנק לאומי למשכנתאות' },
  { code: '90', name: 'בנק דיסקונט למשכנתאות' },
  { code: '91', name: 'משכן בנק הפועלים למשכנתאות' },
  { code: '92', name: 'הבינלאומי למשכנתאות' },
];

/** Leading zeros are how a two-digit box gets typed — `04` and `4` are one bank. */
const normalize = (code: string): string => code.replace(/\D/g, '').replace(/^0+(?=\d)/, '');

/** The bank's name, or null for a code we do not know — which is a legitimate answer, not an
 *  error. The field shows the name when there is one and says nothing when there is not; it never
 *  refuses (see the header). */
export function bankName(code: string | undefined): string | null {
  if (!code) return null;
  const wanted = normalize(code);
  return ISRAELI_BANKS.find((b) => b.code === wanted)?.name ?? null;
}

/** Banks matching what has been typed so far — by name or by code, so "פועלים", "הפ" and "12" all
 *  find the same one. Empty query returns the whole list, because opening the field should show
 *  what is available rather than an empty box demanding a guess. */
export function searchBanks(query: string): readonly IsraeliBank[] {
  const q = query.trim();
  if (!q) return ISRAELI_BANKS;
  const digits = normalize(q);
  return ISRAELI_BANKS.filter((b) => b.name.includes(q) || (!!digits && b.code.startsWith(digits)));
}
