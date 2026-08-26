/**
 * The seller's own clearing account — the row that decides whether his stores may sell.
 *
 * Under the split model the platform never holds a shekel of a seller's money: PayMe capture each
 * store's share straight into that seller's own merchant account. So a seller without such an
 * account has nowhere for a buyer's money to go, and the honest consequence is that his stores
 * cannot take an order. That is what this module owns — the account, and the gate.
 *
 * ── One account per SELLER, shared by all his stores ──
 * PayMe bill ₪65 a month per merchant account against a ₪99 subscription per seller ACCOUNT
 * (`lib/pricing.ts` — the subscription is per registered business, never per store). One account
 * per store would sell every multi-store seller at a loss. The migration header carries the
 * arithmetic; `ensureMerchantAccount` is where it is enforced, by returning the existing row
 * rather than opening a second.
 *
 * ── ⚠️ THREE COLUMNS HERE CANNOT BE RECOVERED IF THEY ARE LOST ──
 * `public_key`, `callback_secret` and `signup_link` come back exactly once, from `create-seller`,
 * and from nowhere else — measured 2026-08-23: neither `get-sellers` nor `update-seller` returns
 * any of them. Lose the row and this seller can never take a card, none of his callbacks can ever
 * be verified, and he can never finish his own KYC. The only repair is opening a SECOND merchant
 * account, which costs ₪65 a month forever and cannot be deleted, because PayMe's API has no
 * delete. `tests/unrecoverable-columns.test.ts` holds the class, what protects it, and the list of
 * values that were checked and found recoverable — read it before renaming any of these.
 *
 * This warning lives here and not in the migration because that file is applied history: its
 * checksum is verified on every run, so a comment added afterwards fails the whole tree.
 *
 * ── Why the secret is fetched by exactly one function ──
 * `callback_secret` proves a payment callback really came from PayMe. It is deliberately NOT part
 * of `MerchantAccount`, the shape every caller reads: a secret on an object that dashboards render
 * is one `JSON.stringify` away from a page. `merchantCallbackSecret()` is the only way to it, and
 * it exists so that the one place that needs it is grep-able.
 */
import { firstRow, isUuid, query, rows } from './db.js';
import { getSellerById, type Seller } from './seller-auth.js';
import {
  businessIdMismatch, isCompleteMerchantKyc, missingMerchantKyc, normalizeMerchantKyc, paymeDate,
  paymeIncorporation,
  type MerchantKyc, type MerchantKycField,
} from './merchant-kyc.js';
import { DEFAULT_TIER, commissionPercentForTier, feeWithVatPercent } from './pricing.js';
import { paymeCategoryForStore } from './merchant-category.js';
import { getStoresBySellerId } from './stores.js';
import { activePaymeCredentials, createSeller, isSandbox, PaymeError, type PaymeCredentials } from './payment-payme.js';
import { logError } from './error-log.js';
import { createNotification } from './notifications.js';

/** What a caller may see. **No secret** — see the module header. */
export interface MerchantAccount {
  sellerId: string;
  provider: string;
  /** PayMe's `seller_payme_id`. The whole of the join between his account here and there. */
  providerRef: string;
  /** Hosted Fields public key. Meant to reach the browser. */
  publicKey: string;
  /** Where the seller finishes his own KYC at PayMe. */
  signupLink: string;
  /** ⚠️ False until PayMe approve the business, and they may refuse one at their sole discretion
   *  (agreement §11). "The account exists" is not "the account may sell". */
  approved: boolean;
  /** ⚠️ **False means the processor REFUSED or suspended this business**, which is a different
   *  state from `approved: false` — that one only means the review has not finished. PayMe answer
   *  the two as separate flags and we store them the same way, so a refusal is visible as itself
   *  rather than as a wait that never ends (owner, סשן א׳ §20, 2026-08-26). */
  active: boolean;
  createdAt: string;
}

interface AccountRow {
  seller_id: string;
  provider: string;
  provider_ref: string;
  public_key: string;
  signup_link: string;
  approved: boolean;
  active: boolean;
  created_at: Date | string | null;
}

