import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  withinStatutoryWindow, autoApproved, returnShippingPayer, refundAmountAgorot,
  canMove, isOpen, handoverDeadlineISO, handoverExpired, autoRefundDueISO, dueForAutoRefund,
  responseDeadlineISO, responseOverdue, freezesPayout,
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
    for (const from of ['requested', 'approved', 'in_transit'] as ReturnStatus[]) {
      expect(canMove(from, 'disputed').ok, from).toBe(false);
    }
  });

  it('treats a repeat of the same status as a no-op, not an error', () => {
    // A second tab, or a retried request, must not 409.
    expect(canMove('approved', 'approved').ok).toBe(true);
  });

  it('lets nothing out of a closed case', () => {
    for (const terminal of ['rejected', 'refunded', 'expired'] as ReturnStatus[]) {
      expect(isOpen(terminal), terminal).toBe(false);
      for (const to of Object.keys(RETURN_TRANSITIONS) as ReturnStatus[]) {
        if (to === terminal) continue;
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

  it('covers every status the database allows', () => {
    // The CHECK in migration 0030 and this table must not drift — a status the machine has never
    // heard of would be un-transitionable and would strand a real case.
    const sql = fs.readFileSync('migrations/0030_returns.sql', 'utf8');
    const inCheck = [...sql.matchAll(/'(requested|approved|rejected|in_transit|received|refunded|disputed|expired)'/g)]
      .map((m) => m[1]!);
    for (const status of Object.keys(RETURN_TRANSITIONS)) {
      expect(inCheck, `${status} is in the state machine but not in the database CHECK`).toContain(status);
    }
    expect(new Set(inCheck).size).toBe(Object.keys(RETURN_TRANSITIONS).length);
  });
});
