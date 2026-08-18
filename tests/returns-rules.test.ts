import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  withinStatutoryWindow, autoApproved, returnShippingPayer, refundAmountAgorot,
  canMove, isOpen, handoverDeadlineISO, handoverExpired, autoRefundDueISO, dueForAutoRefund,
  responseDeadlineISO, responseOverdue, freezesPayout,
  canEscalate, inTransitStale, inTransitReviewDueISO, offerUnanswered, offerAnswerDueISO,
  RETURN_TRANSITIONS, RESPONSE_BUSINESS_DAYS, HANDOVER_DAYS, RECEIPT_RESPONSE_BUSINESS_DAYS,
  type ReturnStatus,
} from '../src/lib/returns.js';
import { STATUTORY_RETURN_DAYS, SHIP_DEADLINE_BUSINESS_DAYS } from '../src/lib/payout-schedule.js';

/**
 * The returns mechanism's rules, asserted against the OWNER'S decisions rather than against the
 * implementation — `docs/returns-policy-decisions.md` is what these encode, and three of them are
 * corrections he made to a first version that was wrong. Those three have a test each, named for
 * what went wrong, because they are the ones a future session is most likely to "simplify" back.
 */

const order = (over: Partial<{ totalAgorot: number; shippingAgorot: number; deliveredAt: string }> = {}) => ({
  totalAgorot: 27_900,
  shippingAgorot: 3_000,
  ...over,
});

describe('the statutory window decides who may refuse', () => {
  it('is 14 days from DELIVERY, inclusive of the last day', () => {
    const o = order({ deliveredAt: '2026-08-01T10:00:00.000Z' });
    expect(withinStatutoryWindow(o, '2026-08-15')).toBe(true);   // day 14
    expect(withinStatutoryWindow(o, '2026-08-16')).toBe(false);  // day 15
    expect(STATUTORY_RETURN_DAYS).toBe(14);
  });

  it('treats an order with no delivery date as INSIDE the window', () => {
    // The conservative direction on purpose: a missing timestamp is a gap in OUR records, and
    // refusing a buyer their statutory right on the strength of one is the error that cannot be
    // undone later.
    expect(withinStatutoryWindow(order(), '2030-01-01')).toBe(true);
  });

  it('inside the window the request is approved on arrival — the seller has no say', () => {
    expect(autoApproved(true)).toBe(true);
    expect(autoApproved(false)).toBe(false);
  });
});

describe("the seller's silence — the owner's correction, and it points two ways", () => {
  it('OUTSIDE the window, an unanswered request is REFUSED, not granted', () => {
    // The first version auto-approved here. Incoherent: outside the window the seller owes nothing,
    // so his silence cannot be made to mean consent.
    expect(responseOverdue('requested', false, '2026-08-03T09:00:00.000Z', '2026-08-06')).toBe(true);
    expect(responseOverdue('requested', false, '2026-08-03T09:00:00.000Z', '2026-08-05')).toBe(false);
  });

  it('INSIDE the window his silence is never asked about at all', () => {
    // Nothing to answer — `autoApproved` already granted it the moment it was opened.
    expect(responseOverdue('requested', true, '2026-01-01T09:00:00.000Z', '2030-01-01')).toBe(false);
  });

  it('gives him the same 2 business days the platform already promises for shipping', () => {
    expect(RESPONSE_BUSINESS_DAYS).toBe(SHIP_DEADLINE_BUSINESS_DAYS);
    expect(responseDeadlineISO('2026-08-03T09:00:00.000Z')).toBe('2026-08-05');
  });
});

