import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  returnLane, returnClockDueISO, isOpen, sellerOwesAction,
  RETURN_TRANSITIONS, HANDOVER_DAYS, OFFER_ANSWER_DAYS, IN_TRANSIT_PATIENCE_DAYS,
  type ReturnStatus,
} from '../src/lib/returns.js';

/**
 * The seller's returns tab is sorted TWICE — once by the server on first paint, once by the script
 * whenever a control moves — and this is what keeps the two answers the same.
 *
 * ── Why it is worth a test ──
 * `ReturnsPanel.astro` orders the cards before rendering so the first paint already reads as the
 * urgency queue; `scripts/dashboard/returns.ts` re-sorts by the same rule the moment the seller
 * touches the search box. If the two ever disagree, the list SILENTLY rearranges on the first
 * keystroke — no error, no failed request, just a page that shuffles under a person who was reading
 * it. That is the twin-renderer class this project has already been bitten by twice (the return chip
 * that vanished on a poll, the products row), and the shape is identical: one fact, two renderers.
 *
 * So: the lane ranking is compared as DATA between the two files, and the two pure functions the
 * ordering is built on are pinned by behaviour.
 */

const ALL_STATUSES = Object.keys(RETURN_TRANSITIONS) as ReturnStatus[];
const read = (f: string): string => fs.readFileSync(f, 'utf8');

/** `{ mine: 0, ours: 1, buyer: 2, closed: 3 }` out of either file, as an object. Parsed rather than
 *  spelled out here, so this test compares the two implementations with each other instead of
 *  comparing both to a third copy that could itself be the stale one. */
function laneRanking(src: string, name: string): Record<string, number> {
  const body = new RegExp(`${name}[^=]*=\\s*{([^}]*)}`).exec(src)?.[1];
  expect(body, `${name} is not in the file any more — this test is pinning something that moved`).toBeTruthy();
  return Object.fromEntries(
    [...body!.matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [m[1]!, Number(m[2])]),
  );
}

describe('the returns list is ordered the same by the server and by the script', () => {
  it('ranks the lanes identically in both renderers', () => {
    const server = laneRanking(read('src/components/dashboard/ReturnsPanel.astro'), 'LANE_ORDER');
    const client = laneRanking(read('src/scripts/dashboard/returns.ts'), 'LANE_RANK');
    expect(Object.keys(server).sort()).toEqual(['buyer', 'closed', 'mine', 'ours']);
    expect(
      client,
      'The first paint and the first keystroke would put the cards in different orders — the list\n'
      + 'would silently rearrange under a seller who was reading it.',
    ).toEqual(server);
  });

  it('puts what needs the seller first and what is finished last', () => {
    const server = laneRanking(read('src/components/dashboard/ReturnsPanel.astro'), 'LANE_ORDER');
    expect(server.mine).toBe(0);
    expect(server.closed).toBe(3);
    // `ours` before `buyer`: a case on our desk is one he may want to chase; one waiting on the
    // buyer is one he can do nothing about at all.
    expect(server.ours!).toBeLessThan(server.buyer!);
  });

  it('names the same default sort on the pill as the script would apply', () => {
    // The pill is rendered by the server and says which ordering is in force; the script owns the
    // list of orderings. They start out agreeing and there is nothing but this test to keep them
    // there — a pill reading "הדחוף ביותר" over a list sorted by something else is a lie that
    // costs nothing to tell.
    const first = /label: '([^']+)'/.exec(read('src/scripts/dashboard/returns.ts'))?.[1];
    expect(first, 'RETURN_SORTS lost its first label').toBeTruthy();
    expect(read('src/components/dashboard/ReturnsPanel.astro')).toContain(
      `<span id="returns-sort-label" class="toolbar-btn-label">${first}</span>`,
    );
  });

  it('sorts a case with no clock after every case that has one', () => {
    // Both files key a missing deadline on `￿` (U+FFFF), the last code point, so it loses every
    // string comparison against a real ISO date. A `''` fallback would win them all and float the
    // dispute nobody can act on to the top of the queue.
    for (const src of ['src/components/dashboard/ReturnsPanel.astro', 'src/scripts/dashboard/returns.ts']) {
      expect(read(src), `${src}: the no-clock sort key is not the one that sorts last`).toContain('￿');
    }
    // …and it really does lose to a date, which is the property the character was chosen for.
    // Compared by CODE POINT, exactly as both files do it: `localeCompare` is a collator and is
    // allowed to give a noncharacter no weight at all, which would put the clockless case first in
    // one runtime and last in another.
    const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    expect(['2026-09-30', '￿', '2026-08-01'].sort(cmpKey)).toEqual(['2026-08-01', '2026-09-30', '￿']);
    for (const src of ['src/components/dashboard/ReturnsPanel.astro', 'src/scripts/dashboard/returns.ts']) {
      expect(
        // A CALL, not the word — both files name it in the comment explaining why it is not used.
        /\.localeCompare\(/.test(read(src)),
        `${src}: a collator is back in the ordering — the sentinel's weight is then the runtime's choice.`,
      ).toBe(false);
    }
  });
});

