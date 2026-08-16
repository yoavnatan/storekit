/** Seller onboarding checklist — the "your store isn't live-ready yet" guide a brand-new
 *  seller sees on the dashboard's Overview tab.
 *
 *  Deliberately **state-free**: every step's `done` is DERIVED from data the seller already
 *  owns (products, images, categories, address). Nothing is persisted, nothing is "dismissed",
 *  so there is no per-seller onboarding record to migrate at DB time and no way for the
 *  checklist to disagree with the actual store. Consequence to know: a seller who empties
 *  their catalog again sees the "add a product" step return — which is the honest state, not
 *  a bug.
 *
 *  Pure/isomorphic on purpose (no node:fs, no cookies) so it stays trivially testable and the
 *  dashboard can feed it already-loaded data instead of re-reading files.
 */

/** Which checklist step. Stable ids — the UI maps them to translated copy. */
export type OnboardingStepId = 'product' | 'image' | 'banner' | 'about' | 'categories' | 'address';

/** Dashboard tab a step's CTA jumps to (matches `[role="tab"][data-panel]`). */
export type OnboardingPanel = 'products' | 'settings';

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  panel: OnboardingPanel;
  /** true = the store is NOT discoverable until this is done — the hard gate enforced by
   *  lib/store-readiness.ts across the sitemap, site search and the store page's noindex.
   *  false = a recommendation; skipping it costs quality, not operability. Keeping the two
   *  in one list (visually separated) is deliberate: a seller should see the whole path, with
   *  the blocking part unmistakable, rather than discover a second checklist later. */
  required: boolean;
}

/** Everything the checklist needs, as plain values — the caller has all of this loaded already. */
export interface OnboardingInput {
  /** Products a SHOPPER can see (not hidden, not admin-blocked) — the same count
   *  lib/store-readiness.ts gates on, so the checklist can never say "done" while the
   *  store is still undiscoverable. A catalog of hidden-only products does not count. */
  visibleProductCount: number;
  hasProfileImage: boolean;
  /** A banner PICTURE, which is the same test the store page renders on — with one, the 56px mark
   *  beside the name is suppressed as redundant; without one, the page opens straight on the details
   *  box. Nothing ever asked a seller for this before (2026-08-16), so a store could sit indefinitely
   *  with the plainest version of its own front page and no indication that a better one existed. */
  hasBannerImage: boolean;
  tagline: string;
  description: string;
  categoryCount: number;
  address: string;
}

/** Order = the order a seller should actually do them in (biggest payoff first). */
const STEP_PANELS: Record<OnboardingStepId, OnboardingPanel> = {
  product: 'products',
  image: 'settings',
  banner: 'settings',
  about: 'settings',
  categories: 'settings',
  address: 'settings',
};

/** `banner` sits right after `image` because they are the same job — the two pictures a shopper sees
 *  before reading a word — and a seller who has just been sent to the settings panel for one should
 *  find the other beside it rather than three steps later. */
export const ONBOARDING_STEP_ORDER: OnboardingStepId[] = ['product', 'image', 'banner', 'about', 'categories', 'address'];

/** The steps that gate discoverability. Must stay in sync with lib/store-readiness.ts' blockers —
 *  that file is what actually enforces them; this is only how the seller is told. */
const REQUIRED_STEPS = new Set<OnboardingStepId>(['product']);

export function buildOnboardingSteps(input: OnboardingInput): OnboardingStep[] {
  const done: Record<OnboardingStepId, boolean> = {
    product: input.visibleProductCount > 0,
    image: input.hasProfileImage,
    banner: input.hasBannerImage,
    // Either field counts — both are "tell shoppers who you are" copy, and forcing a seller to
    // fill two free-text boxes before the checklist relents is nagging, not guidance.
    about: input.tagline.trim().length > 0 || input.description.trim().length > 0,
    categories: input.categoryCount > 0,
    address: input.address.trim().length > 0,
  };
  return ONBOARDING_STEP_ORDER.map((id) => ({
    id,
    done: done[id],
    panel: STEP_PANELS[id],
    required: REQUIRED_STEPS.has(id),
  }));
}

/** The blocking steps still undone — non-empty means the store is invisible to shoppers. */
export function missingRequiredSteps(steps: OnboardingStep[]): OnboardingStep[] {
  return steps.filter((s) => s.required && !s.done);
}

export interface OnboardingProgress {
  doneCount: number;
  total: number;
  /** All steps done — the caller hides the whole card. */
  complete: boolean;
  /** 0-100, for the progress bar. */
  percent: number;
}

export function onboardingProgress(steps: OnboardingStep[]): OnboardingProgress {
  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  return {
    doneCount,
    total,
    complete: total > 0 && doneCount === total,
    percent: total === 0 ? 100 : Math.round((doneCount / total) * 100),
  };
}
