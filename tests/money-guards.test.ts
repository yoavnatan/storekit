import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The rules that keep working on code that does not exist yet.
 *
 * Every other test in this repo checks behaviour that was written. These check that
 * FUTURE code cannot quietly reintroduce a bug that has already been fixed once —
 * and they do it by scanning the tree rather than by naming files, because a
 * hand-maintained list only covers what someone remembered to add to it. A brand new
 * `src/lib/payouts.ts` is inside these guards the moment it is created, with nobody
 * having to think about it.
 *
 * Each rule below cost real money-reporting bugs to learn:
 *   • three different answers to "which calendar day is this"
 *   • cancelled orders counted as revenue for seven sessions, because each module
 *     carried its own copy of the rule
 *   • float tails accumulating through `+=` on prices
 *
 * A guard is only worth having if its failure message tells the next person what to
 * do instead. Every expectation here names the replacement.
 *
 * ADDING AN EXCEPTION: the allowlists below are for the modules that DEFINE each
 * rule. If a new file needs to be added to one, that is the signal that a second
 * definition of the rule is being created — which is the bug. Use the existing
 * helper instead.
 */

const ROOTS = ['src/lib', 'src/pages/api', 'src/scripts'];

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

/** Runs `assert` over every file except the ones that legitimately define the rule. */
function forEachFileExcept(owners: string[], assert: (file: string, src: string) => void): void {
  for (const file of ALL_FILES) {
    if (owners.some((o) => file.endsWith(o))) continue;
    assert(file, code(file));
  }
}