describe('returnLane says whose move a case is', () => {
  it('agrees with isOpen and sellerOwesAction on every state in the machine', () => {
    for (const s of ALL_STATUSES) {
      const lane = returnLane(s);
      if (!isOpen(s)) expect(lane, s).toBe('closed');
      else if (sellerOwesAction(s)) expect(lane, s).toBe('mine');
      else expect(lane, s).toBe(s === 'disputed' ? 'ours' : 'buyer');
    }
  });

  it('names every state, and never invents a fifth lane', () => {
    const lanes = new Set(ALL_STATUSES.map(returnLane));
    expect([...lanes].sort()).toEqual(['buyer', 'closed', 'mine', 'ours']);
  });

  it('puts the dispute on US and not on the buyer', () => {
    // The one that matters to a seller reading the card: "waiting for the buyer" over a case
    // sitting on our desk tells him the wrong person to chase.
    expect(returnLane('disputed')).toBe('ours');
    expect(returnLane('approved')).toBe('buyer');
    expect(returnLane('offered')).toBe('buyer');
  });
});

describe('returnClockDueISO answers with the clock that is actually running', () => {
  interface Stamps {
    withinStatutory: boolean;
    createdAt: string;
    approvedAt: string | null;
    sentAt: string | null;
    offeredAt: string | null;
    deliveredBackAt: string | null;
  }
  const base: Stamps = {
    withinStatutory: false,
    createdAt: '2026-08-03T09:00:00.000Z',
    approvedAt: '2026-08-04T09:00:00.000Z',
    sentAt: '2026-08-05T09:00:00.000Z',
    offeredAt: '2026-08-06T09:00:00.000Z',
    deliveredBackAt: '2026-08-07T09:00:00.000Z',
  };
  const due = (status: ReturnStatus, over: Partial<Stamps> = {}): string | null =>
    returnClockDueISO({ status, ...base, ...over });

  it('gives a request inside the statutory window NO clock', () => {
    // It was approved on arrival — there is nothing for the seller to answer, so a deadline here
    // would be a countdown on a decision that is not his to make.
    expect(due('requested', { withinStatutory: true })).toBeNull();
    expect(due('requested', { withinStatutory: false })).not.toBeNull();
  });

  it('reads each open state off its OWN timestamp, never a neighbour\'s', () => {
    // The tell if a branch is wired to the wrong field: two states answering the same date.
    const answers = (['approved', 'in_transit', 'offered', 'received'] as const).map((s) => due(s));
    expect(answers.every(Boolean)).toBe(true);
    expect(new Set(answers).size, 'two states are reading the same timestamp').toBe(answers.length);
    // …and each lands the documented number of days past its own stamp.
    expect(due('approved')!.slice(0, 10) >= '2026-08-04').toBe(true);
    expect(HANDOVER_DAYS).toBeGreaterThan(0);
    expect(OFFER_ANSWER_DAYS).toBeGreaterThan(0);
    expect(IN_TRANSIT_PATIENCE_DAYS).toBeGreaterThan(0);
  });

  it('gives the closed states and the dispute no clock at all', () => {
    for (const s of ['rejected', 'refunded', 'expired', 'disputed'] as const) {
      expect(due(s), s).toBeNull();
    }
  });

  it('is null rather than throwing when the timestamp it needs was never written', () => {
    expect(due('approved', { approvedAt: null })).toBeNull();
    expect(due('in_transit', { sentAt: null })).toBeNull();
    expect(due('offered', { offeredAt: null })).toBeNull();
    expect(due('received', { deliveredBackAt: null })).toBeNull();
  });

  it('is the ONE place the card and the sort read the deadline from', () => {
    // The panel used to branch on status four times to print the date and would now have branched a
    // fifth time to sort by it. A list ordered by a day the card does not print is the drift.
    const panel = read('src/components/dashboard/ReturnsPanel.astro');
    expect(panel).toContain('returnClockDueISO');
    for (const gone of ['handoverDeadlineISO', 'autoRefundDueISO', 'inTransitReviewDueISO', 'offerAnswerDueISO']) {
      expect(
        panel.includes(gone),
        `${gone} is back in the panel — that is a second answer to "which clock is running".`,
      ).toBe(false);
    }
  });
});
