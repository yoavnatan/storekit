/**
 * The seller's own clearing credentials — reading them, saving them, and deciding whether his shop
 * can take money yet.
 *
 * The SaaS shape: he keeps his account at Hyp / PayPlus / whoever, pastes what that provider gives
 * him, and every buyer's payment goes straight into it. We never hold his money and never hold an
 * account at his provider. `docs/pivot-saas.md` for why, `clearing-providers.ts` for who, and
 * `secret-box.ts` for how the secrets are stored.
 *
 * ── The one rule this module exists to enforce ──
 * **A decrypted credential never leaves a function that needs it.** It goes to the provider adapter
 * and nowhere else — not into a page, not into a log line, not into an error message. `forDisplay`
 * below is the only thing a screen may render, and it returns hints, never values.
 */
import { firstRow, isUuid, query } from './db.js';
import { openSecret, sealSecret, secretHint } from './secret-box.js';
import {
  clearingProvider,
  missingCredentials,
  pickCredentials,
  type ClearingProvider,
} from './clearing-providers.js';

export interface SellerClearing {
  provider: ClearingProvider;
  /** Decrypted. Do not render, do not log. */
  credentials: Record<string, string>;
  /** Field names still empty. */
  missing: string[];
  verifiedAt: Date | null;
}

interface Row {
  provider: string;
  credentials: string;
  verified_at: Date | null;
}

/** The row, decrypted, or `null` when the seller has not chosen a provider — or when the stored
 *  blob cannot be decrypted, which is treated exactly like "not connected": the honest repair is
 *  for him to paste the credentials again, and a shop that pretends to be connected would fail on a
 *  buyer instead. */
export async function sellerClearingFor(sellerId: string): Promise<SellerClearing | null> {
  if (!isUuid(sellerId)) return null;
  const row = await firstRow<Row>(
    'SELECT provider, credentials, verified_at FROM seller_clearing_credentials WHERE seller_id = $1',
    [sellerId],
  );
  if (!row) return null;

  const provider = clearingProvider(row.provider);
  if (!provider) return null;

  const credentials = readCredentials(row.credentials);
  return {
    provider,
    credentials,
    missing: missingCredentials(provider, credentials),
    verifiedAt: row.verified_at ?? null,
  };
}

function readCredentials(sealed: string): Record<string, string> {
  const plain = openSecret(sealed);
  if (!plain) return {};
  try {
    const parsed: unknown = JSON.parse(plain);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Save what the seller pasted.
 *
 * **Merges rather than replaces**, and that is not a convenience: a secret is rendered back as
 * `••••1234` and never as its value, so an untouched field arrives empty from the browser. Replacing
 * would wipe the key he did not retype every time he corrected a terminal number. A field is only
 * changed when something non-empty arrives for it.
 *
 * Changing anything clears `verified_at` — credentials that have not been tested since they changed
 * have not been tested.
 */
export async function saveSellerClearing(
  sellerId: string,
  providerId: string,
  input: Record<string, unknown>,
): Promise<SellerClearing | null> {
  if (!isUuid(sellerId)) return null;
  const provider = clearingProvider(providerId);
  if (!provider || !provider.fieldsVerified) return null;

  const existing = await sellerClearingFor(sellerId);
  // Switching providers starts clean: the previous provider's fields mean nothing to the new one,
  // and carrying them over would leave a Hyp password sitting in a PayPlus row.
  const base = existing && existing.provider.id === provider.id ? existing.credentials : {};
  const merged = { ...base, ...pickCredentials(provider, input) };

  await query(
    `INSERT INTO seller_clearing_credentials (seller_id, provider, credentials, verified_at)
       VALUES ($1, $2, $3, NULL)
     ON CONFLICT (seller_id) DO UPDATE
       SET provider = EXCLUDED.provider,
           credentials = EXCLUDED.credentials,
           verified_at = NULL,
           updated_at = now()`,
    [sellerId, provider.id, sealSecret(JSON.stringify(merged))],
  );

  return sellerClearingFor(sellerId);
}

/**
 * Disconnect: forget the provider and everything pasted for it.
 *
 * A real DELETE and not a blanking, because a row holding a provider with empty credentials is a
 * state the screen would read as "chosen, half-finished" — which is exactly what a seller who has
 * just pressed "disconnect" did not do. `canTakePayments` answers false either way; the difference
 * is what he is shown.
 *
 * There is nothing here to undo. He pastes the values again from his provider's own screen, which
 * is where they live — we never held anything he cannot get back.
 */
export async function disconnectSellerClearing(sellerId: string): Promise<void> {
  if (!isUuid(sellerId)) return;
  await query('DELETE FROM seller_clearing_credentials WHERE seller_id = $1', [sellerId]);
}

/** Record that these credentials were proved to work. Called by the connection check, never by a
 *  save — see the note on `saveSellerClearing`. */
export async function markClearingVerified(sellerId: string): Promise<void> {
  if (!isUuid(sellerId)) return;
  await query(
    'UPDATE seller_clearing_credentials SET verified_at = now(), updated_at = now() WHERE seller_id = $1',
    [sellerId],
  );
}

/**
 * May this seller's shops take money?
 *
 * Every field filled AND a successful connection check. The second half is deliberate: the whole
 * point of the check is that a typo is found by him rather than by a buyer, and a gate that accepts
 * "he filled everything in" would let exactly that typo through.
 */
export function canTakePayments(clearing: SellerClearing | null): boolean {
  return !!clearing && clearing.missing.length === 0 && clearing.verifiedAt !== null;
}

/** The only shape a screen may render: per field, whether it is set and a four-character hint for a
 *  secret. No value ever reaches the page. */
export function forDisplay(clearing: SellerClearing | null): Record<string, { set: boolean; hint: string }> {
  const out: Record<string, { set: boolean; hint: string }> = {};
  if (!clearing) return out;
  for (const field of clearing.provider.fields) {
    const value = clearing.credentials[field.name] ?? '';
    out[field.name] = {
      set: !!value,
      hint: field.secret ? secretHint(value) : value,
    };
  }
  return out;
}
