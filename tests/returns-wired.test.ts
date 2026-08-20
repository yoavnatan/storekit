import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NON_RETURNABLE_SUBJECTS } from '../src/lib/return-eligibility.js';
import {
  RETURN_REASON_LABELS, RETURN_TRANSITIONS, sellerOwesAction, sellerActionSql,
  returnShippingPayer, refundAmountAgorot,
} from '../src/lib/returns.js';
import { translations } from '../src/i18n/translations.js';

/**
 * Nothing in the returns feature may be written and left uncalled.
 *
 * ── Why this test exists, and it is a real failure's headstone ──
 * `notifySellerReturnDeadline` was written, reviewed, described in a summary as built, and wired to
 * nothing. A seller therefore got NO warning before a request closed against him — and every report
 * of the work said the warning existed. The owner's answer was "נורא, תבדוק שאין עוד כאלו".
 *
 * Dead code that looks like a feature is worse than a missing feature: a gap gets noticed the first
 * time somebody needs it, while an uncalled function is invisible from every direction except this
 * one. `astro check` cannot see it (an export is legitimately unused until someone imports it), lint
 * cannot (it is exported), and a review reads the function and finds it correct — which it is.
 *
 * So the check is mechanical: every export of every returns module must be named somewhere outside
 * its own file. A helper that genuinely has no caller yet should not be exported at all.
 */

const MODULES = [
  'src/lib/returns.ts',
  'src/lib/return-requests.ts',
  'src/lib/return-notify.ts',
  'src/lib/return-rate.ts',
  'src/lib/return-eligibility.ts',
  'src/lib/return-eligibility-order.ts',
  'src/lib/returns-run.ts',
];

/** Everything that could reference an export: source, pages, scripts, and the tests themselves. */
function allSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|astro|mjs)$/.test(entry.name)) out.set(rel, fs.readFileSync(rel, 'utf8'));
    }
  };
  ['src', 'tests', 'scripts'].forEach(walk);
  return out;
}

describe('the returns feature has no code nothing calls', () => {
  const sources = allSources();

  it('every export is referenced outside its own file', () => {
    const orphans: string[] = [];
    for (const file of MODULES) {
      if (!fs.existsSync(file)) { orphans.push(`${file} is gone — the list above is stale`); continue; }
      const src = fs.readFileSync(file, 'utf8');
      const names = [
        ...[...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!),
        ...[...src.matchAll(/^export const (\w+)\s*[:=]/gm)].map((m) => m[1]!),
      ];
      for (const name of names) {
        const used = [...sources.entries()].some(([p, text]) =>
          p !== file && new RegExp(`\\b${name}\\b`).test(text));
        if (!used) orphans.push(`${name} (${file})`);
      }
    }
    expect(
      orphans,
      'These are exported and nothing outside their own file names them. Either wire them up or stop\n'
      + 'exporting them — a function that looks built and runs never is the failure this test exists for.',
    ).toEqual([]);
  });

  it('scans the modules it claims to', () => {
    // If the list above rots, the test above passes by scanning nothing.
    expect(MODULES.every((m) => fs.existsSync(m))).toBe(true);
    expect(sources.size).toBeGreaterThan(100);
  });
});

/**
 * The published policy must name every exclusion the code enforces.
 *
 * These are two halves of one promise: `return-eligibility.ts` decides which shelves lose the return
 * right, and `/returns-policy` is where a buyer reads that BEFORE buying. A term added to the code
 * and not to the page is a right removed in silence — and the page is the only place a buyer could
 * have found out.
 */
/**
 * The number on the tab and the sentence inside the panel come from ONE rule.
 *
 * The returns tab counted every OPEN case and called all of them "מחכות לך", which named the seller
 * as the person holding up requests that were waiting on the buyer to post a parcel or on our own
 * decision (owner, 2026-08-20). The fix is only worth anything if it stays single: a badge and a
 * header that drift apart give a seller two different answers to "how many of these are mine", on
 * the same screen, and the badge is the one he sees from every other tab.
 *
 * So this pins three things — the rule's membership, that both SQL and TS spell it the same way,
 * and that neither surface has gone back to counting open cases.
 */
