import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import type { SellerTierId } from './pricing.js';
import { secretsEqual } from './secret-compare.js';
import { requiredSecret } from './runtime-env.js';
import { firstRow, isUuid, query, rows } from './db.js';

const COOKIE_NAME = 'seller_session';
const ONE_DAY = 60 * 60 * 24;
// Sellers should stay signed in until they explicitly log out, not get
// silently signed out every day.
const SESSION_TTL = ONE_DAY * 180;

export interface Seller {
  id: string;
  name: string;
  email: string;
  passwordHash: string; // empty string for OAuth-only accounts
  googleId?: string;
  /** Pricing tier — sets this seller's monthly fee AND per-sale commission (see lib/pricing.ts).
   *  Optional/additive: absent means the default tier, so no account needs backfilling and an
   *  older deploy reading this record is unaffected. Applies to ALL of a seller's stores — the
   *  subscription is per account/registered business, not per store. */
  tier?: SellerTierId;
  createdAt: string;
}

/**
 * Session-token signing key. In production a missing AUTH_SECRET is a HARD FAILURE,
 * not a fallback: the dev default is a literal in this repo, so shipping with it
 * would let anyone forge a session cookie for any seller id — a full auth bypass
 * with no exploit required beyond reading the source.
 *
 * Read via `requiredSecret` (runtime-env.ts), never `import.meta.env.AUTH_SECRET`: that form is
 * inlined at build time, so building without the variable constant-folded this whole function
 * into an unconditional throw and no runtime environment could undo it — every session check on
 * the deployed server failed, which reads as a routing bug, not a missing secret.
 */
function secret(): string {
  return requiredSecret('AUTH_SECRET', 'dev-insecure-secret');
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

/**
 * scrypt, not HMAC-SHA256. A single SHA-256 is designed to be FAST — a leaked
 * `sellers.json` would be brute-forced offline at GPU speed, which makes the salt
 * nearly worthless. scrypt is deliberately slow and memory-hard, so the same leak
 * costs an attacker orders of magnitude more per guess. Node ships it; no dependency.
 *
 * Stored as `scrypt:<salt>:<hash>`. Records written before 2026-07-29 have the old
 * two-field `<salt>:<hash>` shape and still verify (legacy branch below) — they're
 * upgraded to scrypt on the owner's next successful login, so nobody is locked out
 * and no migration script is needed.
 */
const SCRYPT_KEYLEN = 64;

function scryptHash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptHash(password, salt)}`;
}

/** Constant-time compare — a plain `===` leaks how many leading characters matched
 *  through its timing, which is enough to reconstruct a hash byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts[0] === 'scrypt' && parts.length === 3) {
    return safeEqual(scryptHash(password, parts[1]!), parts[2]!);
  }
  // Legacy HMAC record — verify, so existing accounts keep working.
  const [salt, hash] = parts;
  if (!salt || !hash) return false;
  return safeEqual(crypto.createHmac('sha256', salt).update(password).digest('hex'), hash);
}

/** True for a record still on the old fast hash, so a successful login can rewrite it. */
function needsRehash(stored: string): boolean {
  return !stored.startsWith('scrypt:');
}

/**
 * One seller row. Every read below selects these columns explicitly rather than `SELECT *`, so a
 * column added by a later migration cannot silently change what this module returns.
 */
const COLUMNS = 'id, name, email, password_hash, google_id, tier, created_at';

interface SellerRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  google_id: string | null;
  tier: string | null;
  created_at: Date | string | null;
}

/**
 * Row → `Seller`, keeping the exact shape the rest of the app already reads.
 *
 * The two `undefined`s are deliberate and not laziness: `googleId` and `tier` are optional on the
 * interface, and a caller doing `seller.tier ?? DEFAULT` behaves differently against `null`. Turning
 * the SQL nulls back into absent fields is what lets every existing call site stay as it is.
 */
function toSeller(row: SellerRow): Seller {
  const seller: Seller = {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
  if (row.google_id) seller.googleId = row.google_id;
  if (row.tier) seller.tier = row.tier as SellerTierId;
  return seller;
}

/**
 * Create the account, or return null if the address is taken.
 *
 * **The check is the INSERT, not a lookup before it (§7.4).** The old form read the file, looked for
 * the address, then wrote — two sellers registering the same address in the same moment both found
 * nothing and both got an account. `ON CONFLICT DO NOTHING` makes the unique index the one arbiter:
 * the loser gets zero rows back and the same `null` the caller already handles. The column is
 * `citext`, so `A@x.com` and `a@x.com` collide here as they should (§7.11).
 */
export async function registerSeller(email: string, password: string, name: string): Promise<Seller | null> {
  const row = await firstRow<SellerRow>(
    `INSERT INTO sellers (id, name, email, password_hash, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) DO NOTHING
     RETURNING ${COLUMNS}`,
    [crypto.randomUUID(), name, email, hashPassword(password)],
  );
  return row ? toSeller(row) : null;
}

export async function getSellerById(id: string): Promise<Seller | null> {
  if (!isUuid(id)) return null;
  const row = await firstRow<SellerRow>(`SELECT ${COLUMNS} FROM sellers WHERE id = $1`, [id]);
  return row ? toSeller(row) : null;
}

/**
 * Every seller — the admin roster and the platform-wide tier counts.
 *
 * `ORDER BY` is not decoration (§7.13): a table has no natural order, so without it the same list
 * comes back differently after any `UPDATE` and the admin's seller list reshuffles itself between
 * loads. `id` breaks the tie on sellers registered in the same millisecond.
 */
export async function getAllSellers(): Promise<Seller[]> {
  return (await rows<SellerRow>(`SELECT ${COLUMNS} FROM sellers ORDER BY created_at, id`)).map(toSeller);
}

export async function getSellerByEmail(email: string): Promise<Seller | null> {
  const row = await firstRow<SellerRow>(`SELECT ${COLUMNS} FROM sellers WHERE email = $1`, [email]);
  return row ? toSeller(row) : null;
}

export async function getSellerByGoogleId(googleId: string): Promise<Seller | null> {
  const row = await firstRow<SellerRow>(`SELECT ${COLUMNS} FROM sellers WHERE google_id = $1`, [googleId]);
  return row ? toSeller(row) : null;
}

/**
 * The account behind a Google sign-in, creating it if this is the first one.
 *
 * **Why it tolerates losing the race rather than raising.** The caller looks for an existing account
 * and only calls this when it found none — which stops being true the instant two sign-ins for the
 * same new address arrive together, and OAuth callbacks arriving in pairs is ordinary (a double
 * click, a retried redirect). On files that produced two accounts for one person, silently. Against
 * two unique indexes it would produce a 500 on the second, in the middle of signing in.
 *
 * `ON CONFLICT DO NOTHING` with no target covers BOTH indexes — the address and the Google id — and
 * the loser reads back the row the winner just wrote. One account either way, and the second visitor
 * is signed into it instead of being shown an error.
 */
export async function createGoogleSeller(email: string, name: string, googleId: string): Promise<Seller> {
  const row = await firstRow<SellerRow>(
    `INSERT INTO sellers (id, name, email, password_hash, google_id, created_at)
     VALUES ($1, $2, $3, '', $4, now())
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [crypto.randomUUID(), name, email, googleId],
  );
  if (row) return toSeller(row);

  const existing = (await getSellerByGoogleId(googleId)) ?? (await getSellerByEmail(email));
  if (existing) return existing;
  // Neither index explains the conflict — something is wrong that a retry will not fix, and a
  // caller that gets a fabricated account here would sign somebody into the wrong one.
  throw new Error(`Could not create or find the Google account for ${email}`);
}

