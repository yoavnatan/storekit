/** Card "arrival" entrance animation — fade+rise, same spring language as store.css's own
 *  `product-card-enter` (its load-more cards). Shared by the homepage (shelves/spotlight, incl.
 *  a replay on every dash-tab switch) and the /stores directory (below-fold on load, plus a
 *  replay on freshly-swapped-in cards after an AJAX category switch — see stores.astro). CSS
 *  lives in store-card.css (`.card-reveal-pending`/`.card-reveal-play`/`@keyframes card-reveal`),
 *  imported globally already. */

/** Plays the entrance animation on already-in-DOM cards. Safe to call on cards that already
 *  played once (e.g. a repeat dash-tab switch) — removes+re-adds the class via a forced reflow
 *  so the CSS animation actually restarts instead of no-op'ing on an unchanged classList. */
export function playReveal(cards: HTMLElement[]): void {
  cards.forEach((el, i) => {
    el.classList.remove('card-reveal-play');
    el.classList.add('card-reveal-pending');
    // Force the "pending" (opacity:0) state to actually commit before swapping back to "play" in
    // the same tick — otherwise the two class changes can coalesce into one style recalc and a
    // re-triggered animation never visibly restarts (standard remove+reflow+re-add fix).
    void el.offsetWidth;
    el.style.animationDelay = `${Math.min(i, 6) * 40}ms`;
    el.classList.remove('card-reveal-pending');
    el.classList.add('card-reveal-play');
  });
}

/** Initial page load only: arms+observes cards still below the fold at this exact moment (top >=
 *  viewport height, checked synchronously before any observing starts) so they fade+rise in the
 *  first time they scroll into view. A card already on-screen at load is left completely alone —
 *  no class ever added — so nothing visible at load can flash, and a no-JS visit just sees every
 *  card in its normal resting state (same reasoning as this page's own lazy-loaded images). */
export function armBelowFoldReveal(selector: string): void {
  const vh = window.innerHeight;
  const pending = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((el) => el.getBoundingClientRect().top >= vh);
  if (!pending.length) return;
  pending.forEach((el) => el.classList.add('card-reveal-pending'));

  const revealObs = new IntersectionObserver((entries) => {
    // Cards that cross the threshold together (a whole row scrolling into view at once) get a
    // light stagger via playReveal's own per-card index.
    const entered = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target as HTMLElement);
    entered.forEach((el) => revealObs.unobserve(el));
    playReveal(entered);
  }, { threshold: 0.15, rootMargin: '0px 0px -30px 0px' });
  pending.forEach((el) => revealObs.observe(el));
}