describe('the seller\'s returns count means "yours", not "open"', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

  it('claims exactly the three states a seller can act on', () => {
    expect(sellerOwesAction('requested')).toBe(true);   // answer, or the clock refuses for him
    expect(sellerOwesAction('in_transit')).toBe(true);  // only he can say the parcel arrived
    expect(sellerOwesAction('received')).toBe(true);    // two business days before it auto-refunds

    expect(sellerOwesAction('approved')).toBe(false);   // the buyer posts it
    expect(sellerOwesAction('offered')).toBe(false);    // the buyer answers
    expect(sellerOwesAction('disputed')).toBe(false);   // we decide
    for (const closed of ['rejected', 'refunded', 'expired'] as const) {
      expect(sellerOwesAction(closed)).toBe(false);
    }
  });

  it('spells the same list in SQL as in TypeScript', () => {
    const sql = sellerActionSql();
    const named = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    const ALL = Object.keys(RETURN_TRANSITIONS) as (keyof typeof RETURN_TRANSITIONS)[];
    for (const st of ALL) {
      expect(named.includes(st), `${st}: SQL and sellerOwesAction disagree`).toBe(sellerOwesAction(st));
    }
  });

  it('is what the tab badge and the panel header both use', () => {
    expect(read('src/pages/seller/dashboard.astro')).toContain('countSellerActionReturns');
    expect(read('src/components/dashboard/ReturnsPanel.astro')).toContain('sellerOwesAction');
    // The old shape, in the words it had: an open-case count presented as the seller's queue.
    expect(read('src/components/dashboard/ReturnsPanel.astro')).not.toContain('${open.length} בקשות מחכות לך');
  });
});

/**
 * The buyer is told what a change of mind COSTS, at the moment he is told he may return.
 *
 * The sentence on an order already shipped is not silence — it is a promise. It said *"ברגע שתגיע
 * ניתן יהיה לבקש להחזיר אותה מכאן"* and named no price, while two separate rules meeting behind it
 * mean he pays both legs: `refundAmountAgorot` withholds the original delivery on `changed_mind`
 * and `returnShippingPayer` puts the return leg on him. On a small order that is more than the
 * goods (the owner ruled the policy stays, 2026-08-20 — `docs/returns-policy-decisions.md`).
 *
 * A returns-policy page carries the general disclosure and is the right home for it. What it
 * cannot do is fix a screen that says something else at the deciding moment, which is why this is
 * pinned HERE and against the CODE: flip either rule and the sentence stops being true.
 */
describe('the shipped-order notice states what changing your mind costs', () => {
  it('only claims the buyer pays while the code actually says so', () => {
    // This assertion is what makes the copy below a consequence of the rules rather than a
    // sentence somebody typed once.
    expect(returnShippingPayer('changed_mind')).toBe('buyer');
    const order = { totalAgorot: 7900, shippingAgorot: 3000 };
    expect(refundAmountAgorot(order, 'changed_mind')).toBe(4900);
    // …and every other reason is the seller's, which is why the sentence has to be conditional.
    expect(returnShippingPayer('damaged')).toBe('seller');
    expect(refundAmountAgorot(order, 'damaged')).toBe(7900);
  });

  it('says it in both languages, on the notice the buyer reads', () => {
    for (const lang of ['he', 'en'] as const) {
      const line = translations[lang].buyerDashboard.cancelAfterShip;
      expect(line.length, `${lang}: cancelAfterShip is missing`).toBeGreaterThan(0);
      const saysCost = lang === 'he'
        ? line.includes('על חשבונך') && line.includes('אינם מוחזרים')
        : /return postage is yours/i.test(line) && /not refunded/i.test(line);
      expect(
        saysCost,
        `${lang}: the notice tells a buyer he may return the parcel and never that a change of\n`
        + 'mind costs him the delivery charge AND the return postage. It is the one screen he\n'
        + 'reads at the moment the cost applies.',
      ).toBe(true);
      // Conditional, not a flat claim — a faulty item is refunded in full and collected at the
      // seller's expense, and a notice saying otherwise would be wrong against the buyer.
      const conditional = lang === 'he' ? line.includes('אם המוצר תקין') : /if the item is fine/i.test(line);
      expect(conditional, `${lang}: the cost is stated unconditionally, which is false for a faulty item`).toBe(true);
    }
  });
});

