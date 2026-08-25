/**
 * The store category → PayMe merchant code mapping.
 *
 * Two things can go wrong here and only one of them is visible in a diff:
 *
 *  · a code that is not in PayMe's list at all — the `5999` mistake, where an ISO 18245 catch-all
 *    was sent to a system that uses a private numbering. Every seller onboarded that way is a
 *    merchant they cannot underwrite, and the seller finds out as an account that never gets
 *    approved. So the codes are checked against **their own captured list**, not against the
 *    comments beside them;
 *  · a category added to `store-taxonomy.ts` and not here, which silently sends its sellers back to
 *    typing a five-digit code they have no way to know.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { paymeCategoryForStore, isDerivedPaymeCategory, MAPPED_STORE_CATEGORIES, MERCHANT_CATEGORY_OPTIONS } from '../src/lib/merchant-category.js';
import { SEED_CATEGORIES } from '../src/lib/store-taxonomy.js';

/** PayMe's Israeli MCC list, as captured from their documentation (docs/payme-docs/README.md).
 *  Rows are `code<TAB>hebrew<TAB>english`. */
const MCC_FILE = path.join(process.cwd(), 'docs/payme-docs/docs_guides_u62g6pktpkr2t-israeli-mcc-list.txt');

function paymeCodes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of fs.readFileSync(MCC_FILE, 'utf8').split('\n')) {
    const [code, hebrew] = line.split('\t');
    if (code && /^\d{5}$/.test(code.trim()) && hebrew) out.set(code.trim(), hebrew.trim());
  }
  return out;
}

describe('every code we send is one PayMe actually publish', () => {
  it('finds each mapped code in their own list', () => {
    const codes = paymeCodes();
    // Sanity on the fixture itself: a captured page that stopped parsing would make every
    // assertion below vacuous.
    expect(codes.size).toBeGreaterThan(300);
    for (const category of MAPPED_STORE_CATEGORIES) {
      const code = paymeCategoryForStore([category]);
      expect(code, `${category} maps to nothing`).toBeTruthy();
      expect(codes.has(code!), `${category} → ${code} is not in PayMe's list`).toBe(true);
    }
  });

  // The failure that shipped once: `5999` is ISO 18245's catch-all and is not in their numbering at
  // all. Nothing may reintroduce it, and their range starts at 10000.
  it('never produces an ISO 18245 code', () => {
    for (const category of MAPPED_STORE_CATEGORIES) {
      expect(Number(paymeCategoryForStore([category]))).toBeGreaterThanOrEqual(10000);
    }
    expect(isDerivedPaymeCategory('5999')).toBe(false);
  });
});

describe('what the seller never has to answer', () => {
  it('covers the seed vocabulary, except the one category with no honest answer', () => {
    const unmapped = SEED_CATEGORIES.filter((c) => !paymeCategoryForStore([c]));
    // `כלבו` is a department store and PayMe's list has no cross-trade row — every "general" row is
    // general WITHIN a trade. It is the case the form's field still exists for. A SECOND name
    // appearing here means somebody added a category and left its sellers to guess a code.
    expect(unmapped).toEqual(['כלבו']);
  });

  it('takes the first category the seller ordered, which is what his shop mostly is', () => {
    expect(paymeCategoryForStore(['הנעלה', 'בגדים'])).toBe('10407');
    expect(paymeCategoryForStore(['בגדים', 'הנעלה'])).toBe('10200');
  });

  it('skips a category it cannot answer for and keeps looking', () => {
    expect(paymeCategoryForStore(['כלבו', 'מזון'])).toBe('10428');
  });

  // `null` is the answer that makes the form ask. A default here is the whole class of bug this
  // module exists to end — a code their system does not recognise, discovered as a merchant that
  // never gets approved.
  // **A store's categories are FREE TEXT** — `sanitizeStoreCategories` takes any short string, and
  // the picker's vocabulary is a suggestion rather than a whitelist. So "nothing mapped" is an
  // ordinary outcome, and what the form falls back to has to be a question a seller can answer: our
  // own categories, never PayMe's five-digit code from a list he has never seen.
  it('offers our own categories as the fallback, every one of them a code we can send', () => {
    expect(MERCHANT_CATEGORY_OPTIONS.length).toBe(MAPPED_STORE_CATEGORIES.length);
    for (const option of MERCHANT_CATEGORY_OPTIONS) {
      expect(isDerivedPaymeCategory(option.code), `${option.label} → ${option.code}`).toBe(true);
      // The label is what he reads, so it is the Hebrew category and not a number.
      expect(option.label).not.toMatch(/^\d+$/);
    }
  });

  it('answers null rather than inventing one', () => {
    expect(paymeCategoryForStore([])).toBeNull();
    expect(paymeCategoryForStore(undefined)).toBeNull();
    expect(paymeCategoryForStore(['כלבו'])).toBeNull();
    expect(paymeCategoryForStore(['משהו שלא קיים'])).toBeNull();
  });
});