describe('money arithmetic goes through lib/money.ts', () => {
  it('nobody hand-rolls agorot rounding', () => {
    // `Math.round(x * 100) / 100` scattered around is how the agorot migration turns
    // from one edit into an archaeology project — and how two call sites end up
    // rounding the same figure differently.
    forEachFileExcept(['lib/money.ts'], (file, src) => {
      expect(src, `${file}: use roundMoney()/sumMoney()/percentOf() from lib/money.ts instead of hand-rolling Math.round(x * 100) / 100`)
        .not.toMatch(/Math\.round\([^;]*?\*\s*100\s*\)\s*\/\s*100/);
    });
  });

  it('nobody hand-rolls a percentage cut of an amount', () => {
    // A commission or a percent discount computed inline rounds differently from
    // percentOf(), and the difference only shows up as a reconciliation failure.
    forEachFileExcept(['lib/money.ts', 'lib/pricing.ts', 'lib/analytics.ts', 'lib/ad-metrics.ts', 'lib/admin-ads.ts'], (file, src) => {
      expect(src, `${file}: use percentOf(amount, percent) from lib/money.ts`)
        .not.toMatch(/\*\s*\(?\s*(commissionPercent|discountPercent)\s*\/\s*100/);
    });
  });
});

describe('the revenue rule has exactly one definition', () => {
  it('nobody tests paymentStatus for "paid" directly', () => {
    // The original bug: a cancellation leaves paymentStatus at 'paid', so this test
    // looks right and silently counts money that is owed back.
    forEachFileExcept(['lib/order-status-rules.ts'], (file, src) => {
      expect(src, `${file}: use countsAsRevenue() from lib/orders.ts — 'paid' alone still matches a CANCELLED order`)
        .not.toMatch(/paymentStatus\s*[!=]==\s*['"]paid['"]/);
    });
  });

  it('nobody tests shippingStatus for "cancelled" directly', () => {
    // Same rule from the other side. A new status ('returned', 'refunded') must
    // inherit the behaviour from the table, not miss an `if` somebody wrote by hand.
    forEachFileExcept(['lib/order-status-rules.ts'], (file, src) => {
      expect(src, `${file}: ask lib/order-status-rules.ts (countsAsRevenue / orderHoldsStock) instead of comparing to 'cancelled'`)
        .not.toMatch(/shippingStatus\s*[!=]==\s*['"]cancelled['"]/);
    });
  });

  it('nobody re-lists the order statuses', () => {
    // A second list drifts from the first the moment a status is added to one of them.
    forEachFileExcept(['lib/order-status-rules.ts', 'lib/orders.ts'], (file, src) => {
      expect(src, `${file}: derive from SHIPPING_STATUS_RULES in lib/order-status-rules.ts instead of re-listing the statuses`)
        .not.toMatch(/\[\s*['"]pending['"]\s*,\s*['"]processing['"]\s*,\s*['"]ready['"]/);
    });
  });
});

describe('one calendar, stated out loud', () => {
  it('nobody derives a calendar day or month from toISOString()', () => {
    // This is the whole timezone bug in one expression. On a UTC production server it
    // looks correct in every test run on an Israeli laptop.
    forEachFileExcept(['lib/business-day.ts'], (file, src) => {
      expect(src, `${file}: use businessDayISO()/businessMonthKey() from lib/business-day.ts (or calendarDayISO() for a synthetic axis cursor)`)
        .not.toMatch(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*(10|7)\s*\)/);
    });
  });

  it('no order-money module decides "this month" from the runtime calendar', () => {
    // Narrowed to files that actually handle order money: getMonth() is fine for a
    // date picker, and wrong for deciding which month a sale belongs to.
    forEachFileExcept(['lib/business-day.ts', 'lib/date-range.ts'], (file, src) => {
      if (!/storeSubtotals|countsAsRevenue|totalAgorot/.test(src)) return;
      expect(src, `${file}: use businessMonthKey() from lib/business-day.ts — getMonth() reads the SERVER's timezone, which is UTC in production`)
        .not.toMatch(/\.getMonth\(\)/);
    });
  });

  it('the business timezone is never inlined as a string', () => {
    forEachFileExcept(['lib/business-day.ts'], (file, src) => {
      expect(src, `${file}: import BUSINESS_TIMEZONE from lib/business-day.ts`)
        .not.toMatch(/['"]Asia\/Jerusalem['"]/);
    });
  });
});

describe('money-moving endpoints are guarded', () => {
  /** Endpoints that take money or change what an order is worth. */
  const MONEY_ENDPOINTS = ALL_FILES.filter((f) =>
    f.startsWith('src/pages/api') && /paymentProvider|createOrder\(/.test(code(f)));

  it('there is at least one, so this guard is not vacuously passing', () => {
    // A scan-based guard that silently matches nothing is worse than no guard.
    expect(MONEY_ENDPOINTS.length).toBeGreaterThan(0);
  });

  it('every endpoint that charges requires an idempotency key', () => {
    for (const file of MONEY_ENDPOINTS) {
      expect(code(file), `${file}: charges money — it must call isValidIdempotencyKey() and claimCheckout() (lib/checkout-idempotency.ts), or a lost response becomes a second charge`)
        .toMatch(/isValidIdempotencyKey/);
    }
  });

  it('every endpoint that charges writes to the money journal', () => {
    for (const file of MONEY_ENDPOINTS) {
      expect(code(file), `${file}: charges money — it must recordMoneyEvent() (lib/money-events.ts), or the charge leaves no trace when it goes wrong`)
        .toMatch(/recordMoneyEvent/);
    }
  });
});

/**
 * An amount in agorot must never reach `formatPrice`, which takes SHEKELS.
 *
 * The bug (2026-08-16, found by driving a real cancellation rather than by reading anything):
 * `AdminReconciliationCard` rendered `formatPrice(d.expected)` while every figure on a `Discrepancy`
 * is integer agorot — so the admin's money alarm multiplied itself by a hundred, and a real ₪279
 * refund debt was displayed as ₪27,900. Nothing failed and nothing could: money is a plain `number`
 * here, so the two units add and pass without a word from the compiler (GO_LIVE §3 carries the
 * branded-money work that would make it a compile error, and its trigger has not fired).
 *
 * The rule already existed — `lib/money.ts`'s own header spells out this exact failure, and
 * `formatAgorot` exists to be the answer. Only the JOIN was wrong, which is why reading either file
 * alone looked correct, and why this has to be a scan rather than a review habit.
 *
 * **The rename came first, and it is the load-bearing half.** The first version of this guard PASSED
 * against the live bug: the fields were called `expected`/`actual`/`drift`, and a rule about agorot
 * cannot see a value that does not say it holds agorot. Naming them `expectedAgorot` etc. — as
 * `totalAgorot` and `balanceAgorot` already are everywhere else — is what makes the class detectable
 * at all.
 *
 * **The roots deliberately include `.astro`.** The guards above scan `.ts` only, and the one place
 * this class actually shipped was a component — a surface with no type error to catch it and no
 * existing guard looking at it.
 */
describe('agorot never reach a shekel formatter', () => {
  const PRESENTATION_ROOTS = ['src/components', 'src/pages'];

  function walkAny(dir: string): string[] {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkAny(rel);
      return entry.isFile() && /\.(ts|astro)$/.test(entry.name) ? [rel] : [];
    });
  }

  const FILES = [...ALL_FILES, ...PRESENTATION_ROOTS.flatMap(walkAny)];

  it('every formatPrice() of an agorot value converts first', () => {
    // `formatPrice(` up to its closing paren, non-greedy — enough to see one argument, which is all
    // this rule is about.
    const CALL = /formatPrice\(([^)]*)\)/g;
    for (const file of FILES) {
      const src = code(file);
      for (const [, arg] of src.matchAll(CALL)) {
        if (!/agorot/i.test(arg)) continue;
        expect(
          /fromAgorot|\/\s*100/.test(arg),
          `${file}: formatPrice(${arg.trim()}) — formatPrice takes SHEKELS and this argument is agorot, so it prints a figure 100× too large. Use formatAgorot() from lib/money.ts.`,
        ).toBe(true);
      }
    }
  });

  it('scans the presentation tree too, where the bug actually shipped', () => {
    expect(FILES.some((f) => f.endsWith('.astro')), 'no .astro files scanned — a root was renamed').toBe(true);
  });
});

describe('the guards cover the tree, not a hand-written list', () => {
  it('scans every source file under the roots', () => {
    // If this drops sharply, a root was renamed and the guards above went quiet
    // without a single test failing — the exact silent-coverage-loss they exist to
    // prevent, one level up.
    expect(ALL_FILES.length).toBeGreaterThan(80);
    for (const root of ROOTS) {
      expect(ALL_FILES.some((f) => f.startsWith(root)), `${root} produced no files — was it renamed?`).toBe(true);
    }
  });
});
