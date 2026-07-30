// `import.meta.env.SOME_SECRET` is a compile-time text substitution, not a lookup. Building
// without the variable present does not leave a runtime hole to fill — it bakes `undefined` in
// and lets the constant folder delete the surrounding check. Measured on a real `astro build`
// (2026-07-30): seller-auth's guard came out of the bundle as
// `function secret(){ throw new Error('AUTH_SECRET is not set…') }`, so every request touching a
// session threw on the deployed server no matter what its environment said, and the visitor saw
// a redirect rather than an error. GO_LIVE_CHECKLIST §7 documented the opposite behaviour.
//
// So: server-only variables go through serverEnv/requiredSecret, and the scan at the bottom is
// what stops the direct form coming back — the same shape as the safe-redirect and
// secret-compare guards.

import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { serverEnv, requiredSecret, hydrateProcessEnv } from '../src/lib/runtime-env.js';

const TEST_VAR = 'RUNTIME_ENV_TEST_VAR';
afterEach(() => { delete process.env[TEST_VAR]; });

describe('serverEnv', () => {
  it('reads the live process environment', () => {
    process.env[TEST_VAR] = 'from-process';
    expect(serverEnv(TEST_VAR)).toBe('from-process');
  });

  it('returns undefined for an unset variable', () => {
    expect(serverEnv(TEST_VAR)).toBeUndefined();
  });

  it('treats a blank value as unset', () => {
    // Not `??`: an empty secret that counted as "configured" would compare equal to an empty
    // submitted password, which is how a blank ADMIN_SECRET would have authenticated everyone.
    process.env[TEST_VAR] = '';
    expect(serverEnv(TEST_VAR)).toBeUndefined();
  });
});

describe('requiredSecret', () => {
  it('returns the configured value when one is set', () => {
    process.env[TEST_VAR] = 'a-real-secret';
    expect(requiredSecret(TEST_VAR, 'dev-default')).toBe('a-real-secret');
  });

  it('falls back to the dev default outside production, so a fresh clone runs', () => {
    expect(requiredSecret(TEST_VAR, 'dev-default')).toBe('dev-default');
  });

  it('refuses the dev default in production', () => {
    // import.meta.env.PROD cannot be flipped per-test without reloading the module graph, so the
    // production branch itself is asserted as source text — the same approach admin-auth's guard
    // used before it moved here.
    const src = readFileSync(new URL('../src/lib/runtime-env.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(import\.meta\.env\.PROD\) \{\s*\n\s*throw new Error/);
  });
});

describe('hydrateProcessEnv', () => {
  it('fills in a variable the process was not started with', () => {
    hydrateProcessEnv({ [TEST_VAR]: 'from-dotenv' });
    expect(serverEnv(TEST_VAR)).toBe('from-dotenv');
  });

  it('never overwrites the real environment', () => {
    // A value exported in the shell (or injected by the host) beats a stale line in a local
    // file — that is the precedence every dotenv loader uses, and what someone overriding a
    // variable for a single run expects.
    process.env[TEST_VAR] = 'from-shell';
    hydrateProcessEnv({ [TEST_VAR]: 'from-dotenv' });
    expect(serverEnv(TEST_VAR)).toBe('from-shell');
  });

  it('skips blanks, so an empty line does not become a configured value', () => {
    hydrateProcessEnv({ [TEST_VAR]: '', OTHER: undefined });
    expect(serverEnv(TEST_VAR)).toBeUndefined();
  });
});

describe('the dev server sees .env', () => {
  // Astro loads .env into process.env only during `astro build` (its env plugin, at buildStart),
  // and private variables reach Vite as `define` text replacements that no runtime lookup can
  // read. So without this wiring every server variable in .env reads as unset under `astro dev`
  // — and each one fails quietly: no Google button, console-only email, /admin back on its dev
  // password. Verified against a real build: served with an empty environment, a bundle built
  // WITH .env present saw none of its values.
  it('astro.config.mjs hydrates process.env for the dev server', () => {
    const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
    expect(config).toMatch(/hydrateProcessEnv\(loadEnv\(mode, process\.cwd\(\), ''\)\)/);
    // Dev only: during a build Astro already does it, and in production the environment is the
    // source of truth — a stray .env on the server must not quietly re-enter the picture.
    expect(config).toMatch(/apply: 'serve'/);
    expect(config).toMatch(/plugins: \[dotEnvForDevServer\(\)/);
  });

  it('serverEnv has no import.meta.env fallback, which could never have fired', () => {
    const src = readFileSync(new URL('../src/lib/runtime-env.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function serverEnv'));
    expect(body).not.toMatch(/import\.meta\.env\s*[[(]/);
  });
});

/** Every source file under src/, so a new module is covered the moment it exists. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (/\.(ts|astro)$/.test(full)) out.push(full);
  }
  return out;
}

/** Comments discuss the banned form on purpose (including in runtime-env.ts itself). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// PUBLIC_* is inlined into browser bundles deliberately and there is no `process` there;
// DEV/PROD/MODE/SSR/BASE_URL are genuinely build-time facts, not configuration.
const BUILD_TIME_OK = /^(DEV|PROD|MODE|SSR|BASE_URL|PUBLIC_[A-Z0-9_]+)$/;

describe('no server variable is read straight off import.meta.env', () => {
  it('src/ routes every server-only variable through runtime-env.ts', () => {
    const offenders: string[] = [];
    for (const file of srcFiles('src')) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        if (!BUILD_TIME_OK.test(m[1]!)) offenders.push(`${file} → import.meta.env.${m[1]}`);
      }
    }
    expect(
      offenders,
      `Read these with serverEnv('NAME') / requiredSecret('NAME', dev) from src/lib/runtime-env.ts —
import.meta.env.NAME is inlined at build time, so a value supplied to the running server is
invisible and the surrounding guard can be constant-folded away entirely:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
