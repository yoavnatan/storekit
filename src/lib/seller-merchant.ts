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
 * ── Why the secret is fetched by exactly one function ──
 * `callback_secret` proves a payment callback really came from PayMe. It is deliberately NOT part
 * of `MerchantAccount`, the shape every caller reads: a secret on an object that dashboards render
 * is one `JSON.stringify` away from a page. `merchantCallbackSecret()` is the only way to it, and
 * it exists so that the one place that needs it is grep-able.
 */
import { firstRow, isUuid, query, rows } from './db.js';
import { getSellerById, type Seller } from './seller-auth.js';
import {
  isCompleteMerchantKyc, missingMerchantKyc, normalizeMerchantKyc, paymeDate, paymeIncorporation,
  type MerchantKyc, type MerchantKycField,
} from './merchant-kyc.js';
import { commissionPercentForTier } from './pricing.js';
import { createSeller, paymeCredentials, PaymeError, type PaymeCredentials } from './payment-payme.js';
import { logError } from './error-log.js';

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
  createdAt: string;
}

interface AccountRow {
  seller_id: string;
  provider: string;
  provider_ref: string;
  public_key: string;
  signup_link: string;
  approved: boolean;
  created_at: Date | string | null;
}

/** Every read names its columns, and `callback_secret` is not among them — a `SELECT *` here is
 *  how the secret would reach a caller that never asked for it. */
const ACCOUNT_COLUMNS = 'seller_id, provider, provider_ref, public_key, signup_link, approved, created_at';

function toAccount(row: AccountRow): MerchantAccount {
  return {
    sellerId: row.seller_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    publicKey: row.public_key,
    signupLink: row.signup_link,
    approved: row.approved,
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

/** The KYC we hold for this seller, normalised. Partial is the normal state, not an error. */
export async function merchantKycFor(sellerId: string): Promise<Partial<MerchantKyc>> {
  if (!isUuid(sellerId)) return {};
  const row = await firstRow<{ merchant_kyc: unknown }>('SELECT merchant_kyc FROM sellers WHERE id = $1', [sellerId]);
  return normalizeMerchantKyc(row?.merchant_kyc);
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
export async function ensureMerchantAccount(
  sellerId: string,
  context: { storeName: string; storeUrl: string; storeDescription: string },
  creds: PaymeCredentials | null = paymeCredentials(),
): Promise<EnsureMerchantResult> {
  const existing = await merchantAccountFor(sellerId);
  if (existing) return { status: 'ready', account: existing };
  if (!creds) return { status: 'not-configured' };

  const seller = await getSellerById(sellerId);
  if (!seller) return { status: 'failed', error: 'seller not found' };

  const kyc = await merchantKycFor(sellerId);
  const missing = missingMerchantKyc(kyc);
  // The bank block is PayMe's too, and it lives on the seller record rather than in `merchant_kyc`
  // because payouts needed it first. Reported in the same list so a seller is told everything that
  // is outstanding at once rather than one screen at a time.
  const missingBank = missingBankFields(seller);
  // `isCompleteMerchantKyc` is a type guard as well as a check — it is what lets the call below
  // read `kyc.ownerSocialId` without a `!` on every field, so the "is it complete" question is
  // asked once by the compiler rather than ten times by hand.
  if (missingBank.length || !isCompleteMerchantKyc(kyc)) {
    return { status: 'needs-details', missing: [...missing, ...missingBank] as MerchantKycField[] };
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
      incorporation: paymeIncorporation(seller.businessType),
      ...(seller.businessId ? { businessId: seller.businessId } : {}),
      merchantName: seller.bankAccountHolder || context.storeName,
      registrationDate: paymeDate(kyc.businessRegisteredOn),
      addressCity: kyc.businessCity,
      addressStreet: kyc.businessStreet,
      addressStreetNumber: kyc.businessStreetNumber,
      // His tier's commission becomes the merchant's DEFAULT distribution fee. Every sale also
      // passes it explicitly (`payment-split.ts`), so a tier change takes effect on the next sale
      // rather than needing a round trip to PayMe — this only decides what happens if one ever
      // does not.
      marketFeePercent: commissionPercentForTier(seller.tier),
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

export async function merchantBlockFor(sellerId: string, creds: PaymeCredentials | null = paymeCredentials()): Promise<MerchantBlock | null> {
  if (!creds) return null;
  const account = await merchantAccountFor(sellerId);
  if (!account) return 'no-account';
  if (!account.approved) return 'not-approved';
  return null;
}

/** Record PayMe's verdict on a business. Written by the seller callback, which is the only thing
 *  that knows — approval happens at their end, on their timetable, with nothing to poll. */
export async function setMerchantApproval(providerRef: string, approved: boolean): Promise<void> {
  await query(
    'UPDATE seller_merchant_accounts SET approved = $2, updated_at = now() WHERE provider_ref = $1',
    [providerRef, approved],
  );
}
