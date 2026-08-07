import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MONEY_EVENT_TYPES, MONEY_EVENT_LABELS } from '../src/lib/money-event-types.js';

/**
 * **Money that is OWED, and the surfaces that have to know about it.**
 *
 * `money-guards.test.ts` scans the tree for the rules about money that MOVES — one definition of
 * revenue, one calendar, one rounding, an idempotency key and a journal entry on every charge. This
 * file scans it for the rule one level along, which the 2026-08-07 audit of this area was about:
 *
 *   **whenever money has moved and the purchase behind it has not, something must SAY SO —
 *   in the journal, and on a screen.**
 *
 * That is the class, and it is a class rather than a bug because every instance looked fine from
 * inside the code that caused it. A seller cancelling a paid order wrote a status row and restored
 * the stock, both correct; the captured money simply stayed with us and no total anywhere counted
 * it. A capture that never completed left an order 'pending' forever with stock off the shelf, and
 * nothing looked for one. An authorization whose order write failed left a hold with no order —
 * which is exactly what the UNIQUE constraint on `payment_ref` produced on every multi-store cart
 * until migration 0017, undetected for as long as the schema had existed.
 *
 * Like the guards it sits beside, everything here scans the TREE rather than a list of files, so a
 * module that does not exist yet is already covered.
 */

const ROOTS = ['src/lib', 'src/pages/api'];

function walk(dir: string): string[] {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return entry.isFile() && /\.ts$/.test(entry.name) ? [rel] : [];
  });
}

