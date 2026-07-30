// `npm start` must not come up without the secrets that make sessions forgeable and /admin
// guessable. The in-code guards throw on the first request that touches a session, which the
// visitor sees as a redirect and an operator sees as nothing — GO_LIVE_CHECKLIST §7 has always
// promised "fails at boot", and scripts/check-required-env.mjs (wired as `prestart`) is what
// makes that true. It only became possible once configuration was read from process.env at
// runtime; while it was inlined at build time there was nothing left to check.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-required-env.mjs', import.meta.url));

/** Runs the gate with a controlled environment; returns its exit code and stderr. */
function runGate(env: Record<string, string>): { code: number; err: string } {
  try {
    execFileSync(process.execPath, [SCRIPT], {
      // A clean environment, so the developer's own shell can't accidentally satisfy the gate.
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, err: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? -1, err: err.stderr ?? '' };
  }
}

const REAL = { AUTH_SECRET: 'a'.repeat(64), ADMIN_SECRET: 'b'.repeat(64) };

describe('the production start gate', () => {
  it('passes with both secrets set to real values', () => {
    expect(runGate(REAL).code).toBe(0);
  });

  it('refuses to start when a secret is missing, and names it', () => {
    const { code, err } = runGate({ ADMIN_SECRET: REAL.ADMIN_SECRET });
    expect(code).toBe(1);
    expect(err).toContain('AUTH_SECRET');
    expect(err).not.toContain('ADMIN_SECRET is');
  });

  it('refuses the public dev defaults, not just an empty value', () => {
    // The whole point of the guard: shipping with a secret that is a literal in this repo lets
    // anyone forge a session for any seller id, and makes /admin's password "admin".
    const { code, err } = runGate({ AUTH_SECRET: 'dev-insecure-secret', ADMIN_SECRET: 'admin' });
    expect(code).toBe(1);
    expect(err).toContain('AUTH_SECRET');
    expect(err).toContain('ADMIN_SECRET');
  });

  it('treats a blank value as missing', () => {
    expect(runGate({ AUTH_SECRET: '', ADMIN_SECRET: '' }).code).toBe(1);
  });

  it('is wired as prestart, and start serves the BUILD rather than the dev server', () => {
    // `start` used to be an alias for `astro dev` — the command a host runs by default — where
    // import.meta.env.PROD is false and every missing secret silently takes its dev default.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.prestart).toContain('check-required-env.mjs');
    expect(pkg.scripts.start).toContain('dist/server/entry.mjs');
    expect(pkg.scripts.start).not.toContain('astro dev');
  });

  it('the dev defaults it rejects are the ones the auth modules actually use', () => {
    // A renamed fallback in either module would leave this gate checking a string nobody uses.
    const gate = readFileSync(SCRIPT, 'utf8');
    const seller = readFileSync(new URL('../src/lib/seller-auth.ts', import.meta.url), 'utf8');
    const admin = readFileSync(new URL('../src/lib/admin-auth.ts', import.meta.url), 'utf8');
    const devDefault = (src: string, name: string) =>
      new RegExp(`requiredSecret\\('${name}', '([^']+)'\\)`).exec(src)?.[1];
    expect(gate).toContain(`devDefault: '${devDefault(seller, 'AUTH_SECRET')}'`);
    expect(gate).toContain(`devDefault: '${devDefault(admin, 'ADMIN_SECRET')}'`);
  });
});
