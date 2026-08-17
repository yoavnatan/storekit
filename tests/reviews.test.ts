import { describe, it, expect } from 'vitest';
import {
  averageRating, ratingDisplay, starFills, isValidRating,
  reviewerDisplayName, normalizeReviewBody, ratingHistogram,
  RATING_MAX,
} from '../src/lib/reviews.js';

/**
 * The arithmetic and the wording of a review — the parts every surface reads and none re-derives.
 *
 * The cases worth having are the ones with a WRONG answer that looks right: an unrated product
 * scoring zero, a half star rounding the flattering way, a full name published under a paragraph.
 */

describe('an unrated product has no rating, not a rating of zero', () => {
  it('averages to null when nothing has been rated', () => {
    expect(averageRating({ count: 0, sum: 0 })).toBeNull();
  });

  it('draws no stars at all for it — not five empty ones', () => {
    // The rendering rule lives on the null: every caller passes it through, and `starRowHtml`
    // returns ''. A `0` here would be five grey stars and a `ratingValue: 0` in the structured
    // data, which Google reads as a real and terrible score.
    expect(averageRating({ count: 0, sum: 12 })).toBeNull();
  });

  it('averages honestly once there is one', () => {
    expect(averageRating({ count: 4, sum: 18 })).toBe(4.5);
    expect(averageRating({ count: 3, sum: 10 })).toBeCloseTo(3.3333, 3);
  });
});

describe('half stars round to the NEAREST half, in both directions', () => {
  const shape = (avg: number) => starFills(avg).join(' ');

  it('4.4 is four and a half, not four', () => {
    expect(shape(4.4)).toBe('full full full full half');
  });

  it('4.2 is four, not four and a half', () => {
    expect(shape(4.2)).toBe('full full full full empty');
  });

  it('never invents a sixth star or a negative one', () => {
    expect(starFills(5)).toEqual(Array(RATING_MAX).fill('full'));
    expect(starFills(0)).toEqual(Array(RATING_MAX).fill('empty'));
    // Out-of-range input is clamped rather than producing a broken row — the DB CHECK and
    // `isValidRating` are what refuse it; this is the last line of defence, not the first.
    expect(starFills(9)).toEqual(Array(RATING_MAX).fill('full'));
    expect(starFills(-3)).toEqual(Array(RATING_MAX).fill('empty'));
  });

  it('prints the TRUE average beside them, not the rounded one', () => {
    // The visible number and the JSON-LD `ratingValue` are both this — structured data that
    // disagrees with the page is a Google mismatch, so the two must come from one function.
    expect(ratingDisplay(4.4)).toBe('4.4');
    expect(ratingDisplay(10 / 3)).toBe('3.3');
    expect(ratingDisplay(5)).toBe('5.0');
  });
});

describe('a rating from a request is refused, never clamped', () => {
  it('takes only whole 1-5', () => {
    expect(isValidRating(1)).toBe(true);
    expect(isValidRating(5)).toBe(true);
    expect(isValidRating(3)).toBe(true);
  });

  it('rejects everything else — a broken client must not become a silent 5-star', () => {
    for (const bad of [0, 6, 4.5, -1, '5', null, undefined, NaN, Infinity, {}]) {
      expect(isValidRating(bad)).toBe(false);
    }
  });
});

describe('the published name is a first name and an initial', () => {
  it('shortens a Hebrew surname with a geresh', () => {
    expect(reviewerDisplayName('יואב נתן')).toBe('יואב נ׳');
  });

  it('shortens a Latin surname with a period', () => {
    expect(reviewerDisplayName('John Smith')).toBe('John S.');
  });

  it('leaves a one-word name alone', () => {
    expect(reviewerDisplayName('דנה')).toBe('דנה');
  });

  it('uses the LAST word, not the second', () => {
    expect(reviewerDisplayName('Ana Maria Lopez')).toBe('Ana L.');
  });

  it('returns empty for an empty name — the renderer supplies the localised fallback', () => {
    // Deliberately not "קונה" here: the language a review is READ in is not the one it was
    // written in, and baking one into the stored row would freeze it forever.
    expect(reviewerDisplayName('   ')).toBe('');
    expect(reviewerDisplayName('')).toBe('');
  });
});

describe('the body is normalised, and length is somebody else\'s refusal', () => {
  it('trims and collapses runaway blank lines', () => {
    expect(normalizeReviewBody('  שורה\n\n\n\nשורה  ')).toBe('שורה\n\nשורה');
  });

  it('turns a non-string into empty rather than throwing', () => {
    expect(normalizeReviewBody(undefined)).toBe('');
    expect(normalizeReviewBody(42)).toBe('');
  });

  it('never truncates — the API refuses instead', () => {
    const long = 'א'.repeat(4000);
    expect(normalizeReviewBody(long)).toHaveLength(4000);
  });
});

describe('the distribution always has five rows', () => {
  it('counts each score and keeps the empty ones', () => {
    expect(ratingHistogram([{ rating: 5, count: 2 }, { rating: 4, count: 1 }, { rating: 1, count: 1 }])).toEqual([
      { rating: 5, count: 2 },
      { rating: 4, count: 1 },
      { rating: 3, count: 0 },
      { rating: 2, count: 0 },
      { rating: 1, count: 1 },
    ]);
  });

  it('is five zero rows for nothing at all — a bar chart that hides empty rows re-scales itself', () => {
    expect(ratingHistogram([]).map((r) => r.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('ignores a score outside the scale rather than drawing a sixth bar', () => {
    expect(ratingHistogram([{ rating: 9, count: 4 }, { rating: 3, count: 1 }]).map((r) => r.count))
      .toEqual([0, 0, 1, 0, 0]);
  });
});
