import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * `one-way-to-verify.sh` — tested because nothing else can see a hook fail: one that stops speaking
 * up is silent by definition, and the rule it enforces went unenforced for five days without anyone
 * noticing (67 hand-run `astro check` / `tsc` invocations, 41 minutes).
 *
 * Its whole risk is over-blocking, which is why most of these cases are things it must let through:
 * a gate that blocks work it was never meant to block gets switched off, and then it protects
 * nothing.
 */
const HOOKS = resolve(fileURLToPath(new URL('../.claude/hooks', import.meta.url)));

/** Run the hook the way Claude Code does: JSON on stdin, decision (if any) on stdout. */
function runHook(command: string): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- same reasoning as scripts/verify.mjs: bash off PATH is the only portable spelling, and this is a local dev repo
  return execFileSync('bash', [resolve(HOOKS, 'one-way-to-verify.sh')], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  }).trim();
}

describe('one-way-to-verify.sh — npm run verify is the only way to run the checks', () => {
  const blocked = ['npx astro check', 'cd sub && npx tsc --noEmit', 'npx vitest run', 'npm test', 'npm run test'];
  const allowed = [
    'npm run verify',
    'npm run verify -- --all',
    'node scripts/verify.mjs --all',
    'npx vitest run tests/money.test.ts', // a single file while iterating is explicitly allowed
    'npm test -- tests/money.test.ts',
    'npx vitest run -t "refund"',
    'npm run lint', // 8s, and the documented way to confirm a phantom cached lint error
    'grep -rn "tsc --noEmit" scripts/',
  ];

  it.each(blocked)('blocks %s', (command) => {
    const out = runHook(command);
    expect(out, `expected a deny for: ${command}`).toContain('"permissionDecision": "deny"');
    expect(out).toContain('npm run verify');
  });

  it.each(allowed)('allows %s', (command) => {
    expect(runHook(command)).toBe('');
  });
});
