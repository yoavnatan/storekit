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
  it('ships defaulting to SPLIT since 2026-08-19', () => {
    // Asserted from the SOURCE, not the runtime value: the suite pins the model to custodial on
    // purpose (tests/helpers/db-setup.ts) so the custodial machinery stays covered and reachable.
    // Reading the line is what makes the shipped default a fact rather than a memory.
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/=== 'custodial'\) \? 'custodial' : 'split'/);
  });

  it('runs the suite as custodial, so the model we may go back to stays tested', () => {
    expect(SETTLEMENT_MODEL).toBe('custodial');
    expect(isCustodial()).toBe(true);
  });

  it('goes back on one explicit word, because the decision is not final', () => {
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/=== 'custodial'/);
  });

  it('permits the custodial money moves while custodial', () => {
    expect(() => assertCustodial('runPayouts')).not.toThrow();
  });

  it('refuses them by name, and says why, when the model is split', () => {
    // The message is read by whoever finds a payout job that stopped, and they were not in this
    // conversation: it has to name the operation and say that paying again sends money twice.
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/twice/);
    expect(src).toMatch(/\$\{what\}/);
  });

  it('records that the fail-safe direction INVERTED with the flip', () => {
    // While custodial was the default, a missing value stopped a payout and somebody noticed. Now
    // it disables one. That is only acceptable while nothing is custodial in production, and the
    // file has to say so — the next person to read it will not have been in the conversation.
    const src = readFileSync('src/lib/settlement-model.ts', 'utf8');
    expect(src).toMatch(/fail-safe direction inverted/i);
    expect(src).toMatch(/set the variable explicitly/i);
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
