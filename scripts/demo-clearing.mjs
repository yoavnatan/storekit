#!/usr/bin/env node
/**
 * Put ONE seller into the state where every clearing screen actually renders, and print the way in.
 *
 * ── Why this exists (owner, 2026-08-25) ──
 * *"אבל איך אני יכול לראות את זה פועל? איך אני יכול להגיד שה-UI תקין ואיך אפשר לוודא שזה עובד?"* —
 * and he was right that he could not. The transfer strip, the fee split, the invoicing card and the
 * buyer's card form all need the same three things at once: a seller with a PayMe merchant account,
 * that account approved, and a shop actually on the site. A fresh dev database has none of them, so
 * those screens are correct and invisible, and "it works" was something he had to take on trust.
 *
 * It is the same gap the accessibility audit hit (area row 22): axe could only scan the dashboards
 * statically, because there was no seller to log in as.
 *
 *   npm run demo:clearing            # set it up and print the links
 *   npm run demo:clearing -- --undo  # put it back
 *
 * ── What it will NOT do ──
 * **Sandbox only, and it refuses otherwise.** Every write here is a shortcut around a gate that
 * exists for a reason, and the same rows in production would mean a shop selling with no clearing
 * account behind it. The base URL is checked the way `payme-probe.mjs` checks it.
 *
 * **It creates no merchant at PayMe.** Their sandbox has no delete and is shared with their other
 * partners, and `create-seller` returns the public key exactly once (sandbox notes §9). So this
 * uses a merchant that is already in the database WITH its key — i.e. one opened through
 * `ensureMerchantAccount`, never by hand — and says so plainly when there is none.
 *
 * ── The one shortcut, named ──
 * Publication is DERIVED, never a button (`store-publication.ts`): a shop goes up when all three
 * holds are empty. This clears the two that are ours to clear — the merchant's approval, which
 * PayMe never grant in the sandbox, and the subscription — and then writes `published_at` itself,
 * because `syncStorePublication` is TypeScript and a plain node script cannot import it. **That is
 * the same end state the derivation would produce**, which is why it is acceptable here and only
 * here: with both holds genuinely clear, the real function would publish exactly these shops. It is
 * a shortcut around the MECHANISM and not around the RULE, and `--undo` reverses all three writes.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const BASE = env.PAYME_BASE_URL || 'https://sandbox.payme.io/api/';
if (!BASE.includes('sandbox')) {
  console.error('REFUSING: PAYME_BASE_URL is not the sandbox. This script writes rows that bypass real gates.');
  process.exit(1);
}
if (!env.DATABASE_URL) { console.error('no DATABASE_URL in .env'); process.exit(1); }

const undo = process.argv.includes('--undo');
const PASSWORD = 'clearing1234';
/** PayMe's `sub_status`. 2 = active — the literal, because this file cannot import their table. */
const SUB_ACTIVE = 2;
/** Our own marker in `provider_ref`, deliberately a string no PayMe id can look like: it is how
 *  `--undo` knows which subscription row is this script's to delete and which is a real one. */
const MARKER = 'demo-clearing';
/** Appended to a restored shop's tagline so `--undo` can tell a lab leftover it un-deleted from a
 *  shop that was always there. Visible on the page on purpose — nobody should mistake it for real. */
const RESTORE_MARK = ' [demo:clearing]';