describe('the automatic refund clock runs from ARRIVAL — the second correction', () => {
  it('starts when the parcel reaches the seller, not when the request was made', () => {
    expect(autoRefundDueISO('2026-08-10T12:00:00.000Z')).toBe('2026-08-12');
    expect(RECEIPT_RESPONSE_BUSINESS_DAYS).toBe(2);
  });

  it('is due on the day itself, and not before', () => {
    expect(dueForAutoRefund('received', '2026-08-10T12:00:00.000Z', '2026-08-12')).toBe(true);
    expect(dueForAutoRefund('received', '2026-08-10T12:00:00.000Z', '2026-08-11')).toBe(false);
  });

  it('never fires on a parcel that has not arrived — a slow post refunds nobody', () => {
    // This is the whole point of the correction: a clock counted from the request would pay a buyer
    // while the parcel was still in transit, or because the seller was away.
    expect(dueForAutoRefund('in_transit', null, '2030-01-01')).toBe(false);
    expect(dueForAutoRefund('approved', null, '2030-01-01')).toBe(false);
  });

  it('is stopped by a dispute — silence is not an answer, but an answer is', () => {
    expect(dueForAutoRefund('disputed', '2026-08-10T12:00:00.000Z', '2030-01-01')).toBe(false);
  });
});

describe('the money', () => {
  it('refunds the delivery charge only when the fault was the seller’s', () => {
    expect(refundAmountAgorot(order(), 'changed_mind')).toBe(24_900);
    for (const reason of ['damaged', 'wrong_item', 'not_arrived'] as const) {
      expect(refundAmountAgorot(order(), reason), reason).toBe(27_900);
    }
  });

  it('never deducts a cancellation fee, which the regulations would permit', () => {
    // 5% of 27,900 agorot is 1,395 — the owner waived it in every case, so the full goods value
    // comes back and there is deliberately no parameter through which a fee could return.
    expect(refundAmountAgorot(order(), 'changed_mind')).toBe(order().totalAgorot - order().shippingAgorot);
  });

  it('cannot go negative when shipping exceeds the total', () => {
    expect(refundAmountAgorot({ totalAgorot: 1_000, shippingAgorot: 3_000 }, 'changed_mind')).toBe(0);
  });

  it('puts return postage on the buyer only when they simply changed their mind', () => {
    expect(returnShippingPayer('changed_mind')).toBe('buyer');
    for (const reason of ['damaged', 'wrong_item', 'not_arrived'] as const) {
      expect(returnShippingPayer(reason), reason).toBe('seller');
    }
  });
});

describe('the handover window releases money and never deletes a right', () => {
  it('is 7 days from approval', () => {
    expect(HANDOVER_DAYS).toBe(7);
    expect(handoverDeadlineISO('2026-08-01T08:00:00.000Z')).toBe('2026-08-08');
  });

  it('expires the day AFTER the deadline, not on it', () => {
    expect(handoverExpired('2026-08-01T08:00:00.000Z', '2026-08-08')).toBe(false);
    expect(handoverExpired('2026-08-01T08:00:00.000Z', '2026-08-09')).toBe(true);
  });

  it('has no opinion before approval', () => {
    expect(handoverDeadlineISO(null)).toBeNull();
    expect(handoverExpired(null, '2030-01-01')).toBe(false);
  });

  it('leaves `expired` terminal — a late parcel is settled by clawback, not by this table', () => {
    expect(RETURN_TRANSITIONS.expired).toEqual([]);
  });

  it('lets an unanswered offer close, instead of freezing the case forever', () => {
    expect(canMove('offered', 'expired').ok).toBe(true);
    const offeredAt = '2026-08-03T09:00:00.000Z';
    expect(offerUnanswered(offeredAt, '2026-08-09')).toBe(false);
    expect(offerUnanswered(offeredAt, '2026-08-11')).toBe(true);
    expect(offerUnanswered(null, '2026-08-30')).toBe(false);
    // The date the seller is shown is the same one the job acts on — never a second calculation.
    expect(offerAnswerDueISO(offeredAt)).toBe('2026-08-10');
    expect(offerAnswerDueISO(null)).toBe(null);
  });

  it('waits a fortnight on a declared-sent parcel before a person looks at it', () => {
    const sentAt = '2026-08-03T09:00:00.000Z';
    expect(inTransitStale(sentAt, '2026-08-16')).toBe(false);
    expect(inTransitStale(sentAt, '2026-08-17')).toBe(true);
    expect(inTransitStale(null, '2026-09-30')).toBe(false);
    expect(inTransitReviewDueISO(sentAt)).toBe('2026-08-17');
    expect(inTransitReviewDueISO(null)).toBe(null);
  });
});

