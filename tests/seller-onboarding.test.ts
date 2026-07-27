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
    expect(p).toMatchObject({ doneCount: 0, total: 5, complete: false, percent: 0 });
  });

  it('reports complete only when every step is done — the signal that hides the card', () => {
    const p = onboardingProgress(buildOnboardingSteps(full()));
    expect(p).toMatchObject({ doneCount: 5, total: 5, complete: true, percent: 100 });
  });

  it('rounds the bar percentage from the real ratio', () => {
    const p = onboardingProgress(buildOnboardingSteps(empty({ visibleProductCount: 1, hasProfileImage: true })));
    expect(p.doneCount).toBe(2);
    expect(p.percent).toBe(40);
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