/** Source with comments stripped — a rule quoted in a comment is documentation, not a violation. */
function code(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const ALL_FILES = ROOTS.flatMap(walk).filter((f) => !f.endsWith('.d.ts'));
const SRC = new Map(ALL_FILES.map((f) => [f, code(f)]));

describe('the guard is looking at the tree', () => {
  it('found the roots and a plausible number of files', () => {
    // A scan-based guard that silently matches nothing is worse than no guard at all.
    expect(ALL_FILES.length).toBeGreaterThan(80);
    for (const root of ROOTS) {
      expect(ALL_FILES.some((f) => f.startsWith(root)), `${root} produced no files — was it renamed?`).toBe(true);
    }
  });
});

describe('a status move that undoes a paid purchase records what is owed', () => {
  /**
   * Every module that writes an order's shipping status. The refund obligation is created exactly
   * there and nowhere else, so that is where the rule has to hold — and it is found by scanning for
   * the write rather than by naming the route, because the next one will be a carrier webhook.
   *
   * `lib/orders.ts` is excluded because it DEFINES `updateOrder`: it is the mechanism, not a caller
   * deciding to move a status, and there is nothing there for it to owe.
   */
  const STATUS_WRITERS = ALL_FILES.filter((f) => f !== 'src/lib/orders.ts'
    && /updateOrder\(/.test(SRC.get(f) ?? '')
    && /shippingStatus/.test(SRC.get(f) ?? ''));

  it('there is at least one, so this is not vacuously passing', () => {
    expect(STATUS_WRITERS.length).toBeGreaterThan(0);
  });

  it('each one goes through refund-owed.ts rather than deciding for itself', () => {
    // Per CALL SITE, not per file: `checkout.ts` moves a status in two places and they owe opposite
    // things. `failCapture` cancels orders whose capture FAILED and sets `paymentStatus: 'failed'`
    // in the same call — that pair IS the statement "no money was taken", so it owes nothing and
    // must not pretend otherwise. `markOrdersPaid`, three lines away, is the other half.
    for (const file of STATUS_WRITERS) {
      const src = SRC.get(file)!;
      for (const match of src.matchAll(/updateOrder\(/g)) {
        const call = src.slice(match.index, match.index + 200);
        if (!/shippingStatus/.test(call)) continue;
        if (/paymentStatus:\s*'failed'/.test(call)) continue;
        const vicinity = src.slice(match.index, match.index + 2000);
        expect(vicinity.includes('recordRefundOwed'),
          `${file}: moves an order's shipping status near "${call.slice(0, 70).replace(/\s+/g, ' ')}" without calling recordRefundOwed() from lib/refund-owed.ts — a cancelled PAID order leaves the buyer's money with us and no screen says so`,
        ).toBe(true);
      }
    }
  });

  it('nobody decides "money is owed" by testing for the word cancelled', () => {
    // Same reasoning as `countsAsRevenue`: a status is a row in `order-status-rules.ts`, so a future
    // `returned` or `refused` must inherit this answer by filling that row in — never by someone
    // remembering that a second `if` exists somewhere.
    for (const [file, src] of SRC) {
      if (file.endsWith('lib/order-status-rules.ts') || file.endsWith('lib/refund-owed.ts')) continue;
      expect(src, `${file}: use createsRefundObligation() from lib/refund-owed.ts — a refund rule written against 'cancelled' silently skips every status added after it`)
        .not.toMatch(/refund\w*\s*=\s*[^;]*===\s*'cancelled'/i);
    }
  });
});

describe('every state where money moved and the purchase did not is reported somewhere', () => {
  const reconcile = SRC.get('src/lib/reconcile.ts') ?? '';

  it('the reconciliation compares the orders against the JOURNAL, not only against themselves', () => {
    // The arithmetic checks read the order tables by two routes, so neither can see money that moved
    // with no row behind it. `money_events` is the independent record — written by the code that
    // touched the gateway, at the moment it touched it — and it is the only second opinion there is.
    expect(reconcile, 'lib/reconcile.ts must query money_events — without it, no check here can see a charge with no order behind it')
      .toMatch(/money_events/);
  });

  it('names each of the three states the audit found', () => {
    // Each one was reachable before its check existed. They are asserted by the identifiers rather
    // than by their Hebrew wording, so the copy can be improved without silencing the guard.
    for (const finding of ['refundOwedOutstanding', 'stuckPending', 'chargeWithNoOrder']) {
      // Declared AND reached. A check that exists and is never pushed reports nothing, and a
      // substring match would have been satisfied by a renamed function that nothing calls.
      expect(new RegExp(`function ${finding}\\(`).test(reconcile),
        `lib/reconcile.ts lost the ${finding} builder — one of the three ways money and the screens part company`).toBe(true);
      expect(new RegExp(`push\\(${finding}\\(`).test(reconcile),
        `lib/reconcile.ts declares ${finding} but never pushes it — the check runs and reports nothing`).toBe(true);
    }
  });

  it('reports an unpaid obligation as an error, never as a warning', () => {
    // A warning is "look at this when you can". Money belonging to a real person who has not been
    // given it back is not that.
    const block = /function refundOwedOutstanding[\s\S]*?\n}/.exec(reconcile)?.[0] ?? '';
    expect(block).toContain("severity: 'error'");
  });

  it('the admin dashboard actually renders the reconciliation', () => {
    // A check nobody sees is a check that does not exist. It runs on every render of the tab that
    // shows it rather than behind a button, for the same reason.
    const page = fs.readFileSync(path.join(process.cwd(), 'src/pages/admin/index.astro'), 'utf8');
    expect(page).toMatch(/reconcilePlatform\(/);
    expect(page).toMatch(/reconciliation=\{/);
  });
});

describe('the money vocabulary stays complete', () => {
  it('every event type has a Hebrew label, because the search matches the label', () => {
    // The admin's free-text box resolves a Hebrew word to a `type` before the query runs
    // (moneylog-search.ts). A type with no label is a type nobody can search for by the word on its
    // own chip.
    for (const type of MONEY_EVENT_TYPES) {
      expect(MONEY_EVENT_LABELS[type], `${type} has no Hebrew label`).toBeTruthy();
    }
  });

  it('every event type has a tone on the panel that renders it', () => {
    // TypeScript already requires this (the map is a Record over the union), and it is asserted here
    // as well because the compiler's version of the rule is invisible to someone reading the guards.
    const panel = fs.readFileSync(path.join(process.cwd(), 'src/components/admin/AdminMoneyLogPanel.astro'), 'utf8');
    for (const type of MONEY_EVENT_TYPES) {
      expect(panel, `${type} has no tone in AdminMoneyLogPanel`).toContain(`${type}:`);
    }
  });

  it('is written by somebody, or explicitly waiting on the payment provider', () => {
    // A vocabulary word nothing ever writes is either dead or a promise. `refund_settled` is the
    // second: it needs the provider's refund call and no provider is chosen (GO_LIVE §3), and its
    // absence is exactly what keeps every obligation open instead of quietly closing itself. Listed
    // here so that stays a decision rather than becoming an oversight.
    const PROVIDER_BLOCKED = new Set(['refund_settled']);
    // A WRITE, not a mention: `reconcile.ts` names `refund_settled` in the SQL that looks for one,
    // which is the opposite of writing it. `type: '…'` is the shape `recordMoneyEvent` takes.
    const writers = [...SRC.values()].join('\n');
    const isWritten = (type: string) => new RegExp(`type:\\s*'${type}'`).test(writers);
    for (const type of MONEY_EVENT_TYPES) {
      if (PROVIDER_BLOCKED.has(type)) {
        expect(isWritten(type), `${type} is listed as provider-blocked but something writes it now — take it off the list`).toBe(false);
        continue;
      }
      expect(isWritten(type), `no code writes ${type} — either something should, or it belongs in PROVIDER_BLOCKED with the reason`).toBe(true);
    }
  });
});

describe('a failure after the money is taken is never silent', () => {
  /** The checkout is the one handler with a committed-and-then-failed window. */
  const checkout = SRC.get('src/pages/api/checkout.ts') ?? '';

  it('exists, so the assertions below are looking at something', () => {
    expect(checkout).toMatch(/paymentProvider\.capture/);
  });

  /**
   * Calls that report their OWN failures internally, so an empty `.catch` at the call site is
   * genuinely nothing being lost. This list is the escape hatch, and it is deliberately a list of
   * two words with a reason each rather than a rule: anything added to it is a claim someone has to
   * make out loud, which is what makes "we swallowed it" a decision instead of a habit.
   */
  const SELF_LOGGING = ['sendOrderConfirmationEmails'];

  it('has no bare swallow left in the post-capture block', () => {
    // Everything after the capture runs on money that is already gone: the seller notification, the
    // stock alerts, the cart clear, the confirmation mail. Failing any of them must not undo the
    // purchase — and must not vanish either. `.catch(() => {})` with nothing inside it is the shape
    // that made "the capture succeeded and the seller was never told" produce no trace anywhere.
    const post = checkout.slice(checkout.indexOf('committed = true'));
    for (const match of post.matchAll(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/g)) {
      const preceding = post.slice(Math.max(0, match.index - 300), match.index);
      expect(SELF_LOGGING.some((fn) => preceding.includes(fn)),
        `src/pages/api/checkout.ts: a post-capture failure near "${preceding.slice(-60).trim()}" is swallowed with no trace — log it, or add its call to SELF_LOGGING with the reason it already reports itself`,
      ).toBe(true);
    }
  });

  it('logs the seller notification failure rather than only ignoring it', () => {
    expect(checkout).toMatch(/notify:new_order/);
  });
});
