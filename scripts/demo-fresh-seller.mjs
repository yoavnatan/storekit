#!/usr/bin/env node
/**
 * Put a seller back to the state of one who just registered — **no business details, no payment
 * method, nothing published** — so the Payments tab can be looked at in its empty state again.
 *
 * ── Why this exists (owner, 2026-08-26) ──
 * *"איך אני יכול שוב לראות מנוי חדש בלי פרטי עסק ובלי אמצעי תשלום?"* — the Payments tab is the
 * session's work, and the only account he had it open on was one he had already filled in. Every
 * empty-state on that tab (the clearing form, the plan picker, "no card yet", the two go-live
 * holds) is then unreachable, and the way back was to register a whole new seller and rebuild a
 * shop under it. `demo:clearing --undo` does NOT do this: it un-approves the merchant and removes
 * its own subscription row, and deliberately leaves the KYC and the account alone.
 *
 *   npm run demo:fresh-seller                      # list every seller and what it holds — writes nothing
 *   npm run demo:fresh-seller -- seller@email      # blank that one
 *
 * ── What it clears, and where each thing lives ──
 *   · `sellers.merchant_kyc`                       — the PayMe business file (`merchant-kyc.ts`)
 *   · `sellers.bank_* / business_id / business_type` — payout details (`payout-details.ts`)
 *   · `seller_subscriptions`                       — the plan AND the stored card (`buyer_key`)
 *   · `seller_merchant_accounts`                   — the clearing account, ONLY when disposable (below)
 *   · `stores.published_at`, `stores.tier`         — both holds back on, no plan chosen
 *
 * ── The two refusals ──
 * **Sandbox only.** Every write here walks back a gate that exists for a reason; the same rows in
 * production would strip a paying seller of the subscription he is being charged for. Checked the
 * way `demo-clearing.mjs` checks it.
 *
 * **A merchant account with its public key stored is never deleted.** PayMe return that key exactly
 * once, from `create-seller` (docs/payme-sandbox-notes.md §9), their sandbox has no delete, and
 * `demo:clearing` needs the key to draw the buyer's card form at all. So a seller holding one is
 * refused outright rather than half-cleared — reach for a different account, or register a new one.
 * Nothing else here is unrecoverable: it is all re-enterable through the UI in a minute, which is
 * the point of looking at those forms in the first place.
 */
import fs from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const BASE = env.PAYME_BASE_URL || 'https://sandbox.payme.io/api/';
if (!BASE.includes('sandbox')) {
  console.error('REFUSING: PAYME_BASE_URL is not the sandbox. This script deletes subscriptions and clearing rows.');
  process.exit(1);
}
if (!env.DATABASE_URL) { console.error('no DATABASE_URL in .env'); process.exit(1); }

const email = process.argv.slice(2).find((a) => !a.startsWith('-'));

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
const q = async (sql, params = []) => (await c.query(sql, params)).rows;

/** One row per seller: everything that stands between it and the brand-new state. */
const state = await q(`
  SELECT s.id, s.email,
         (s.merchant_kyc IS NOT NULL AND s.merchant_kyc::text NOT IN ('{}', 'null')) AS kyc,
         (s.bank_account IS NOT NULL OR s.business_id IS NOT NULL)                   AS payout,
         (SELECT count(*)::int FROM seller_subscriptions x WHERE x.seller_id = s.id) AS sub,
         (SELECT count(*)::int FROM seller_merchant_accounts m WHERE m.seller_id = s.id) AS acct,
         (SELECT count(*)::int FROM seller_merchant_accounts m
           WHERE m.seller_id = s.id AND m.public_key <> '')                          AS keyed,
         (SELECT count(*)::int FROM stores st
           WHERE st.seller_id = s.id AND st.deleted_at IS NULL)                      AS stores,
         (SELECT count(*)::int FROM stores st
           WHERE st.seller_id = s.id AND st.deleted_at IS NULL AND st.published_at IS NOT NULL) AS live
    FROM sellers s ORDER BY s.created_at`);

if (!email) {
  const mark = (r) => (r.kyc || r.payout || r.sub || r.acct || r.live ? '' : '  ← already fresh');
  console.log('\nמי מחזיק מה. להריץ שוב עם אימייל כדי לאפס אותו.\n');
  for (const r of state) {
    const held = [r.kyc && 'פרטי סליקה', r.payout && 'פרטי בנק', r.sub && 'מנוי', r.acct && `חשבון סליקה${r.keyed ? ' (עם מפתח — לא ניתן לאיפוס)' : ''}`].filter(Boolean);
    console.log(`  ${r.email.padEnd(38)} ${r.stores} חנויות, ${r.live} באוויר  ${held.join(' · ') || '—'}${mark(r)}`);
  }
  console.log('\n  npm run demo:fresh-seller -- <email>\n');
  await c.end();
  process.exit(0);
}

const seller = state.find((r) => r.email === email);
if (!seller) {
  console.error(`no seller with email ${email}. Run without an argument to list them.`);
  await c.end();
  process.exit(1);
}
if (seller.keyed) {
  console.error([
    `REFUSING: ${email} holds a PayMe merchant account WITH its public key.`,
    'PayMe return that key exactly once and their sandbox has no delete (payme-sandbox-notes.md §9),',
    'so deleting the row would take demo:clearing down permanently for this database.',
    'Pick another account, or register a new seller at /seller/register.',
  ].join('\n'));
  await c.end();
  process.exit(1);
}

await c.query(
  `UPDATE sellers SET merchant_kyc = NULL, bank_code = NULL, bank_branch = NULL, bank_account = NULL,
                      bank_account_holder = NULL, business_id = NULL, business_type = NULL
    WHERE id = $1`, [seller.id]);
const subs = await c.query('DELETE FROM seller_subscriptions WHERE seller_id = $1', [seller.id]);
const accts = await c.query('DELETE FROM seller_merchant_accounts WHERE seller_id = $1', [seller.id]);
// Both holds back on. Publication is DERIVED (`store-publication.ts`) — with the subscription gone
// and no approved merchant, this is the state the derivation itself would produce.
const down = await c.query(
  `UPDATE stores SET published_at = NULL, tier = NULL WHERE seller_id = $1 AND deleted_at IS NULL`, [seller.id]);

const site = env.PUBLIC_SITE_URL || 'http://localhost:4321';
console.log(`
──────────────────────────────────────────────────────────────────────
  ✅ ${email} חזר למצב של מוכר שזה עתה נרשם

     פרטי עסק ובנק      נמחקו
     מנוי + אמצעי תשלום  ${subs.rowCount} שורה נמחקה
     חשבון סליקה         ${accts.rowCount} נמחק
     חנויות              ${down.rowCount} ירדו מהאוויר, ללא מסלול

  ${site}/seller/dashboard?panel=payouts
──────────────────────────────────────────────────────────────────────`);
await c.end();
process.exit(0);
