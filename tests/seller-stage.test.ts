/**
 * The stage vocabulary — one word for where a seller stands.
 *
 * ── What is actually being guarded ──
 * Not the arithmetic: `sellerStage` is nine branches. What matters is that the four screens that
 * used to answer this question for themselves now cannot answer it differently, and that the two
 * readings which had already gone wrong stay right:
 *
 *  · **An absent hold is not an achievement.** Holds say what is BLOCKING, so "not blocked" covers
 *    both finished and never-started. Reading it as the first put a green tick on a clearing review
 *    nobody had asked for (2026-08-25, `GoLiveSteps.astro`).
 *  · **A refusal is not a wait.** The processor may refuse a business at their sole discretion
 *    (agreement §11), and until 2026-08-26 that state did not exist — a refused seller read "up to
 *    seven business days" for ever (owner, סשן א׳ §20).
 *
 * The label test is the other half: every stage has a line in both languages, so a stage added
 * without copy fails here rather than rendering an empty heading on the seller's overview.
 */
import { describe, expect, it } from 'vitest';
import { SELLER_STAGES, sellerStage, sellerStageKey } from '../src/lib/seller-stage.js';
import { translations } from '../src/i18n/translations.js';

/** Everything answered "no". Each case below changes exactly what it is about. */
const NOTHING = { lifecycle: 'unpublished' as const, holds: ['clearing-details' as const, 'subscription' as const], cardOnFile: false, clearingReady: false };

describe('where a seller stands', () => {
  it('has no stage at all before there is a shop', () => {
    expect(sellerStage({ ...NOTHING, lifecycle: null })).toBe('no-store');
  });

  it('is building while neither half of the money has been started', () => {
    expect(sellerStage(NOTHING)).toBe('building');
  });

  it('tells the two halves apart, in both directions', () => {
    // The two steps are open at once on purpose (`GoLiveSteps.astro`: the plan is ours and the card
    // is charged to our merchant, so it waits on the processor for nothing), which is exactly why
    // both of these are real states and not one.
    expect(sellerStage({ ...NOTHING, cardOnFile: true })).toBe('card-only');
    expect(sellerStage({ ...NOTHING, holds: ['subscription'] })).toBe('details-only');
  });

  it('waits only when HIS part is finished', () => {
    expect(sellerStage({ ...NOTHING, holds: ['subscription'], cardOnFile: true })).toBe('awaiting-approval');
  });

  /**
   * The 2026-08-25 bug, as an assertion. A seller who has typed nothing has no clearing account, so
   * there is no `clearing-approval` hold either — and a stage derived from "no hold" would call
   * that finished. It must not: `clearingReady` comes from the ACCOUNT's own state.
   */
  it('never reads an absent hold as an achievement', () => {
    expect(sellerStage({ lifecycle: 'unpublished', holds: [], cardOnFile: false, clearingReady: false }))
      .not.toBe('going-live');
    expect(sellerStage({ lifecycle: 'unpublished', holds: [], cardOnFile: false, clearingReady: true }))
      .toBe('going-live');
  });

  it('calls a refusal a refusal, whatever else is outstanding', () => {
    // It outranks every step of the funnel: none of what is left to type would change the outcome.
    expect(sellerStage({ ...NOTHING, clearingRejected: true })).toBe('rejected');
    expect(sellerStage({ ...NOTHING, holds: ['subscription'], cardOnFile: true, clearingRejected: true })).toBe('rejected');
  });

  it('lets a live shop be live even if the account was later suspended', () => {
    // A different problem with a different owner: `merchantBlockFor` is what stops the sale, and
    // describing a selling storefront as "not approved yet" would be the wrong sentence entirely.
    expect(sellerStage({ lifecycle: 'active', holds: [], cardOnFile: true, clearingReady: false, clearingRejected: true })).toBe('live');
  });

  it('reports the shop\'s own state once it is up', () => {
    expect(sellerStage({ ...NOTHING, lifecycle: 'active' })).toBe('live');
    expect(sellerStage({ ...NOTHING, lifecycle: 'paused' })).toBe('paused');
    for (const state of ['closing', 'closed', 'blocked'] as const) {
      expect(sellerStage({ ...NOTHING, lifecycle: state })).toBe('closed');
    }
  });

  it('gives every stage a line in both languages', () => {
    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    for (const stage of SELLER_STAGES) {
      const key = sellerStageKey(stage);
      expect(he[key], `he.dashboard.${key}`).toBeTruthy();
      expect(en[key], `en.dashboard.${key}`).toBeTruthy();
    }
  });
});
