import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import type { SellerTierId } from './pricing.js';

const SELLERS_PATH = path.join(process.cwd(), 'data/sellers.json');
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
 * with no exploit required beyond reading the source. Failing at boot is loud;
 * silently signing with a public string is not.
 */
function secret(): string {
  const configured = import.meta.env.AUTH_SECRET;
  if (configured) return configured;
  if (import.meta.env.PROD) {
    throw new Error('AUTH_SECRET is not set. Refusing to sign sessions with the public dev default.');
  }
  return 'dev-insecure-secret';
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

function readSellers(): Seller[] {
  try { return JSON.parse(fs.readFileSync(SELLERS_PATH, 'utf8')) as Seller[]; }
  catch { return []; }
}

function writeSellers(sellers: Seller[]): void {
  fs.writeFileSync(SELLERS_PATH, JSON.stringify(sellers, null, 2));
}

export function registerSeller(email: string, password: string, name: string): Seller | null {
  const sellers = readSellers();
  if (sellers.find((s) => s.email === email)) return null;
  const seller: Seller = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  sellers.push(seller);
  writeSellers(sellers);
  return seller;
}

export function getSellerById(id: string): Seller | null {
  return readSellers().find((s) => s.id === id) ?? null;
}

export function getAllSellers(): Seller[] {
  return readSellers();
}

export function getSellerByEmail(email: string): Seller | null {
  return readSellers().find((s) => s.email === email) ?? null;
}

export function getSellerByGoogleId(googleId: string): Seller | null {
  return readSellers().find((s) => s.googleId === googleId) ?? null;
}

export function createGoogleSeller(email: string, name: string, googleId: string): Seller {
  const sellers = readSellers();
  const seller: Seller = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: '',
    googleId,
    createdAt: new Date().toISOString(),
  };
  sellers.push(seller);
  writeSellers(sellers);
  return seller;
}

export function linkGoogleAccount(sellerId: string, googleId: string): void {
  const sellers = readSellers();
  const idx = sellers.findIndex((s) => s.id === sellerId);
  if (idx === -1) return;
  sellers[idx]!.googleId = googleId;
  writeSellers(sellers);
}

export function loginSeller(email: string, password: string): Seller | null {
  const sellers = readSellers();
  const seller = sellers.find((s) => s.email === email);
  if (!seller || !verifyPassword(password, seller.passwordHash)) return null;

  // Transparent upgrade off the old fast hash — this is the one moment the plaintext
  // password is available, so it's the only place the record CAN be re-hashed without
  // forcing a reset. Failure here must never fail the login itself.
  if (needsRehash(seller.passwordHash)) {
    try {
      seller.passwordHash = hashPassword(password);
      writeSellers(sellers);
    } catch { /* keep the user logged in; the next login retries the upgrade */ }
  }
  return seller;
}

export function updateSeller(
  id: string,
  fields: { name?: string; email?: string; currentPassword?: string; newPassword?: string }
): { ok: true; seller: Seller } | { ok: false; error: string } {
  const sellers = readSellers();
  const idx = sellers.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: 'משתמש לא נמצא' };
  const seller = { ...sellers[idx]! };

  if (fields.email && fields.email !== seller.email) {
    if (sellers.some((s) => s.id !== id && s.email === fields.email)) {
      return { ok: false, error: 'כתובת המייל כבר בשימוש' };
    }
  }

  if (fields.newPassword) {
    if (!fields.currentPassword) return { ok: false, error: 'נדרשת סיסמה נוכחית' };
    if (!verifyPassword(fields.currentPassword, seller.passwordHash)) {
      return { ok: false, error: 'הסיסמה הנוכחית שגויה' };
    }
    seller.passwordHash = hashPassword(fields.newPassword);
  }

  if (fields.name)  seller.name  = fields.name;
  if (fields.email) seller.email = fields.email;

  sellers[idx] = seller;
  writeSellers(sellers);
  return { ok: true, seller };
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
  if (sign(payload) !== sig) return null;
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
