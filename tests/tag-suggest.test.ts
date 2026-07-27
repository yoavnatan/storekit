import { describe, expect, it } from 'vitest';
import { suggestTags, deriveAutoTags } from '../src/lib/tag-suggest.js';

describe('suggestTags', () => {
  it('suggests whole category-path segments ahead of name words', () => {
    const tags = suggestTags({ categoryPath: 'הנעלה › נעלי ספורט', name: 'נעל ריצה קלה' });
    expect(tags.slice(0, 2)).toEqual(['הנעלה', 'נעלי ספורט']);
    expect(tags).toContain('נעל');
    expect(tags).toContain('ריצה');
  });

  it('accepts a pre-split category path array', () => {
    const tags = suggestTags({ categoryPath: ['ביגוד', 'חולצות'], name: 'חולצה' });
    expect(tags).toContain('ביגוד');
    expect(tags).toContain('חולצות');
  });

  it('drops Hebrew and English stopwords', () => {
    const tags = suggestTags({ name: 'כיסא עץ של הבית with a lamp' });
    expect(tags).not.toContain('של');
    expect(tags).not.toContain('with');
    expect(tags).not.toContain('a');
    expect(tags).toContain('כיסא');
    expect(tags).toContain('עץ');
    expect(tags).toContain('lamp');
  });

  it('drops pure numbers and measurements, keeps real words', () => {
    const tags = suggestTags({ name: 'שולחן 120 ס"מ עץ אלון', description: '20cm 4XL' });
    expect(tags).not.toContain('120');
    expect(tags).not.toContain('20cm');
    expect(tags).not.toContain('4xl');
    expect(tags).toContain('אלון');
  });

  it('never re-suggests a tag the product already has (case-insensitive)', () => {
    const tags = suggestTags({ name: 'Handmade Ceramic Mug', existingTags: ['handmade', 'MUG'] });
    const lower = tags.map((t) => t.toLowerCase());
    expect(lower).not.toContain('handmade');
    expect(lower).not.toContain('mug');
    expect(lower).toContain('ceramic');
  });

  it('mines the description for attribute keywords only, never filler words', () => {
    const tags = suggestTags({
      categoryPath: 'ריהוט',
      name: 'כורסא',
      description: 'כורסה איכותית ונוחה במיוחד, מושלמת לסלון, מרופדת בעור אמיתי.',
    });
    expect(tags[0]).toBe('ריהוט'); // category first
    expect(tags[1]).toBe('כורסא'); // then name
    expect(tags).toContain('עור'); // recognized material ("בעור" → עור)
    // Filler adjectives are NOT tags, even though they're "meaningful words".
    expect(tags).not.toContain('איכותית');
    expect(tags).not.toContain('נוחה');
    expect(tags).not.toContain('מושלמת');
    expect(tags).not.toContain('מרופדת');
  });

  it('recognizes English + multi-word attributes and Hebrew prefixed forms', () => {
    expect(suggestTags({ name: 'Wallet', description: 'genuine leather, handmade' }))
      .toEqual(expect.arrayContaining(['leather', 'handmade']));
    expect(suggestTags({ name: 'שולחן', description: 'עשוי מעץ אלון, בעבודת יד' }))
      .toEqual(expect.arrayContaining(['עץ', 'אלון', 'עבודת יד']));
  });

  it('suggests variant values (colours/materials) but filters size codes', () => {
    const tags = suggestTags({
      name: 'חולצה',
      variantValues: ['אדום', 'כחול כהה', 'S', 'M', 'XL', '42', 'כותנה'],
    });
    expect(tags).toContain('אדום');
    expect(tags).toContain('כחול כהה'); // multi-word value kept whole
    expect(tags).toContain('כותנה');
    expect(tags).not.toContain('S');
    expect(tags).not.toContain('M');
    expect(tags).not.toContain('XL');
    expect(tags).not.toContain('42');
  });

  it('ranks variant values below name but above description', () => {
    const tags = suggestTags({
      name: 'ספה',
      variantValues: ['עור'],
      description: 'רגליים מעץ אלון',
    });
    expect(tags[0]).toBe('ספה');
    expect(tags.indexOf('עור')).toBeGreaterThan(tags.indexOf('ספה'));
    expect(tags.indexOf('עור')).toBeLessThan(tags.indexOf('עץ')); // variant above description attr
  });

  it('drops one-size / free-size variant noise', () => {
    const tags = suggestTags({ name: 'כובע', variantValues: ['One Size', 'OS', 'שחור'] });
    expect(tags).toContain('שחור');
    expect(tags.map((t) => t.toLowerCase())).not.toContain('one size');
    expect(tags.map((t) => t.toLowerCase())).not.toContain('os');
  });

  it('de-duplicates across sources (case-insensitive)', () => {
    const tags = suggestTags({ categoryPath: 'תיקים', name: 'תיק גב', description: 'תיק תיק תיק' });
    expect(tags.filter((t) => t === 'תיק').length).toBe(1);
  });

  it('caps the number of suggestions', () => {
    const tags = suggestTags({
      name: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
      max: 4,
    });
    expect(tags.length).toBe(4);
  });

  it('returns nothing when there is no usable text', () => {
    expect(suggestTags({ name: '', description: '  ', categoryPath: '' })).toEqual([]);
    expect(suggestTags({ name: '123 !!! של' })).toEqual([]);
  });
});

describe('deriveAutoTags', () => {
  it('derives from category segments + variant values only (never name/description)', () => {
    const tags = deriveAutoTags({
      categoryPath: 'הנעלה › נעלי ספורט',
      variantValues: ['אדום', 'כותנה', 'M', '42'],
    });
    expect(tags).toContain('הנעלה');
    expect(tags).toContain('נעלי ספורט');
    expect(tags).toContain('אדום');
    expect(tags).toContain('כותנה');
    expect(tags).not.toContain('M'); // size codes filtered
    expect(tags).not.toContain('42');
  });

  it('never re-adds a tag the seller already has (so removals stick)', () => {
    const tags = deriveAutoTags({
      categoryPath: 'ריהוט',
      variantValues: ['עץ'],
      existingTags: ['ריהוט', 'עץ'],
    });
    expect(tags).toEqual([]);
  });

  it('accepts an accent-joined category path as the server produces it', () => {
    const tags = deriveAutoTags({ categoryPath: 'ביגוד › חולצות › פולו' });
    expect(tags).toEqual(['ביגוד', 'חולצות', 'פולו']);
  });

  it('caps auto tags so many variant options cannot explode the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `צבע${i}`);
    expect(deriveAutoTags({ variantValues: many, max: 15 }).length).toBe(15);
  });
});
