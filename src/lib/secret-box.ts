/**
 * Encryption at rest for secrets a SELLER hands us — today his clearing credentials.
 *
 * ── Why this exists at all ──
 * Every other secret in this repo is ours: `AUTH_SECRET`, `ADMIN_SECRET`, a provider key in the
 * environment. They live in `.env`, never in Postgres, and nothing has ever needed this file. A
 * seller's own API key is different in kind — it is his money it moves, he cannot rotate it without
 * noticing us, and it arrives through a form, so the database is the only place it can live. A row
 * that holds it in plain text turns one leaked backup into every seller's terminal.
 *
 * ── AES-256-GCM, and what that buys ──
 * GCM authenticates as well as encrypts: a row edited in the database fails to decrypt instead of
 * decrypting to something else. That matters more here than confidentiality alone — an attacker who
 * can WRITE the column could otherwise swap a seller's terminal id for his own and quietly collect
 * that shop's payments.
 *
 * ── The key ──
 * `SECRET_BOX_KEY`, read through `runtime-env.ts` like every other server secret, and hashed to 32
 * bytes so any passphrase length works. In development it falls back to a published constant, which
 * is the same bargain `requiredSecret` already makes everywhere else: a fresh clone runs, and
 * production refuses to start on the fallback. **Rotating it makes every stored secret
 * undecryptable** — there is no key list and no re-wrap path, because with a handful of sellers the
 * honest recovery is to ask them to paste the credentials again. Write that path before the number
 * of sellers makes it untrue.
 */
import crypto from 'node:crypto';
import { requiredSecret } from './runtime-env.js';

/** Version prefix on every ciphertext. A stored value that does not start with it is not ours, and
 *  is rejected rather than guessed at — the day a second scheme exists, this is what tells them
 *  apart without a second column. */
const SCHEME = 'v1';

function key(): Buffer {
  // sha256 of the passphrase: accepts any length, and never lets a short one silently become a
  // short key. Not scrypt — this runs on every checkout that reads a seller's credentials, and the
  // input is a high-entropy environment secret rather than a human password, which is the case
  // where a slow KDF costs latency and buys nothing.
  return crypto.createHash('sha256').update(requiredSecret('SECRET_BOX_KEY', 'dev-insecure-secret-box')).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. One string, so it fits a single text column. */
export function sealSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SCHEME, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * The plaintext, or `null` when the value cannot be trusted — wrong key, edited row, a column
 * holding something this file did not write.
 *
 * Null rather than a throw: the callers are a checkout and a settings screen, and both have a
 * sensible thing to do with "this seller's credentials are unreadable" (refuse the payment, ask him
 * to enter them again). A throw would turn a bad row into a 500 on a shop page.
 */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * What a screen may show about a stored secret: the last four characters and nothing else.
 *
 * A seller has to be able to tell "the key I pasted last month" from "the key I rotated yesterday",
 * and cannot if the field renders empty. Four characters is enough for that and useless to anybody
 * else. Never render the secret itself — not in a value attribute, not in a data attribute, not in
 * a JSON island; the page is HTML the browser keeps.
 */
export function secretHint(plaintext: string | null | undefined): string {
  if (!plaintext) return '';
  return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`;
}