/** Every read names its columns, and `callback_secret` is not among them — a `SELECT *` here is
 *  how the secret would reach a caller that never asked for it. */
const ACCOUNT_COLUMNS = 'seller_id, provider, provider_ref, public_key, signup_link, approved, active, created_at';

function toAccount(row: AccountRow): MerchantAccount {
  return {
    sellerId: row.seller_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    publicKey: row.public_key,
    signupLink: row.signup_link,
    approved: row.approved,
    // Defensive against a row read by code deployed before the column existed — `?? true` is the
    // same answer the column's own DEFAULT gives, i.e. "live and pending".
    active: row.active ?? true,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
}

export async function merchantAccountFor(sellerId: string): Promise<MerchantAccount | null> {
  if (!isUuid(sellerId)) return null;
  const row = await firstRow<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM seller_merchant_accounts WHERE seller_id = $1`,
    [sellerId],
  );
  return row ? toAccount(row) : null;
}

/**
 * The per-seller callback signing key, and the ONLY way to it.
 *
 * Returns `null` rather than `''` when there is none, so a caller cannot accidentally verify
 * against the empty string — which would be a digest anybody on the internet can compute.
 * `verifyCallbackSignature` refuses an empty secret for the same reason; this is the other half.
 */
export async function merchantCallbackSecret(sellerId: string): Promise<string | null> {
  if (!isUuid(sellerId)) return null;
  const row = await firstRow<{ callback_secret: string }>(
    'SELECT callback_secret FROM seller_merchant_accounts WHERE seller_id = $1',
    [sellerId],
  );
  return row?.callback_secret || null;
}

/**
 * Every account in one query, keyed by seller id.
 *
 * For the checkout, which needs one per store in the cart and must not turn a five-store cart into
 * five round trips — `project_sequential_await_latency`: each await is a real round trip now, and a
 * loop of them is the shape that quietly costs a buyer a second at the worst possible moment.
 * Sellers with no account are simply absent from the map, which is exactly what the caller has to
 * branch on anyway.
 */
export async function merchantAccountsFor(sellerIds: readonly string[]): Promise<Map<string, MerchantAccount>> {
  const ids = [...new Set(sellerIds.filter(isUuid))];
  if (!ids.length) return new Map();
  const found = await rows<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM seller_merchant_accounts WHERE seller_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(found.map((row) => [row.seller_id, toAccount(row)]));
}

/** Look an account up by PayMe's id — how a callback, which knows only their identifiers, finds
 *  the seller it is about. */
export async function merchantAccountByProviderRef(providerRef: string): Promise<MerchantAccount | null> {
  if (!providerRef) return null;
  const row = await firstRow<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM seller_merchant_accounts WHERE provider_ref = $1`,
    [providerRef],
  );
  return row ? toAccount(row) : null;
}

/** The KYC we hold for this seller, normalised. Partial is the normal state, not an error.
 *
 *  **Raw — it does not derive the merchant category.** `resolveMerchantKyc` does, and the two are
 *  separate because a form has to know which fields are really STORED (so a save does not write
 *  back a derived value as if the seller had typed it) while the account-opening path needs the
 *  complete picture. */
export async function merchantKycFor(sellerId: string): Promise<Partial<MerchantKyc>> {
  if (!isUuid(sellerId)) return {};
  const row = await firstRow<{ merchant_kyc: unknown }>('SELECT merchant_kyc FROM sellers WHERE id = $1', [sellerId]);
  return normalizeMerchantKyc(row?.merchant_kyc);
}

/**
 * The KYC as PayMe will see it — stored fields, plus the merchant category derived from the
 * seller's own shop when he has not given one.
 *
 * **This is what removes a field from the form** (owner, 2026-08-23): PayMe's category list runs to
 * hundreds of trade-and-size rows and a seller cannot answer it, so `merchant-category.ts` answers
 * it from the categories he already picked. A stored value always wins — the one shop whose trade
 * we cannot name (`כלבו`, no cross-trade row exists) is asked, once, and his answer must not be
 * overwritten by a derivation that would return null anyway.
 */
/** Not exported: the account-opening path below is its only caller, and a second entry point would
 *  be a second answer to "what does PayMe actually have on this seller". */
