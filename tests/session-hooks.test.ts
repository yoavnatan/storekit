import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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

/** Run a hook the way Claude Code does: the event's JSON on stdin, its output on stdout. */
function runHook(script: string, payload: unknown): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- same reasoning as scripts/verify.mjs: bash off PATH is the only portable spelling, and this is a local dev repo
  return execFileSync('bash', [resolve(HOOKS, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  }).trim();
}

const runVerifyHook = (command: string) => runHook('one-way-to-verify.sh', { tool_input: { command } });

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
    const out = runVerifyHook(command);
    expect(out, `expected a deny for: ${command}`).toContain('"permissionDecision": "deny"');
    expect(out).toContain('npm run verify');
  });

  it.each(allowed)('allows %s', (command) => {
    expect(runVerifyHook(command)).toBe('');
  });
});

/**
 * `money-rules-on-contact.sh` — the money rules, moved out of the always-read part of
 * AI_INSTRUCTIONS and delivered when a session actually edits money code (8 of the 40 sessions that
 * edited anything, 2026-08-04→09; the other four in five were carrying them for nothing).
 *
 * Two failure shapes, and both are silent, which is the whole reason this file exists:
 *  • The pattern misses a file — money code then gets written with no rules at all, and the
 *    always-read bullet no longer carries them. So the cases below include modules that DO NOT
 *    EXIST yet: the pattern has to match the vocabulary, not today's filenames.
 *  • The event name is wrong. It was built on `PreToolUse` first, which would have been better —
 *    before the edit rather than after — and PreToolUse's hookSpecificOutput has no
 *    `additionalContext` field (code.claude.com/docs/en/hooks). The hook ran, emitted valid JSON,
 *    and the field was dropped on the floor. Nothing about that is visible from inside a session,
 *    so the event name is asserted here.
 */
describe('money-rules-on-contact.sh — the money rules arrive when money code is touched', () => {
  let n = 0;
  const brief = (file: string) =>
    runHook('money-rules-on-contact.sh', {
      session_id: `test-money-hook-${process.pid}-${n++}`,
      tool_input: { file_path: file },
    });

  const onSurface = [
    '/repo/src/lib/money.ts',
    '/repo/src/lib/orders.ts',
    '/repo/src/lib/refund-owed.ts',
    '/repo/src/pages/api/checkout.ts',
    '/repo/src/pages/api/seller/anything.ts', // every API route counts: they are where money moves
    '/repo/src/lib/coupon-redemption.ts', // does not exist yet — the case the pattern is FOR
    '/repo/src/lib/seller-invoice.ts', // ditto
    '/repo/src/components/PriceTag.astro', // a surface that RENDERS a price is still a money surface
  ];
  const offSurface = [
    '/repo/src/components/Header.astro',
    '/repo/src/styles/pages/store.css',
    '/repo/src/lib/toast.ts',
    '/repo/tests/cart.test.ts', // tests are not the surface; the guard scans already cover them
  ];

  it.each(onSurface)('briefs on %s', (file) => {
    const out = brief(file);
    expect(out, `expected the money rules for: ${file}`).toContain('additionalContext');
    expect(out).toContain('lib/money.ts');
  });

  it.each(offSurface)('stays silent on %s', (file) => {
    expect(brief(file)).toBe('');
  });

  it('names PostToolUse — the only Edit/Write event that carries additionalContext', () => {
    const out = brief('/repo/src/lib/money.ts');
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('PostToolUse');
    // And the file itself must not drift back: the shape is easy to copy from a PreToolUse hook.
    const src = readFileSync(resolve(HOOKS, 'money-rules-on-contact.sh'), 'utf8');
    expect(src).not.toContain('hookEventName:"PreToolUse"');
  });

  it('briefs once per session, not once per edit', () => {
    const session = `test-money-hook-once-${process.pid}`;
    const payload = (file: string) => ({ session_id: session, tool_input: { file_path: file } });
    expect(runHook('money-rules-on-contact.sh', payload('/repo/src/lib/money.ts'))).toContain('additionalContext');
    expect(runHook('money-rules-on-contact.sh', payload('/repo/src/lib/orders.ts'))).toBe('');
  });

  it('still names every module the always-read bullet points at', () => {
    const rules = readFileSync(resolve(HOOKS, 'money-rules-on-contact.sh'), 'utf8');
    for (const module of [
      'lib/money.ts',
      'lib/business-day.ts',
      'lib/order-status-rules.ts',
      'lib/orders.ts#countsAsRevenue',
      'lib/refund-owed.ts',
      'lib/checkout-idempotency.ts',
      'lib/money-events.ts',
      'tests/reporting-invariants.test.ts',
    ]) {
      expect(rules, `the briefing dropped ${module}`).toContain(module);
    }
  });
});
