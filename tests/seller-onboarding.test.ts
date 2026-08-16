import { describe, expect, it } from 'vitest';
import {
  buildOnboardingSteps,
  missingRequiredSteps,
  onboardingProgress,
  ONBOARDING_STEP_ORDER,
  type OnboardingInput,
} from '../src/lib/seller-onboarding.js';

/** A brand-new store: nothing filled in yet. */
function empty(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    visibleProductCount: 0,
    hasProfileImage: false,
    hasBannerImage: false,
    tagline: '',
    description: '',
    categoryCount: 0,
    address: '',
    ...overrides,
  };
}

/** A fully set-up store. */
function full(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    visibleProductCount: 3,
    hasProfileImage: true,
    hasBannerImage: true,
    tagline: 'קרמיקה בעבודת יד',
    description: 'סטודיו קטן בתל אביב',
    categoryCount: 2,
    address: 'דיזנגוף 1, תל אביב',
    ...overrides,
  };
}

function doneIds(input: OnboardingInput): string[] {
  return buildOnboardingSteps(input).filter((s) => s.done).map((s) => s.id);
}

describe('buildOnboardingSteps', () => {
  it('returns every step, in the fixed order, for any input', () => {
    for (const input of [empty(), full()]) {
      expect(buildOnboardingSteps(input).map((s) => s.id)).toEqual(ONBOARDING_STEP_ORDER);
    }
  });

  it('marks nothing done for a brand-new store', () => {
    expect(doneIds(empty())).toEqual([]);
  });

  /** Added 2026-08-16. The store page suppresses the 56px mark beside the name when a banner
   *  PICTURE exists, so the two pictures are one decision — and nothing had ever asked a seller
   *  for the banner half of it. */
  it('tracks the banner separately from the store image', () => {
    expect(doneIds(empty({ hasProfileImage: true }))).toEqual(['image']);
    expect(doneIds(empty({ hasBannerImage: true }))).toEqual(['banner']);
    expect(doneIds(empty({ hasProfileImage: true, hasBannerImage: true }))).toEqual(['image', 'banner']);
  });

  it('marks everything done for a fully set-up store', () => {
    expect(doneIds(full())).toEqual(ONBOARDING_STEP_ORDER);
  });

  it('accepts either tagline OR description for the "about" step', () => {
    expect(doneIds(empty({ tagline: 'משהו' }))).toEqual(['about']);
    expect(doneIds(empty({ description: 'משהו' }))).toEqual(['about']);
  });

  it('treats whitespace-only text as not filled in', () => {
    expect(doneIds(empty({ tagline: '   ', description: '\n\t' }))).toEqual([]);
    expect(doneIds(empty({ address: '  ' }))).toEqual([]);
  });

  it('sends each step to the tab that can actually complete it', () => {
    const byId = Object.fromEntries(buildOnboardingSteps(empty()).map((s) => [s.id, s.panel]));
    expect(byId.product).toBe('products');
    expect(byId.image).toBe('settings');
    expect(byId.about).toBe('settings');
    expect(byId.categories).toBe('settings');
    expect(byId.address).toBe('settings');
  });
});

describe('onboardingProgress', () => {
  it('reports 0% and incomplete for a brand-new store', () => {
    const p = onboardingProgress(buildOnboardingSteps(empty()));
    expect(p).toMatchObject({ doneCount: 0, total: ONBOARDING_STEP_ORDER.length, complete: false, percent: 0 });
  });

  it('reports complete only when every step is done — the signal that hides the card', () => {
    const p = onboardingProgress(buildOnboardingSteps(full()));
    const n = ONBOARDING_STEP_ORDER.length;
    expect(p).toMatchObject({ doneCount: n, total: n, complete: true, percent: 100 });
  });

  it('rounds the bar percentage from the real ratio', () => {
    const p = onboardingProgress(buildOnboardingSteps(empty({ visibleProductCount: 1, hasProfileImage: true })));
    expect(p.doneCount).toBe(2);
    // Literal, unlike the totals above, because ROUNDING is the whole subject here: 2/6 is 33.33,
    // and a derived expectation would restate the implementation instead of checking it. Update it
    // by hand when the step count changes — that is the assertion doing its job, not breaking.
    expect(p.percent).toBe(33);
    expect(p.complete).toBe(false);
  });

  it('never claims complete on an empty step list', () => {
    expect(onboardingProgress([])).toMatchObject({ complete: false, percent: 100 });
  });
});

describe('required steps — the discoverability gate', () => {
  it('blocks on a missing product and nothing else', () => {
    expect(missingRequiredSteps(buildOnboardingSteps(empty())).map((s) => s.id)).toEqual(['product']);
  });

  it('clears once a visible product exists, even with everything else empty', () => {
    expect(missingRequiredSteps(buildOnboardingSteps(empty({ visibleProductCount: 1 })))).toEqual([]);
  });

  it('marks only the blocking step as required', () => {
    const required = buildOnboardingSteps(empty()).filter((s) => s.required).map((s) => s.id);
    expect(required).toEqual(['product']);
  });

  it('does not count hidden-only catalogs — the caller passes VISIBLE products', () => {
    // A seller with 10 hidden products passes visibleProductCount: 0, so the store stays blocked.
    expect(missingRequiredSteps(buildOnboardingSteps(empty({ visibleProductCount: 0 }))).map((s) => s.id))
      .toEqual(['product']);
  });
});