async function resolveMerchantKyc(sellerId: string, storeCategories?: readonly string[]): Promise<Partial<MerchantKyc>> {
  const kyc = await merchantKycFor(sellerId);
  if (kyc.businessCategory) return kyc;
  const categories = storeCategories ?? (await getStoresBySellerId(sellerId)).flatMap((s) => s.categories ?? []);
  const derived = paymeCategoryForStore(categories);
  return derived ? { ...kyc, businessCategory: derived } : kyc;
}

/** Store what a seller filled in, merged over what he filled in before — a form that asks for
 *  three of ten fields must not erase the other seven. */
export async function saveMerchantKyc(sellerId: string, input: unknown): Promise<Partial<MerchantKyc>> {
  if (!isUuid(sellerId)) return {};
  const merged = { ...(await merchantKycFor(sellerId)), ...normalizeMerchantKyc(input) };
  await query('UPDATE sellers SET merchant_kyc = $2 WHERE id = $1', [sellerId, JSON.stringify(merged)]);
  return merged;
}

export type EnsureMerchantResult =
  /** There already was one, or one was just opened. */
  | { status: 'ready'; account: MerchantAccount }
  /** PayMe cannot be called: we do not hold everything they require. Not a failure — the normal
   *  state of a seller who has opened a shop and not yet asked to be paid. */
  | { status: 'needs-details'; missing: MerchantKycField[] }
  /** PayMe are not configured on this deployment. Dev, and the pre-gateway window GO_LIVE §7 plans. */
  | { status: 'not-configured' }
  /** PayMe refused. The seller cannot fix this himself and neither can a retry. */
  | { status: 'failed'; error: string };

/**
 * Make sure this seller has a clearing account, opening one if we can.
 *
 * Called when a store is created, and safe to call again at any time — the first branch is "he
 * already has one", which is what makes a seller's second store cost nothing.
 *
 * **Never throws.** It runs inside store creation, and a shop that fails to open because PayMe were
 * slow is a worse outcome than a shop that opens and cannot sell yet: the second is recoverable by
 * the seller, the first is a stranger meeting an error page while trying to become a customer.
 * A refusal is logged, not raised.
 */
/**
 * **Everything PayMe require, in one place** — and the reason this function exists is that there
 * were two places and they disagreed.
 *
 * ── The bug (owner, 2026-08-25) ──
 * *"כרגע אני במצב שבאתר שמתי פרטי עסק ופרטי כרטיס, ולמרות זאת מופיע לי ... הפרטים נשמרו. הם יישלחו
 * לחברת הסליקה עם שמירת הכרטיס."* His card was saved, his step 1 was ticked green — and no account
 * had been opened, because his bank block and business type were empty. `merchant_kyc` was
 * complete; PayMe's requirements were not.
 *
 * The screen asked `missingMerchantKyc` (ten fields in one JSONB column) while
 * `ensureMerchantAccount` asked that **plus** the bank block, plus a mappable incorporation type,
 * plus PayMe's osek-murshe rule that the business number equal the owner's ת.ז. Those extra three
 * live on the `sellers` row because payouts needed them first, and nothing on the go-live screen
 * had ever been taught to count them. So the seller was shown a finished step for an account that
 * could not be opened, and the refusal — a RETURN value, not a throw — was discarded by the caller.
 *
 * One function now answers it, and the screen, the publication hold and the opener all call it.
 * Empty means the account can be opened.
 */
export async function missingForClearingAccount(
  sellerId: string,
  storeCategories?: readonly string[],
): Promise<string[]> {
  const [seller, kyc] = await Promise.all([
    getSellerById(sellerId),
    resolveMerchantKyc(sellerId, storeCategories),
  ]);
  if (!seller) return ['seller'];
  const incorporation = paymeIncorporation(seller.businessType);
  return [
    ...missingMerchantKyc(kyc),
    ...missingBankFields(seller),
    ...(incorporation === null ? ['businessType'] : []),
    ...(businessIdMismatch(seller.businessType, seller.businessId, kyc.ownerSocialId) ? ['businessId'] : []),
  ];
}

