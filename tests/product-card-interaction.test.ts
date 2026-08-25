/**
 * The product card's picture: one role, in one place, in BOTH renderers.
 *
 * **Why this needs a guard rather than a comment.** The card is built twice — once in the store
 * page's frontmatter and once as a template string in its client script — and the two have drifted
 * before (memory `project_brand_boost_twin_drift`). On 2026-08-25 the picture's `role="button"`
 * moved off `.product-card__img-wrap` and onto `.product-card__slides`, because the wrap also
 * contains the wishlist button and the carousel dots, so a role on it nested one control inside
 * another: axe reported `nested-interactive` serious on every card, and a screen reader offered a
 * button whose contents were more buttons. Moving it also gave the scrolling strip a tab stop,
 * which it never had — a keyboard shopper could not reach the second photo of anything.
 *
 * **That move broke a second thing, silently, and that is the real reason for this file.** The card
 * has its OWN click-to-open handler, and it decided "this click already belongs to something else"
 * by looking for a button, a link or `role="button"` in the composed path. The wrap satisfied that
 * test for free while it held the role. The moment the role moved, a click landing on the wrap but
 * NOT inside the strip — a badge, the dots, the picture's padding — matched nothing, both handlers
 * ran, and the modal opened twice per click. Nothing failed, nothing logged; it was found by
 * counting the events in a real browser.
 *
 * So the three assertions below are one rule stated three ways: **the role lives on `__slides`, the
 * wrap does not carry it, and the card-level handler names the wrap explicitly instead of relying
 * on a role it no longer has.**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dirname, '..', 'src/pages/[storeSlug]/index.astro'), 'utf8');

/** The two card builders, split apart so a rule can be asserted against each. The frontmatter card
 *  is everything before the page's client `<script>`; the renderer twin is everything after. */
const SCRIPT_AT = SRC.indexOf("import { escapeHtml as escHtml }");
const FRONTMATTER = SRC.slice(0, SCRIPT_AT);
const RENDERER = SRC.slice(SCRIPT_AT);

describe('the product card picture carries its button role on the slides, in both renderers', () => {
  it.each([['frontmatter', FRONTMATTER], ['client renderer', RENDERER]] as const)(
    '%s: role/aria-label/tabindex sit on .product-card__slides', (_name, half) => {
      const i = half.indexOf('product-card__slides');
      expect(i, 'the slides element is gone — has the card been rewritten?').toBeGreaterThan(0);
      // The attributes are on the same element as the class, so they are within a short window of
      // it. Read generously (the frontmatter spreads them over three lines) but not so far as to
      // reach the next element.
      const near = half.slice(i, i + 320);
      // `role=` and not bare `role` — the twin carries a comment right above it that uses the word.
      expect(near, 'the picture must still be operable and labelled').toContain('role=');
      expect(near).toContain('aria-label');
      expect(near).toContain('tabindex');
    });

  it.each([['frontmatter', FRONTMATTER], ['client renderer', RENDERER]] as const)(
    '%s: the img-wrap does NOT carry the role — it holds the wishlist button', (_name, half) => {
      const i = half.indexOf('product-card__img-wrap${hasImages');
      const j = i >= 0 ? i : half.indexOf('product-card__img-wrap');
      expect(j, 'the img-wrap is gone — has the card been rewritten?').toBeGreaterThan(0);
      // Up to the slides element, i.e. the wrap's own opening tag only.
      const openingTag = half.slice(j, half.indexOf('product-card__slides', j));
      expect(openingTag, 'nested-interactive: role="button" on the element containing the wishlist button')
        .not.toContain('role=');
    });
});

describe('the card-level click handler still excludes the picture', () => {
  it('names the img-wrap class rather than relying on a role that moved off it', () => {
    // Without this the modal opens TWICE on one click anywhere in the picture that is not the
    // scrolling strip. Measured in a browser, not reasoned about.
    const guard = RENDERER.slice(RENDERER.indexOf('function initCardClickToModal'));
    const body = guard.slice(0, guard.indexOf('openCardModal(card);'));
    expect(body, 'the picture has its own handler — this one must skip it')
      .toContain('product-card__img-wrap--clickable');
  });

  it('keeps skipping real buttons and links too', () => {
    const guard = RENDERER.slice(RENDERER.indexOf('function initCardClickToModal'));
    const body = guard.slice(0, guard.indexOf('openCardModal(card);'));
    expect(body).toContain("'BUTTON'");
    expect(body).toContain("'A'");
  });
});
