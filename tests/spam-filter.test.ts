import { describe, expect, it } from 'vitest';
import { findSpamKeyword, spamRejectionMessage, findKeywordStuffing, stuffingRejectionMessage } from '../src/lib/spam-filter.js';

describe('findSpamKeyword', () => {
  it('returns null for ordinary product text', () => {
    expect(findSpamKeyword('כיסא משרדי אורתופדי', 'כיסא נוח לעבודה מהבית', 'ריהוט', 'משרד')).toBeNull();
  });

  it('flags an English spam keyword regardless of case', () => {
    expect(findSpamKeyword('Best Online Casino Bonus 2026')).toBe('casino');
  });

  it('flags a Hebrew spam keyword', () => {
    expect(findSpamKeyword('הימורים בחינם כל השבוע')).toBe('הימורים');
  });

  it('checks every provided field, not just the first', () => {
    expect(findSpamKeyword('מוצר תמים', '', 'viagra')).toBe('viagra');
  });

  it('ignores undefined/empty fields without throwing', () => {
    expect(findSpamKeyword(undefined, '', null as unknown as string)).toBeNull();
  });

  it('matches a keyword that is its own standalone word, punctuation-bounded', () => {
    expect(findSpamKeyword('Buy now! Viagra, cheapest price')).toBe('viagra');
  });

  it('does not flag a keyword that only appears as a substring inside an unrelated legitimate word (word-boundary, not substring, matching)', () => {
    // "specialist" contains the letters "cialis" mid-word — a plain substring
    // scan would wrongly flag this as pharma spam.
    expect(findSpamKeyword('Hire a marketing specialist for your store')).toBeNull();
  });

  it('does not flag an ordinary clothing size that happens to spell out a dropped keyword ("xxx")', () => {
    // "xxx" used to be in the blocklist and matched inside "XXX-Large" even
    // as a substring-bounded token — dropped entirely (found in review,
    // 2026-07-14) since it's too ambiguous for a general marketplace and
    // adult content is already covered by "porn"/"porno"/"free sex".
    expect(findSpamKeyword('Men\'s Hoodie — XXX-Large')).toBeNull();
  });
});

describe('spamRejectionMessage', () => {
  it('names the offending keyword in the returned Hebrew message', () => {
    expect(spamRejectionMessage('casino')).toContain('casino');
  });
});

describe('findKeywordStuffing', () => {
  it('returns null for ordinary product text', () => {
    expect(findKeywordStuffing('כיסא משרדי אורתופדי', 'כיסא נוח לעבודה מהבית עם משענת גב איכותית', 'ריהוט', 'משרד')).toBeNull();
  });

  it('flags a word repeated far beyond natural writing across a tag list (real stuffing shape — same word crammed into most of the tags)', () => {
    const tags = [
      'משלוח', 'משלוח מהיר', 'משלוח חינם', 'משלוח היום',
      'משלוח מיידי', 'משלוח לבית', 'משלוח אקספרס', 'משלוח מובטח',
    ];
    const result = findKeywordStuffing(...tags);
    expect(result).toMatchObject({ word: 'משלוח', count: 8 });
  });

  it('flags an English description stuffed with the same word', () => {
    const description = 'cheap cheap cheap shoes cheap deal cheap price cheap today cheap sale cheap now';
    const result = findKeywordStuffing(description);
    expect(result?.word).toBe('cheap');
  });

  it('does not flag a short, ordinarily-repetitive title ("Red Red Wine Set") — repeat count stays under the floor', () => {
    expect(findKeywordStuffing('Red Red Wine Set')).toBeNull();
  });

  it('does not flag a store repeating its own brand name a handful of times across title/description/tags', () => {
    // Explicitly the false-positive case the owner called out — a brand name
    // showing up in most fields is completely normal, not manipulative.
    const name = 'Nike Air Max 90';
    const description = 'Nike official store — genuine Nike quality, Nike comfort for everyday wear';
    const tags = ['nike', 'shoes', 'sneakers'];
    expect(findKeywordStuffing(name, description, ...tags)).toBeNull();
  });

  it('does not flag a long description where a word\'s raw count crosses the floor but stays a small share of the whole text (count-only would false-positive, density guards it)', () => {
    const filler = Array.from({ length: 92 }, (_, i) => `word${i}`).join(' ');
    const description = `${filler} quality quality quality quality quality quality quality quality`;
    // "quality" appears exactly 8 times (at the raw-count floor) among 100
    // total significant words — 8% density, nowhere near the 30% bar.
    expect(findKeywordStuffing(description)).toBeNull();
  });
});

describe('stuffingRejectionMessage', () => {
  it('names the offending word and its repeat count in the returned Hebrew message', () => {
    const msg = stuffingRejectionMessage({ word: 'משלוח', count: 8 });
    expect(msg).toContain('משלוח');
    expect(msg).toContain('8');
  });
});