export async function ensureMerchantAccount(
  sellerId: string,
  context: { storeName: string; storeUrl: string; storeDescription: string; storeCategories?: readonly string[] },
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<EnsureMerchantResult> {
  const existing = await merchantAccountFor(sellerId);
  if (existing) return { status: 'ready', account: existing };
  if (!creds) return { status: 'not-configured' };

  const seller = await getSellerById(sellerId);
  if (!seller) return { status: 'failed', error: 'seller not found' };

  // The RESOLVED picture, so a seller whose trade we can read off his own shop never met the
  // category field at all.
  const kyc = await resolveMerchantKyc(sellerId, context.storeCategories);
  // The bank block is PayMe's too, and it lives on the seller record rather than in `merchant_kyc`
  // because payouts needed it first. Asked through the shared definition so this function and the
  // screen that tells a seller he is finished cannot answer differently (`missingForClearingAccount`).
  const missing = await missingForClearingAccount(sellerId, context.storeCategories);
  // `isCompleteMerchantKyc` is a type guard as well as a check — it is what lets the call below
  // read `kyc.ownerSocialId` without a `!` on every field, so the "is it complete" question is
  // asked once by the compiler rather than ten times by hand.
  //
  // The incorporation type is checked here for the same reason and with the same consequence: it
  // returns null for a business type we cannot map, and the old code turned that into `1` — a
  // PRIVATE INDIVIDUAL in PayMe's real list, the one category this platform excludes
  // (`merchant-kyc.ts#paymeIncorporation`). Declaring a business as something it is not is not a
  // fallback; it is a KYC misstatement, so it becomes a missing field like any other.
  const incorporation = paymeIncorporation(seller.businessType);
  // PayMe refuse an osek murshe whose business number is not his own ID number (114, measured).
  // Caught here rather than at their end, where the seller never sees the message and his store
  // simply never becomes able to sell.
  // `isCompleteMerchantKyc` is still asked, and only for its TYPE GUARD: it is what lets the call
  // below read `kyc.ownerSocialId` without a `!` on every field. `missing` is the authority on
  // whether to proceed.
  if (missing.length || incorporation === null || !isCompleteMerchantKyc(kyc)) {
    return { status: 'needs-details', missing: missing as MerchantKycField[] };
  }

  try {
    const created = await createSeller({
      ...splitName(seller.name),
      socialId: kyc.ownerSocialId,
      birthdate: paymeDate(kyc.ownerBirthdate),
      socialIdIssued: paymeDate(kyc.ownerSocialIdIssued),
      gender: kyc.ownerGender,
      email: seller.email,
      phone: kyc.ownerPhone,
      bankCode: seller.bankCode!,
      bankBranch: seller.bankBranch!,
      bankAccount: seller.bankAccount!,
      description: context.storeDescription || context.storeName,
      siteUrl: context.storeUrl,
      businessType: kyc.businessCategory,
      incorporation,
      ...(seller.businessId ? { businessId: seller.businessId } : {}),
      merchantName: seller.bankAccountHolder || context.storeName,
      registrationDate: paymeDate(kyc.businessRegisteredOn),
      addressCity: kyc.businessCity,
      addressStreet: kyc.businessStreet,
      addressStreetNumber: kyc.businessStreetNumber,
      // The merchant's DEFAULT distribution fee, and it is deliberately the DEFAULT PLAN's rate
      // rather than any particular shop's. One merchant account serves all of this seller's shops
      // (it is per legal entity), and since 2026-08-24 those shops can be on different plans — so
      // there is no single rate here that would be true. It costs nothing to be conservative:
      // every sale passes its own store's percent explicitly (`payment-split.ts`), and this only
      // decides what happens if one ever does not.
      // Through `feeWithVatPercent` for the same reason every sale's own rate goes through it: a
      // `market_fee` is what is DEDUCTED, and our fee is quoted before VAT. A bare percent here
      // would make the fallback quietly cheaper than every real sale (2026-08-26).
      marketFeePercent: feeWithVatPercent(commissionPercentForTier(DEFAULT_TIER)),
    }, creds);

    const row = await firstRow<AccountRow>(
      `INSERT INTO seller_merchant_accounts (seller_id, provider, provider_ref, callback_secret, public_key, signup_link, approved)
       VALUES ($1, 'payme', $2, $3, $4, $5, $6)
       ON CONFLICT (seller_id) DO NOTHING
       RETURNING ${ACCOUNT_COLUMNS}`,
      [sellerId, created.sellerPaymeId, created.sellerPaymeSecret, created.sellerPublicKey, created.signupLink, created.approved],
    );
    // `DO NOTHING` returning no row means a concurrent request opened one first. The account we
    // just created at PayMe is then an orphan — there is no delete in their API, so it is reported
    // rather than retried, and the stored row wins.
    if (!row) {
      await logError({
        source: 'server',
        route: 'payme:create-seller',
        message: `a second PayMe merchant was created for seller ${sellerId} (${created.sellerPaymeId}) and discarded — one already existed`,
        actorRole: 'seller',
        actorId: sellerId,
        resolutionHint: `נפתח חשבון סליקה כפול אצל PayMe (${created.sellerPaymeId}) והמערכת ממשיכה עם הקיים. אין מחיקה ב-API שלהם — צריך לבקש מהם לסגור אותו, אחרת ייגבו ₪65 לחודש על חשבון שלא בשימוש.`,
      }).catch(() => { /* the stored account is correct either way */ });
      const stored = await merchantAccountFor(sellerId);
      return stored ? { status: 'ready', account: stored } : { status: 'failed', error: 'account row vanished' };
    }
    return { status: 'ready', account: toAccount(row) };
  } catch (err) {
    const message = err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err);
    await logError({
      source: 'server',
      route: 'payme:create-seller',
      message: `could not open a PayMe merchant account for seller ${sellerId}: ${message}`,
      actorRole: 'seller',
      actorId: sellerId,
      resolutionHint: 'החנות נפתחה אבל אי אפשר למכור בה עד שיש חשבון סליקה. השגיאה היא של PayMe — צריך לקרוא אותה, לתקן את הפרטים או לפנות אליהם. המוכר לא יכול לפתור את זה לבד.',
    }).catch(() => { /* nothing left to try */ });
    return { status: 'failed', error: message };
  }
}

