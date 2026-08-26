/**
 * The help centre's filter — a substring match over cards that are already on the page.
 *
 * No endpoint and no shipped index: every article's searchable text is on its own card as a
 * `data-help-text` attribute, so this reads exactly what the page rendered. That also means the
 * page is complete without this script — with JavaScript off, every article is still a real link on
 * a rendered page.
 *
 * A group heading hides when nothing under it matched, because a heading standing over an empty
 * space reads as a section that failed to load rather than one with no hits.
 */

export function initHelpSearch(): void {
  const field = document.getElementById('help-search') as HTMLInputElement | null;
  const empty = document.getElementById('help-empty');
  if (!field) return;

  const cards = [...document.querySelectorAll<HTMLElement>('[data-help-article]')];
  const groups = [...document.querySelectorAll<HTMLElement>('[data-help-group]')];
  if (!cards.length) return;

  function apply(): void {
    const q = field!.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      // `!hidden` and not plain `hidden`: an unlayered legacy rule beats `@layer utilities`, and a
      // `hidden` on a flex/grid child loses to the container's `display` outright
      // (memory `project_css_cascade_traps`).
      const match = !q || (card.dataset['helpText'] ?? '').toLowerCase().includes(q);
      card.classList.toggle('!hidden', !match);
      if (match) shown++;
    }
    for (const group of groups) {
      const any = [...group.querySelectorAll<HTMLElement>('[data-help-article]')]
        .some((c) => !c.classList.contains('!hidden'));
      group.classList.toggle('!hidden', !any);
    }
    empty?.classList.toggle('!hidden', shown > 0);
  }

  field.addEventListener('input', apply);
  // Run once on load: a browser restoring a typed value on back-navigation would otherwise show the
  // full list under a query that says otherwise.
  apply();
}
