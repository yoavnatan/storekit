/**
 * The one exclusion in this codebase that protects the shared ad ACCOUNT rather than one listing.
 *
 * Google and Meta suspend the account — not the item — for prohibited content, and this platform
 * advertises every seller through one Merchant Center and one Catalog. So one seller listing a vape
 * kit does not lose one listing: it takes every store off both networks at once, for as long as the
 * appeal takes (memory `project_ad_platform_account_risk`).
 *
 * The half of this file that matters most is the SECOND describe. A blocklist that quietly excludes
 * ordinary products is not a safer blocklist — it is a different silent failure, paid for by a
 * seller who never finds out why his ad never ran. Every entry has to be unambiguous on its own,
 * and these cases are the ones that would have made it not so.
 */
import { describe, expect, it } from 'vitest';
import { adPolicyViolation } from '../src/lib/ad-policy.js';
import { adExclusionReason, isProductAdvertisable, buildFeedItems } from '../src/lib/product-feed.js';
import type { StoreProduct } from '../src/lib/store-products.js';

const BASE = 'https://shop.example';
const CTX = {
  storeName: 'חנות',
  baseUrl: BASE,
  productLink: (slug: string) => `${BASE}/s/${encodeURIComponent(slug)}`,
  nowMs: Date.parse('2026-08-06T00:00:00.000Z'),
};

function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: 'p1', storeId: 's1', slug: 'x', name: 'מוצר', description: 'תיאור',
    price: 100, stock: 5, images: [`${BASE}/a.jpg`],
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

describe('what the networks prohibit is caught', () => {
  it.each([
    ['tobacco / vaping', { name: 'סיגריה אלקטרונית דגם X' }],
    ['vaping, English', { name: 'Starter vape pen kit' }],
    ['recreational drugs', { name: 'מארז', description: 'שמן קנאביס איכותי' }],
    ['weapons', { name: 'תחמושת לרובה' }],
    ['self-declared counterfeit', { name: 'תיק חיקוי מותג' }],
    ['counterfeit, English', { name: 'Replica watch, gold' }],
    ['adult products', { name: 'צעצועי מין' }],
  ])('%s', (_label, fields) => {
    expect(adPolicyViolation(product(fields))).not.toBeNull();
  });

  it('reads every field a network actually receives, not just the title', () => {
    // Tags and brand travel in the feed too, so hiding the term there must not work.
    expect(adPolicyViolation(product({ tags: ['vape'] }))).not.toBeNull();
    expect(adPolicyViolation(product({ brand: 'Replica watch' }))).not.toBeNull();
    expect(adPolicyViolation(product({ description: 'מכיל ניקוטין — סיגריה אלקטרונית' }))).not.toBeNull();
  });

  it('names the term, so the seller can be told which word did it', () => {
    // An exclusion he cannot see the cause of is the silent-rejection failure this area exists to
    // end: the product sits on his storefront looking fine and no ad ever runs behind it.
    expect(adPolicyViolation(product({ name: 'ערכת vape' }))).toBe('vape');
  });
});

describe('ordinary marketplace products are NOT caught — the half that keeps this honest', () => {
  it.each([
    ['a kitchen knife — Google prohibits weapons, not cutlery', { name: 'סכין שף 20 ס״מ' }],
    // The owner stress-tested the list with these two on 2026-08-07. They pass because the bare
    // "אקדח" and the bare "רובה" are deliberately absent — only phrases that cannot be a tool are
    // listed. Pinned here so nobody "tightens" the list by adding the bare word.
    ['a staple gun', { name: 'אקדח סיכות חשמלי' }],
    ['a nail gun', { name: 'אקדח מסמרים' }],
    ['a nail gun, the other Hebrew name', { name: 'רובה מסמרים' }],
    ['a glue gun — "אקדח" is why the bare word is not on the list', { name: 'אקדח דבק חם' }],
    ['a heat gun', { name: 'אקדח חום תעשייתי' }],
    ['a water pistol', { name: 'אקדח מים לילדים' }],
    ['a caulking gun', { name: 'אקדח סיליקון' }],
    ['a paint sprayer', { name: 'אקדח צבע' }],
    ['a grease gun', { name: 'אקדח שמנון' }],
    ['a pocket knife', { name: 'אולר רב-שימושי' }],
    ['a grinder for coffee', { name: 'מטחנת קפה' }],
    ['a coffee grinder, English', { name: 'Burr coffee grinder' }],
    ['a replica of a painting — not a brand counterfeit', { name: 'הדפס רפרודוקציה' }],
    ['a toy gun clearly labelled', { name: 'רובה צעצוע ספוג' }],
    ['perfume with a tobacco note', { name: 'בושם עם נגיעות טבק ועץ' }],
    ['a smoking jacket', { name: "ז'קט קטיפה" }],
    ['XXX-Large clothing — the collision that shaped the sibling list', { name: 'חולצה XXX-Large' }],
    ['a plain product', { name: 'כוס קרמיקה', description: 'לשתייה חמה' }],
  ])('%s', (_label, fields) => {
    expect(adPolicyViolation(product(fields))).toBeNull();
  });

  it('matches on word boundaries, so a term inside a longer word does not fire', () => {
    // Latin and Hebrew both — JS `\b` contains no Hebrew at all, which is why the module uses
    // lookaround instead (same reasoning as spam-filter.ts).
    expect(adPolicyViolation(product({ name: 'Vapeur — מוצרי אדים' }))).toBeNull();
  });
});

describe('a blocked product never reaches the feed', () => {
  it('is excluded, and says policy rather than a mechanical reason', () => {
    const blocked = product({ name: 'סיגריה אלקטרונית' });
    expect(adExclusionReason(blocked, BASE)).toBe('policy');
    expect(isProductAdvertisable(blocked, BASE)).toBe(false);
    expect(buildFeedItems(blocked, CTX)).toEqual([]);
  });

  it('excludes every VARIANT row too, not just a parent that does not exist', () => {
    // A variant product emits no parent row, so a check that only guarded the parent would have
    // let all of its combos through.
    const blocked = product({
      name: 'ערכת vape',
      variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }],
    });
    expect(buildFeedItems(blocked, CTX)).toEqual([]);
  });

  it('reports the mechanical reasons ahead of policy, since those already exclude the row', () => {
    expect(adExclusionReason(product({ name: 'vape', price: 0 }), BASE)).toBe('no-price');
    expect(adExclusionReason(product({ name: 'vape', images: [] }), BASE)).toBe('no-image');
  });

  it('leaves a clean product in the feed', () => {
    expect(buildFeedItems(product(), CTX)).toHaveLength(1);
  });

  it('does not touch the storefront — the product still sells', () => {
    // The whole point of putting this in the FEED and not in the product form: what a seller may
    // SELL is the owner's decision and carries Israeli legal exposure; what we may SUBMIT is the
    // networks' published policy. Only the second is this module's business.
    const blocked = product({ name: 'סיגריה אלקטרונית', stock: 7 });
    expect(blocked.stock).toBe(7);
    expect(blocked.price).toBeGreaterThan(0);
  });
});