/** PayMe require the bank block, and it lives on the seller record (migration 0023) rather than in
 *  `merchant_kyc` because payouts asked for it first. All four or none — `payout-details.ts` says
 *  why, and the reason applies twice over here: an account opened against a partial bank record is
 *  an account whose money cannot be settled. */
function missingBankFields(seller: Seller): string[] {
  const out: string[] = [];
  if (!seller.bankCode) out.push('bankCode');
  if (!seller.bankBranch) out.push('bankBranch');
  if (!seller.bankAccount) out.push('bankAccount');
  return out;
}

/**
 * A single `name` into the first/last pair PayMe demand.
 *
 * They are separate fields at their end and one field at ours, and there is no correct general
 * answer — "דוד בן גוריון" splits three ways. First token first, the rest last, which is right for
 * the overwhelmingly common two-token case and never loses a character. A seller whose legal name
 * needs different handling fixes it on the signup link PayMe hand back, which is the whole reason
 * that link is stored.
 */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: parts[0] ?? '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

/**
 * May this seller take money right now — and if not, why.
 *
 * A reason rather than a boolean, for the same reason `site-mode.ts#checkoutClosedReason` is one:
 * the checkout route, the storefront's buy button and the seller's own dashboard all have to say
 * something true to a person, and three surfaces inventing a sentence from a `false` is the drift
 * this codebase's copy modules exist to prevent.
 *
 * **`null` when PayMe are not configured, and that is not a hole.** With no gateway wired there is
 * no clearing account for anyone, so gating on one would close every store in development and in
 * the pre-gateway window GO_LIVE §7 plans. What guards THAT window is `site-mode.ts`, which refuses
 * to sell at all on a production server whose provider cannot take money — a stricter gate, derived
 * from the same fact.
 */
export type MerchantBlock = 'no-account' | 'not-approved';