describe('the policy page names every exclusion the code enforces', () => {
  it('mentions each non-returnable term', () => {
    const page = fs.readFileSync('src/pages/returns-policy.astro', 'utf8');
    // Compared against the SUBJECTS, never the matcher's spelling variants: the page says "מזון",
    // the matcher also carries "מאכל", and asking the page to contain a matcher is asking it to be
    // written for a regex rather than for a person.
    const missing = NON_RETURNABLE_SUBJECTS
      .filter(({ subject }) => !page.includes(subject.split(' ')[0]!))
      .map(({ subject }) => subject);
    expect(
      missing,
      'The code refuses returns on these and the policy page never mentions them. A buyer cannot\n'
      + 'find out before buying, which is the one moment the notice exists for.',
    ).toEqual([]);
  });
});

/**
 * The four reasons have ONE set of words, and it lives in `lib/returns.ts`.
 *
 * ── The bug this is the headstone for (owner, 2026-08-20) ──
 * `changed_mind` / `damaged` / `wrong_item` / `not_arrived` are database values. Two panels — the
 * seller's card and the admin's queue — each carried their own private map turning them into Hebrew,
 * identical to each other and invisible to anybody adding a THIRD reader. The third reader was the
 * money journal, and it did what a file with no map in it does: it wrote the raw code. An owner
 * reading his own money log saw `סיבה: changed_mind` in the middle of a Hebrew sentence, on the one
 * screen whose entire job is to be believed.
 *
 * Two identical copies are not a bug yet, which is exactly why nobody fixed them. The bug is the
 * shape: a rule with no single home is a rule the next caller cannot find.
 *
 * Grepped by the WORDS, not by the constant's name — a second copy will never be called
 * `RETURN_REASON_LABELS`. And not by the shape either: a file mapping the four codes to something
 * ELSE is legitimate and there is one, `ReturnsPanel.astro`'s `REASON_MEANS`, which says what each
 * reason costs the seller rather than restating what it is called. Two maps over one vocabulary are
 * only a bug when they are the same map.
 */
describe('the return reasons are spelled out in exactly one place', () => {
  it('no file outside lib/returns.ts repeats a reason LABEL', () => {
    const owner = 'src/lib/returns.ts';
    const labels = Object.values(RETURN_REASON_LABELS);
    // `translations.ts` is exempt, and it is the one exemption. The BUYER picks a reason from his
    // own screen, in his own language, and `returnR2: 'הגיע פגום'` is that picker's word — the same
    // two words for a different reader on a different surface, living in the one place words are
    // supposed to live. The rule here is about a file inventing a SECOND seller-side map.
    const offenders = [...allSources()]
      .filter(([file]) => file !== owner && !file.startsWith('tests') && file !== 'src/i18n/translations.ts')
      // Comments stripped first: this file's own header quotes the owner quoting a label, and a
      // guard that fails on the sentence explaining it is a guard nobody keeps.
      .filter(([, src]) => {
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        return labels.some((label) => code.includes(`'${label}'`));
      })
      .map(([file]) => file);

    expect(
      offenders,
      'These build their own map of the return reasons. Import RETURN_REASON_LABELS from\n'
      + 'lib/returns.ts instead — a second copy is how the money journal came to print a raw\n'
      + 'database value at a person.',
    ).toEqual([]);
  });
});
