/**
 * **Only one settlement model may move money, and the other must not half-run.**
 *
 * The platform has two complete answers to "who holds the buyer's money": the custodial one it was
 * built for, and the split one PayMe's partner programme provides. The owner has not closed the
 * door on either (2026-08-19), so the custodial code stays whole — and the danger is not that it
 * exists but that it keeps RUNNING. A payout job quietly sending a seller money the processor
 * already sent him is not a bug anyone notices until the money is gone twice.
 *
 * So the modules stay, and every path that MOVES money asks first. These are the cases that keep
 * that true.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const { SETTLEMENT_MODEL, isCustodial, assertCustodial } = await import('../src/lib/settlement-model.js');

describe('the switch itself', () => {
  it('defaults to custodial, which is the fail-safe direction', () => {
    // Wrong in this direction stops a payout that should have run and somebody notices. Wrong the
    // other way pays twice and nobody does.
    expect(SETTLEMENT_MODEL).toBe('custodial');
    expect(isCustodial()).toBe(true);
  });

  it('treats anything that is not exactly "split" as custodial', async () => {
    // Unset, misspelled, empty — all must land on the safe side.
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/=== 'split'/);
    expect(src).toMatch(/'custodial'/);
  });

  it('permits the custodial operations while custodial', () => {
    expect(() => assertCustodial('runPayouts')).not.toThrow();
  });

  it('names the operation in the refusal, so a log says which one', () => {
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/\$\{what\}/);
    // And says WHY, because the person reading it at 2am did not write this file.
    expect(src).toMatch(/twice/);
  });
});

describe('every path that moves money to a seller asks first', () => {
  const GUARDED: [string, string][] = [
    ['src/lib/payout-run.ts', 'runPayouts'],
    ['src/lib/payouts.ts', 'recordAdjustment'],
  ];

  it.each(GUARDED)('%s guards %s', (file, fn) => {
    const src = readFileSync(file, 'utf8');
    expect(src, `${file} must import the guard`).toMatch(/assertCustodial/);
    // The guard must be INSIDE the function, not merely imported somewhere in the file.
    // Anchored on the DEFINITION, not the first mention — the file names these functions in its
    // own comments long before it defines them.
    const at = src.indexOf(`export async function ${fn}`);
    expect(at, `${fn} not found in ${file}`).toBeGreaterThan(-1);
    expect(src.slice(at, at + 1400), `${fn} must call assertCustodial before doing anything`).toMatch(/assertCustodial\(/);
  });

  it('throws rather than returning quietly, because a silent no-op reads as "nothing to pay"', () => {
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/throw new Error/);
    expect(src).not.toMatch(/return false;\s*\}\s*$/);
  });
});

describe('reading is deliberately NOT blocked', () => {
  it('leaves the planning function alone', () => {
    // An admin screen showing what WOULD be owed under the other model is harmless; blocking it
    // would turn a settings question into a broken page.
    const src = readFileSync('src/lib/payout-run.ts', 'utf8');
    const plan = src.slice(src.indexOf('export async function planPayouts'), src.indexOf('export async function runPayouts'));
    expect(plan).not.toMatch(/assertCustodial/);
  });
});