export async function merchantBlockFor(sellerId: string, creds: PaymeCredentials | null = activePaymeCredentials()): Promise<MerchantBlock | null> {
  if (!creds) return null;
  const account = await merchantAccountFor(sellerId);
  if (!account) return 'no-account';
  // **Approval is enforced in PRODUCTION only, and that is a measurement rather than a leniency.**
  // PayMe's sandbox does not model it: both of our test merchants sit `seller_approved: false` and
  // a `generate-sale` against them completed anyway (`docs/payme-sandbox-notes.md` §2, re-confirmed
  // 2026-08-23). So gating the sandbox on approval blocks the one thing the sandbox is for —
  // proving the whole flow works BEFORE launch — while blocking nothing real, since the sandbox
  // moves no money.
  //
  // Live, it stays a hard gate: PayMe examine every business and may refuse one at their sole
  // discretion (agreement §11), and a `Restricted` merchant's charge is refused in front of a
  // buyer mid-checkout. Refusing earlier, with a sentence the seller can act on, is the whole point.
  if (!account.approved && !isSandbox(creds)) return 'not-approved';
  return null;
}

/**
 * What the seller's own Payments tab has to say about his ability to sell.
 *
 * The dashboard's version of `merchantBlockFor`, and it is a separate function because it answers a
 * different question: that one decides whether a checkout proceeds, this one decides what a person
 * is told. **`null` means no clearing provider is configured**, so nothing is blocked and a line
 * about being blocked would describe a rule that is not in force.
 *
 * The seller must not learn from a shopper that his shop cannot take an order.
 */
/**
 * What the seller's own screens say about his ability to sell.
 *
 * Exported as a type because three components render it and each used to declare its own copy of
 * the union — which is how `'rejected'` was added on 2026-08-26 and two of the three kept type-
 * checking against a state they could never receive.
 */
export interface ClearingStatus {
  state: 'ready' | 'missing-details' | 'not-opened' | 'awaiting-approval' | 'rejected';
  signupLink?: string;
}