describe('the state machine', () => {
  it('refunds nothing that never reached the seller or an admin', () => {
    for (const from of ['requested', 'approved', 'in_transit'] as ReturnStatus[]) {
      expect(canMove(from, 'refunded').ok, from).toBe(false);
    }
    expect(canMove('received', 'refunded').ok).toBe(true);
    expect(canMove('disputed', 'refunded').ok).toBe(true);
  });

  it('lets a seller dispute only once he actually has the parcel', () => {
    expect(canMove('received', 'disputed').ok).toBe(true);
    // `in_transit` is NOT in this list any more, and the reason is not a relaxation. Nobody disputes
    // from there — the daily sweep does, after `IN_TRANSIT_PATIENCE_DAYS`, when the buyer has said he
    // sent it and no proof ever arrived. What this pin protects is unchanged: a SELLER cannot call a
    // parcel empty before he has one in his hands.
    for (const from of ['requested', 'approved'] as ReturnStatus[]) {
      expect(canMove(from, 'disputed').ok, from).toBe(false);
    }
  });

  it('gives a declared-sent parcel to a person, and never to a clock in the seller\'s favour', () => {
    // The hole the owner found by walking the scenarios: `in_transit` used to lead to `expired`, so a
    // buyer who had said he posted it lost the case on day 7 while the seller kept the money and the
    // goods. Both halves are pinned — no expiry out of `in_transit`, and no refund either, because a
    // buyer's word is not proof (his rule: a tracked label with a webhook, or a handover in the shop).
    expect(canMove('in_transit', 'expired').ok).toBe(false);
    expect(canMove('in_transit', 'refunded').ok).toBe(false);
    expect(canMove('in_transit', 'disputed').ok).toBe(true);
    expect(canMove('in_transit', 'received').ok).toBe(true);
  });

  it('takes an in-store handover straight to `received`', () => {
    // A shop that offers collection in person must also accept returns in person (owner, 2026-08-17).
    // The buyer hands it over the counter, so there is no parcel and no `in_transit` — and the seller
    // marking it received with the buyer in front of him is the strongest proof in the mechanism.
    expect(canMove('approved', 'received').ok).toBe(true);
  });

  it('lets the buyer ask us to look at a refusal — and keeps `rejected` CLOSED while he can', () => {
    expect(canMove('rejected', 'disputed').ok).toBe(true);
    // The trap this pins: `isOpen` was derived from the transition table, so this one new arrow would
    // have reopened every refused case in the system — freezing those sellers' payouts and filling
    // both queues with cases nobody is waiting on. "Can still move" is not "is still open".
    expect(isOpen('rejected')).toBe(false);
    expect(freezesPayout('rejected')).toBe(false);
    // And a refusal is the only closed state he may escalate from.
    for (const terminal of ['refunded', 'expired'] as ReturnStatus[]) {
      expect(canMove(terminal, 'disputed').ok, terminal).toBe(false);
    }
  });

  it('closes an escalation window, so a finished case cannot reopen a year later', () => {
    const rejectedAt = '2026-08-01T09:00:00.000Z';
    expect(canEscalate('rejected', rejectedAt, '2026-08-10')).toBe(true);
    expect(canEscalate('rejected', rejectedAt, '2026-08-15')).toBe(true);
    expect(canEscalate('rejected', rejectedAt, '2026-08-16')).toBe(false);
    // Nothing to escalate from anywhere else, and nothing to escalate without a refusal date.
    expect(canEscalate('received', rejectedAt, '2026-08-02')).toBe(false);
    expect(canEscalate('rejected', null, '2026-08-02')).toBe(false);
  });

  it('runs a clock on every open state — an open case always waits for somebody', () => {
    // The two holes the owner's sweep found were both a MISSING clock, not a wrong one: `offered` had
    // none at all (the case and the seller's payout froze forever if the buyer never answered), and
    // `in_transit` had the wrong one. So the pin is on the property rather than on the two states —
    // a state added later with no clock is the same bug again, and this fails instead of shipping it.
    const CLOCKED: Record<string, boolean> = {
      requested: true,   // responseOverdue
      approved: true,    // handoverExpired
      offered: true,     // offerUnanswered
      in_transit: true,  // inTransitStale
      received: true,    // dueForAutoRefund
      disputed: false,   // a person is holding it, and a person is the clock
    };
    for (const status of Object.keys(RETURN_TRANSITIONS) as ReturnStatus[]) {
      if (!isOpen(status)) continue;
      expect(status in CLOCKED, `${status} has no entry in CLOCKED — does it have a clock?`).toBe(true);
    }
  });

  it('treats a repeat of the same status as a no-op, not an error', () => {
    // A second tab, or a retried request, must not 409.
    expect(canMove('approved', 'approved').ok).toBe(true);
  });

  it('lets nothing out of a closed case', () => {
    // `rejected → disputed` is the ONE exception, and it is the buyer's escalation — allowed for a
    // fortnight, and it is why this loop skips that single pair rather than dropping `rejected`: the
    // other eight doors out of a refusal must stay shut.
    for (const terminal of ['rejected', 'refunded', 'expired'] as ReturnStatus[]) {
      expect(isOpen(terminal), terminal).toBe(false);
      for (const to of Object.keys(RETURN_TRANSITIONS) as ReturnStatus[]) {
        if (to === terminal) continue;
        if (terminal === 'rejected' && to === 'disputed') continue;
        expect(canMove(terminal, to).ok, `${terminal} → ${to}`).toBe(false);
      }
    }
  });

  it('freezes the payout for exactly the open states', () => {
    for (const status of Object.keys(RETURN_TRANSITIONS) as ReturnStatus[]) {
      expect(freezesPayout(status), status).toBe(isOpen(status));
    }
    // The one worth naming: we know LEAST about whose money it is here.
    expect(freezesPayout('disputed')).toBe(true);
  });

  it('an offer can only be made from an APPROVED return', () => {
    // Declining an offer returns the case to `approved`. Offering from `requested` would therefore
    // hand the buyer an approval the seller may still have been entitled to withhold — an offer is a
    // shortcut through a return that is already granted, never a way around the decision.
    expect(canMove('requested', 'offered').ok).toBe(false);
    expect(canMove('approved', 'offered').ok).toBe(true);
  });

  it('leaves an offer answerable only by accepting or declining', () => {
    // Two answers the BUYER may give, and no third — anything else would be a state he was never
    // asked about. `expired` is not a third answer: it is the sweep closing an offer nobody replied
    // to, which is what stopped the case and the seller's payout freezing forever, and no screen
    // anywhere offers it as a choice.
    expect(RETURN_TRANSITIONS.offered).toEqual(['refunded', 'approved', 'expired']);
  });

  it('covers every status the database allows', () => {
    // The CHECK and this table must not drift — a status the machine has never heard of would be
    // un-transitionable and would strand a real case, and one the CHECK does not allow is a write
    // that throws at 3am.
    //
    // Reads the LAST migration that redefines the constraint rather than naming 0030: the vocabulary
    // moved when `offered` was added (0035), and a test pinned to the file that happened to declare
    // it first stops checking anything the moment it is extended — silently, which is the failure
    // mode a guard must not have.
    const files = fs.readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
    let statuses: string[] = [];
    for (const f of files) {
      const sql = fs.readFileSync(`migrations/${f}`, 'utf8');
      const check = [...sql.matchAll(/status\s+IN\s*\(([^)]*)\)/gi)]
        .filter((m) => /requested/.test(m[1]!))
        .pop();
      if (check) statuses = [...check[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    }
    expect(statuses.length, 'no return-status CHECK found in migrations/').toBeGreaterThan(0);
    for (const status of Object.keys(RETURN_TRANSITIONS)) {
      expect(statuses, `${status} is in the state machine but not in the database CHECK`).toContain(status);
    }
    expect(new Set(statuses).size).toBe(Object.keys(RETURN_TRANSITIONS).length);
  });
});
