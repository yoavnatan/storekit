/**
 * **Who holds the buyer's money between the sale and the seller being paid.**
 *
 * The platform has two complete answers to that, and only one may be live at a time. This module
 * is the single place that says which — so the other one cannot half-run.
 *
 * ── The two models ──
 *
 * **`custodial`** — what the codebase was built for (agent model, 2026-08-10). One charge for the
 * whole cart lands with US; `payout-hold.ts` decides when a slice is releasable, `payout-run.ts`
 * pays each seller on a schedule, `seller-balance.ts` derives what is owed, and
 * `seller_ledger_adjustments` carries clawbacks. It also drags the regulatory weight: holding other
 * people's money is `מאגד` activity under Israeli law, covered by a size exemption with a ceiling,
 * a notice to the ISA and a standing disclosure (GO_LIVE §3.0).
 *
 * **`split`** — what PayMe's partner programme does (owner, 2026-08-19, confirmed against their
 * multi-capture documentation). The buyer authorizes ONCE and the money is captured to each seller's
 * own account directly; our commission and any fixed amount are allocated at the same moment. We
 * never hold a shekel that is not ours, so the whole payout layer — and the whole regulatory layer —
 * simply does not apply.
 *
 * ── Why a switch and not a deletion ──
 *
 * The owner has not closed the door on `custodial` (2026-08-19: *"יש עוד סיכוי מסויים שכן אבחר
 * בלהחזיק את הכסף לבד"*), and the payout modules are correct, tested and expensive to rebuild. But
 * dead code that still RUNS is worse than either keeping or deleting it: a payout job quietly
 * paying sellers money that PayMe already sent them is not a bug anyone would notice until the
 * money was gone twice.
 *
 * So the modules stay whole, and the entry points that MOVE money ask this first and refuse loudly
 * when the answer is `split`. Reading is left alone deliberately — an admin screen showing what
 * would be owed under the other model is harmless, and blocking it would turn a settings question
 * into a broken page.
 *
 * ⚠️ `custodial` is still the default, because nothing is signed. Flipping it is one value here.
 */

export type SettlementModel = 'custodial' | 'split';

/**
 * Derived from configuration, not from a database row: this decides whether a job may move money,
 * and a value that can change while the process runs is a value that can change BETWEEN a plan and
 * the payment it authorised. Read once at import, same answer for the life of the process.
 *
 * `SETTLEMENT_MODEL=split` in the environment switches it. Anything else — unset, misspelled,
 * empty — is `custodial`, which is the fail-safe direction: the wrong answer there stops a payout
 * that should have run and someone notices, while the wrong answer the other way pays money twice
 * and nobody does.
 */
export const SETTLEMENT_MODEL: SettlementModel =
  (typeof process !== 'undefined' && process.env?.SETTLEMENT_MODEL === 'split') ? 'split' : 'custodial';

/** Does this deployment hold buyers' money on the sellers' behalf? */
export function isCustodial(): boolean {
  return SETTLEMENT_MODEL === 'custodial';
}

/**
 * Guard for any code path that MOVES money to a seller. Throws rather than returning false: these
 * are called from a job and from an admin action, and a silent no-op in either would look exactly
 * like "there was nothing to pay".
 *
 * @param what The operation being refused, named in the error so the log says which one.
 */
export function assertCustodial(what: string): void {
  if (isCustodial()) return;
  throw new Error(
    `${what} is a custodial-model operation and this deployment runs the SPLIT model — ` +
    'the processor pays each seller directly, so paying them again from here would send the money twice. ' +
    'See lib/settlement-model.ts.',
  );
}
