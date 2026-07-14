import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';

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
  createdAt: string;
}

function secret(): string {
  return import.meta.env.AUTH_SECRET || 'dev-insecure-secret';
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  return crypto.createHmac('sha256', salt!).update(password).digest('hex') === hash;
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
  const seller = readSellers().find((s) => s.email === email);
  if (!seller || !verifyPassword(password, seller.passwordHash)) return null;
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