export async function clearingStatusFor(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<ClearingStatus | null> {
  if (!creds) return null;
  const account = await merchantAccountFor(sellerId);
  if (account) {
    // The link is rendered as an `href` on the seller's dashboard, so it is shape-checked before it
    // gets there. It comes from PayMe rather than from a request, which is why this is defence in
    // depth rather than the primary guard — but `https:` only is the same rule `lib/image-url.ts`
    // and `lib/safe-redirect.ts` apply for the same reason: a `javascript:` string in an href is
    // script execution, and "the value came from our provider" is an assumption, not a check.
    const link = safeMerchantLink(account.signupLink);
    // The SAME rule as `merchantBlockFor`, and it has to be: this sentence is what a seller reads
    // to find out whether his shop can sell, so a screen saying "waiting for approval" while the
    // checkout happily takes orders would be the worse half of a disagreement nobody could see.
    // **Refused first**, because it is the answer that stops being a wait. A deactivated merchant
    // read as `awaiting-approval` is a seller told to keep waiting for a decision that has already
    // been made against him (owner, §20). The link travels with it: their own page is where a
    // refused business is discussed, and it is the only door we have.
    if (!account.active) return { state: 'rejected', ...(link ? { signupLink: link } : {}) };
    return (account.approved || isSandbox(creds))
      ? { state: 'ready' }
      : { state: 'awaiting-approval', ...(link ? { signupLink: link } : {}) };
  }
  /**
   * ── No account, which stopped having one cause on 2026-08-25 ──
   *
   * It used to: PayMe were asked the moment the details were saved, so no account meant no details.
   * Since the account is opened at card-save instead (`subscription-arm.ts` — it costs ₪65 a month
   * for as long as it exists), a seller who has typed every field PayMe require also has no
   * account, and calling that "missing details" told him to go and fill in a form he had finished.
   * The owner read exactly that and could not tell which of the two it meant (*"לא מבין גם על מה
   * הוא מצביע?"*).
   *
   * Two states now, because they are two situations with two different next actions: something is
   * missing and he must type it, or nothing is missing and the account opens when he commits.
   */
  return { state: (await missingForClearingAccount(sellerId)).length ? 'missing-details' : 'not-opened' };
}

/** An `https:` absolute URL, or null. Parsed rather than pattern-matched, so the answer is the
 *  URL parser's own reading of the string and not ours — `javascript:` with whitespace or control
 *  characters in it is exactly the family a naive `startsWith('https')` waves through. */
export function safeMerchantLink(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Record PayMe's verdict on a business.
 *
 * Approval happens at their end, on their timetable, and takes up to seven business days
 * (agreement §11) — so the seller has been waiting on a decision he cannot influence, and **this is
 * the moment it lands**. It is told to him here rather than left to the publication that may follow
 * it (owner, 2026-08-24: *"האם הוא מקבל הודעה או התראה על כך שחברת הסליקה אישרה את העסק?"*): the
 * two are different events and only one of them is guaranteed. A seller who has not started a
 * subscription gets approved and his shop stays private, and without this nothing would ever say
 * that the week-long half of the wait was over.
 *
 * The write is conditional on the value CHANGING, so a callback PayMe deliver twice — and the sweep
 * that runs beside it — cannot announce the same approval again. The affected-row count is the
 * answer, the way it is for `decrementStock`: a read-then-write here would announce twice under
 * exactly the concurrency it is meant to survive.
 */
export async function setMerchantApproval(providerRef: string, approved: boolean, active = true): Promise<void> {
  const changed = await rows<{ seller_id: string }>(
    `UPDATE seller_merchant_accounts SET approved = $2, active = $3, updated_at = now()
      WHERE provider_ref = $1 AND (approved IS DISTINCT FROM $2 OR active IS DISTINCT FROM $3)
      RETURNING seller_id`,
    [providerRef, approved, active],
  );
  const sellerId = changed[0]?.seller_id;
  if (!sellerId) return;

  /**
   * ── A REFUSAL is an event, and until 2026-08-26 it was silence (owner, §20) ──
   *
   * *"מה קורה אם יש סירוב מחברת הסליקה לעסק? מה היוזר רואה? הטוסטים הקטנים האלו לא מספיקים. זה
   * נרשם לי גם באדמין איפשהו?"* Nothing did. A refusal and an unfinished review were one boolean,
   * so the seller's screen went on saying "up to seven business days" for ever and nothing reached
   * us at all.
   *
   * Both audiences, because they are different people with different next moves. **The seller**
   * gets a notification, and his screens now say he was refused rather than that he is waiting —
   * that is `clearingStatusFor`'s `'rejected'`. **We** get an error-log row, which is the admin's
   * own surface for things a person must look at (`lib/error-log.ts`), with the resolution hint
   * spelled out: this is not a bug to fix, it is a seller to talk to. Agreement §11 lets PayMe
   * refuse at their sole discretion and gives no reason on the wire, so the hint says where the
   * reason has to come from.
   */
  if (!active) {
    await logError({
      source: 'server',
      route: 'payme:seller-status',
      message: `PayMe deactivated or refused merchant ${providerRef} (seller ${sellerId})`,
      actorRole: 'seller',
      actorId: sellerId,
      resolutionHint: 'חברת הסליקה סירבה לבית העסק או השביתה אותו. החנות לא תוכל למכור. אין סיבה ב-API — צריך לפנות אליהם ואז לחזור למוכר.',
    }).catch(() => { /* the state is recorded either way */ });
    await createNotification({
      userId: sellerId,
      role: 'seller',
      type: 'merchant_rejected',
      title: 'חברת הסליקה לא אישרה את העסק',
      body: 'החנות לא תוכל למכור עד שזה ייפתר. הפרטים והדרך להמשך נמצאים בלשונית תשלומים.',
    }).catch(() => { /* the state is recorded either way */ });
    return;
  }

  if (!approved) return;
  await createNotification({
    userId: sellerId,
    role: 'seller',
    type: 'merchant_approved',
    title: 'חברת הסליקה אישרה את העסק',
    body: 'מה שנשאר כדי שהחנות תעלה לאוויר מופיע בסקירה הכללית.',
  }).catch(() => { /* the approval is recorded either way */ });
}