/** The salt:hmac shape `seed-demo-data.mjs` writes, so the login path exercised is the real one. */
const hash = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.createHmac('sha256', salt).update(pw).digest('hex')}`;
};

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
const q = async (sql, params = []) => (await c.query(sql, params)).rows;

// ── The seller: whoever already has a merchant account with its public key stored ──────────────
// The key is the whole point. Without it PayMe's Hosted Fields cannot be drawn, so the buyer's card
// form stays hidden however published the shop is — and that is half of what he wants to look at.
const candidates = await q(`
  SELECT m.seller_id, s.email, m.provider_ref
    FROM seller_merchant_accounts m
    JOIN sellers s ON s.id = m.seller_id
   WHERE m.public_key <> ''
   ORDER BY m.created_at`);

if (!candidates.length) {
  console.error([
    'No merchant account in this database has its public key stored, and one cannot be repaired:',
    'PayMe return it exactly once, from `create-seller` (docs/payme-sandbox-notes.md §9).',
    '',
    'To make one: sign in as a seller, open a shop, and fill in the clearing details on the',
    'Payments tab — `ensureMerchantAccount` opens the account through our own code and stores all',
    'three unrecoverable columns. Then run this again.',
  ].join('\n'));
  await c.end();
  process.exit(1);
}
const seller = candidates[0];

/**
 * Shops of this seller that have something to buy — the only ones worth putting up.
 *
 * **`deleted_at` is read, and it is the reason this query is not two lines.** The first version
 * ignored it, put a shop "live", printed its URL, and the URL 302'd to /404 — because the shop had
 * been soft-deleted by an earlier lab run months of commits ago. A setup script whose printed link
 * does not open is worse than no script: it sends someone looking for a bug in the page.
 * A shop that is merely deleted is RESTORED here (this is a lab account in a sandbox, and `--undo`
 * puts the timestamp back), but only when no live shop of this seller already has products.
 */
const shops = await q(
  `SELECT st.id, st.slug, st.name, st.deleted_at,
          st.published_at IS NOT NULL AS live,
          (SELECT count(*)::int FROM store_products p WHERE p.store_id = st.id) AS products
     FROM stores st WHERE st.seller_id = $1 ORDER BY st.created_at`,
  [seller.seller_id],
);
const stocked = shops.filter((s) => s.products > 0);
const sellable = stocked.filter((s) => !s.deleted_at).length
  ? stocked.filter((s) => !s.deleted_at)
  : stocked;
const restored = sellable.filter((s) => s.deleted_at).map((s) => s.id);

if (undo) {
  await c.query('UPDATE seller_merchant_accounts SET approved = false, updated_at = now() WHERE seller_id = $1', [seller.seller_id]);
  const gone = await c.query('DELETE FROM seller_subscriptions WHERE seller_id = $1 AND provider_ref = $2', [seller.seller_id, MARKER]);
  // Only the shops this script put up. A shop that was live before it ran stays live — the marker
  // for that is the subscription row: with none of ours, we published nothing.
  const down = gone.rowCount
    ? await c.query('UPDATE stores SET published_at = NULL WHERE seller_id = $1 AND id = ANY($2::uuid[])',
      [seller.seller_id, sellable.map((s) => s.id)])
    : { rowCount: 0 };
  // Re-delete only what this run restored. Recorded in the shop's own row rather than in a file:
  // `demo_restored` is written beside the restore and read here, so an --undo months later still
  // knows which shops were somebody's lab leftovers and which are real.
  const redeleted = gone.rowCount
    ? await c.query(`UPDATE stores SET deleted_at = now()
                      WHERE seller_id = $1 AND deleted_at IS NULL AND tagline LIKE '%' || $2 || '%'`,
      [seller.seller_id, RESTORE_MARK])
    : { rowCount: 0 };
  if (redeleted.rowCount) {
    await c.query(`UPDATE stores SET tagline = replace(tagline, $2, '') WHERE seller_id = $1`, [seller.seller_id, RESTORE_MARK]);
  }
  console.log(`undone for ${seller.email} — merchant un-approved, ${gone.rowCount} demo subscription row removed, ${down.rowCount} shop(s) taken back down, ${redeleted.rowCount} re-deleted.`);
  await c.end();
  process.exit(0);
}

// ── Clear the two holds that are ours to clear ─────────────────────────────────────────────────
// `clearing-approval`: PayMe examine every business and may take up to seven business days. In the
// sandbox they never do, so nothing would ever approve this merchant by itself.
await c.query('UPDATE seller_merchant_accounts SET approved = true, updated_at = now() WHERE seller_id = $1', [seller.seller_id]);
// `subscription`: a real one is a card entered on PayMe's own page.
await c.query(
  `INSERT INTO seller_subscriptions (seller_id, provider, provider_ref, tier, price_agorot, status, started_at)
        VALUES ($1, 'payme', $2, 'basic', 9900, $3, now())
   ON CONFLICT (seller_id) DO UPDATE SET provider_ref = EXCLUDED.provider_ref, status = EXCLUDED.status`,
  [seller.seller_id, MARKER, SUB_ACTIVE],
);
await c.query('UPDATE sellers SET password_hash = $2 WHERE id = $1', [seller.seller_id, hash(PASSWORD)]);
if (restored.length) {
  await c.query(
    `UPDATE stores SET deleted_at = NULL, tagline = COALESCE(tagline, '') || $2 WHERE id = ANY($1::uuid[])`,
    [restored, RESTORE_MARK],
  );
}
const up = sellable.length
  ? await c.query('UPDATE stores SET published_at = COALESCE(published_at, now()) WHERE id = ANY($1::uuid[])', [sellable.map((s) => s.id)])
  : { rowCount: 0 };

const site = env.PUBLIC_SITE_URL || 'http://localhost:4321';
const shop = sellable[0];

console.log(`
──────────────────────────────────────────────────────────────────────
  ✅ מוכר מוכן: ${seller.email}
     סיסמה: ${PASSWORD}
     חשבון סליקה: ${seller.provider_ref} — מאושר
     חנויות שהועלו: ${up.rowCount}${sellable.length ? ` (${sellable.map((s) => s.slug).join(', ')})` : ' — ⚠️ אין לו חנות עם מוצרים'}

  מה לפתוח, לפי הסדר:

  1. ${site}/seller/login   —  התחבר עם הפרטים למעלה
  2. ${site}/seller/dashboard?panel=payouts
       · "הכסף שבדרך אליכם"       — כמה פיימי מחזיקים ומתי יעבירו
       · "העמלות על המכירות שלכם"  — עמלת סליקה, עמלת המתחם, ומה נכנס אליו
       · כרטיס החשבוניות — יופיע רק אם פיימי הקצו את השירות, ועדיין לא
  3. ${shop ? `${site}/${shop.slug}` : '(אין חנות עם מוצרים)'}  —  הוסף מוצר לעגלה
  4. ${site}/checkout        —  קופסת פרטי הכרטיס, שלושת השדות של פיימי
       · הקטן ל-375px ובדוק ש"תוקף" ו"קוד אבטחה" באותה שורה והשדות מיושרים
       · כרטיס בדיקה: 12312312, תוקף עתידי כלשהו, שלוש ספרות ל-CVV

  ⚠️ החנות עלתה לאוויר בלי תשלום אמיתי — זו סביבת פיתוח בלבד.
  להחזיר הכול: npm run demo:clearing -- --undo
──────────────────────────────────────────────────────────────────────`);
await c.end();
process.exit(0);
