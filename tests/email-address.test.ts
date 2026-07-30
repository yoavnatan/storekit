import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isValidEmail, MAX_EMAIL_LENGTH } from '../src/lib/email-address.js';

describe('isValidEmail', () => {
  it('accepts ordinary addresses, including the ones naive checks reject', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('yoavnatan.yn@gmail.com')).toBe(true);
    expect(isValidEmail('seller+orders@shop.co.il')).toBe(true);
    expect(isValidEmail("o'brien@example.com")).toBe(true);
  });

  it('rejects the shapes that are not addresses at all', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('nodomain')).toBe(false);
    expect(isValidEmail('no@dot')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('two@@example.com')).toBe(false);
    expect(isValidEmail('spaces in@example.com')).toBe(false);
    expect(isValidEmail('trailing@example.com.')).toBe(false);
    expect(isValidEmail('double@example..com')).toBe(false);
  });

  it('rejects a non-string without throwing — routes hand it raw JSON fields', () => {
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
    expect(isValidEmail(['a@b.co'])).toBe(false);
  });

  it('enforces the RFC 5321 length cap', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length);
    expect(isValidEmail(`${local}@example.com`)).toBe(true);
    expect(isValidEmail(`${local}a@example.com`)).toBe(false);
  });

  // The cap is a denial-of-service control, not a tidiness rule. /api/checkout takes buyerEmail
  // from an unauthenticated JSON body, and the pattern this replaced had two competing `[^\s@]+`
  // runs around the dot — on a long domain with no dot, that is quadratic work per request.
  it('answers instantly on a megabyte of junk instead of backtracking through it', () => {
    const hostile = `a@${'b'.repeat(1_000_000)}`;
    const started = process.hrtime.bigint();
    expect(isValidEmail(hostile)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(50);
  });
});

// The point of the helper is that no surface re-implements the rule. The old copy-pasted pattern
// existed in three places and was missing entirely from seller registration, which is how an
// account could be created against an address that could never receive a password reset.
describe('nothing hand-rolls the email check', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it('leaves the pattern to lib/email-address.ts', () => {
    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith(join('lib', 'email-address.ts')))
      .filter((f) => /\[\^\\s@\]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  // The grep above only catches someone re-typing the regex. This catches the likelier failure —
  // a NEW route that takes an email and validates nothing at all, which is exactly how seller
  // registration and the seller order-edit endpoint both shipped unvalidated.
  it('validates the address in every route that accepts one', () => {
    // Login is deliberately exempt: it looks the address up rather than storing it, so a malformed
    // value simply fails to match a seller. Rejecting on format would only tell an attacker which
    // strings are addresses.
    const exempt = [join('pages', 'seller', 'login.astro')];

    const offenders = walk(join('src', 'pages'))
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !exempt.some((e) => f.endsWith(e)))
      .filter((f) => {
        const src = serverCode(readFileSync(f, 'utf8'), f);
        return INTAKE_PATTERNS.some((re) => re.test(src)) && !src.includes('isValidEmail');
      });
    expect(offenders).toEqual([]);
  });
});

/** The server-executed part of a page. For `.astro` that is the frontmatter only — the same
 *  `body.email` shape appears in browser fetch code, where the server route it posts to is the
 *  thing that has to validate, and flagging the caller would just train us to add exemptions. */
function serverCode(src: string, path: string): string {
  if (!path.endsWith('.astro')) return src;
  const end = src.indexOf('\n---', src.startsWith('---') ? 3 : 0);
  return end === -1 ? '' : src.slice(0, end);
}

// Signals that an email arrived FROM a request, rather than being read back out of a stored order.
// Matching `buyerEmail` alone flags every page that merely displays one. These three are what the
// four real intake sites actually look like; a route inventing a fourth shape would slip past, so
// this narrows the gap rather than closing it.
const INTAKE_PATTERNS = [
  /\b(?:buyer)?[eE]mail\??\s*:\s*unknown/, // declared in a request-body type
  /\bbody\.(?:buyer)?[eE]mail\b/, // read off a parsed JSON body
  /\.get\(['"](?:buyer)?[eE]mail['"]\)/, // pulled from form data or a query string
];
