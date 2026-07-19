import { describe, expect, it } from 'vitest';
import { inferAudienceGender, inferAgeGroup } from '../src/lib/audience-infer.js';

describe('inferAudienceGender', () => {
  it('infers men from a Hebrew category path', () => {
    expect(inferAudienceGender(['אופנה > גברים > חולצות', 'חולצת פולו'])).toBe('men');
  });

  it('infers women from a Hebrew category path', () => {
    expect(inferAudienceGender(['הנעלה > נשים', 'סנדל קיץ'])).toBe('women');
  });

  it('infers from the product name or tags when the category is neutral', () => {
    expect(inferAudienceGender(['אקססוריז', 'ארנק לאישה'])).toBe('women');
    expect(inferAudienceGender(['שעונים', 'שעון', 'men'])).toBe('men');
  });

  it('does not confuse גברת (lady) for גבר (man)', () => {
    expect(inferAudienceGender(['מתנות', 'מתנה לגברת'])).toBe('women');
  });

  it('handles the English men/women substring collision via word boundaries', () => {
    expect(inferAudienceGender(["Women's shoes"])).toBe('women');
    expect(inferAudienceGender(["Men's shoes"])).toBe('men');
  });

  it('returns null for a neutral/unisex product', () => {
    expect(inferAudienceGender(['אלקטרוניקה > אוזניות', 'אוזניות בלוטות׳'])).toBeNull();
    expect(inferAudienceGender([])).toBeNull();
    expect(inferAudienceGender([undefined, ''])).toBeNull();
  });

  it('returns null when both genders are present (ambiguous)', () => {
    expect(inferAudienceGender(['אופנה', 'בושם לגברים ולנשים'])).toBeNull();
  });
});

describe('inferAgeGroup', () => {
  it('infers infant from baby-scoped text', () => {
    expect(inferAgeGroup(['אופנה > תינוקות', 'בגד גוף'])).toBe('infant');
    expect(inferAgeGroup(['Newborn onesie'])).toBe('infant');
  });

  it('infers kids from children-scoped text', () => {
    expect(inferAgeGroup(['הנעלה > ילדים', 'נעלי ספורט'])).toBe('kids');
    expect(inferAgeGroup(["Kids' backpack"])).toBe('kids');
  });

  it('prefers the more specific infant bucket over kids', () => {
    expect(inferAgeGroup(['ביגוד תינוקות וילדים'])).toBe('infant');
  });

  it('returns null (→ adult/all) when there is no age signal', () => {
    expect(inferAgeGroup(['אלקטרוניקה', 'אוזניות'])).toBeNull();
    expect(inferAgeGroup(['Men\'s watch'])).toBeNull();
    expect(inferAgeGroup([])).toBeNull();
  });
});