export async function linkGoogleAccount(sellerId: string, googleId: string): Promise<void> {
  if (!isUuid(sellerId)) return;
  await query('UPDATE sellers SET google_id = $2 WHERE id = $1', [sellerId, googleId]);
}

export async function loginSeller(email: string, password: string): Promise<Seller | null> {
  const seller = await getSellerByEmail(email);
  if (!seller || !verifyPassword(password, seller.passwordHash)) return null;

  // Transparent upgrade off the old fast hash — this is the one moment the plaintext
  // password is available, so it's the only place the record CAN be re-hashed without
  // forcing a reset. Failure here must never fail the login itself.
  if (needsRehash(seller.passwordHash)) {
    try {
      const upgraded = hashPassword(password);
      // Guarded on the hash we just verified: two concurrent logins would otherwise each write
      // their own salt, and the second would land on top of a record the first already replaced.
      await query('UPDATE sellers SET password_hash = $2 WHERE id = $1 AND password_hash = $3',
        [seller.id, upgraded, seller.passwordHash]);
      seller.passwordHash = upgraded;
    } catch { /* keep the user logged in; the next login retries the upgrade */ }
  }
  return seller;
}

export async function updateSeller(
  id: string,
  fields: { name?: string; email?: string; currentPassword?: string; newPassword?: string }
): Promise<{ ok: true; seller: Seller } | { ok: false; error: string }> {
  const seller = await getSellerById(id);
  if (!seller) return { ok: false, error: 'משתמש לא נמצא' };

  // null unless this request is actually changing it — see the COALESCE below.
  let changedPassword: string | null = null;
  if (fields.newPassword) {
    if (!fields.currentPassword) return { ok: false, error: 'נדרשת סיסמה נוכחית' };
    if (!verifyPassword(fields.currentPassword, seller.passwordHash)) {
      return { ok: false, error: 'הסיסמה הנוכחית שגויה' };
    }
    changedPassword = hashPassword(fields.newPassword);
  }

  // Two rules in one statement.
  //
  // `COALESCE` writes ONLY the fields this request actually carries — the repo's standing "a save
  // must never revert a field the seller did not touch" (lib/record-rev.ts). Passing the values
  // read a moment ago instead would reintroduce read-modify-write: a profile save carrying only an
  // address, racing a rename from another tab, would put the old name back and nothing would report
  // it. Untouched fields are `null` here and the column keeps whatever it holds now.
  //
  // And the address collision is settled by the unique index rather than by a lookup before the
  // write (§7.4) — "is this free?" answered separately is only true until the next statement.
  try {
    const row = await firstRow<SellerRow>(
      `UPDATE sellers
          SET name          = COALESCE($2, name),
              email         = COALESCE($3, email),
              password_hash = COALESCE($4, password_hash)
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, fields.name || null, fields.email || null, changedPassword],
    );
    return row ? { ok: true, seller: toSeller(row) } : { ok: false, error: 'משתמש לא נמצא' };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'כתובת המייל כבר בשימוש' };
    throw err;
  }
}

/**
 * Postgres SQLSTATE 23505. Matched on the code and not on the message, which is localised by the
 * server's `lc_messages` and would make this depend on how the database was configured.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function makeToken(sellerId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = `${sellerId}|${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!secretsEqual(sign(payload), sig)) return null;
  const [sellerId, exp] = payload.split('|');
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return sellerId ?? null;
}

export function setSellerSession(cookies: AstroCookies, sellerId: string): void {
  cookies.set(COOKIE_NAME, makeToken(sellerId), {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export function getSellerSession(cookies: AstroCookies): string | null {
  return verifyToken(cookies.get(COOKIE_NAME)?.value);
}

export function clearSellerSession(cookies: AstroCookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}
