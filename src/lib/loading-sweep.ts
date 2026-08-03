/**
 * Turn a `LoadingSweep.astro` track on and off.
 *
 * The sweep is CREATED on start and REMOVED on stop, rather than being hidden and shown. That is
 * what makes the 250ms delay work: a CSS animation-delay only counts while the element exists, so a
 * request that resolves in 80ms inserts and removes the span before its fade-in ever begins, and
 * nothing is drawn. Toggling `hidden` on a persistent element would not do this — an animation does
 * not reliably restart when an element is re-displayed, so the second load would flash instantly
 * while the first did not.
 *
 * The track element itself is never removed; only its contents change. Taking the track out would
 * move everything below it by 2px at exactly the moment loading finished.
 */

/**
 * How long a region may be fetching before it is allowed to say so — the ONE definition, because a
 * threshold that exists in three places drifts into three different answers.
 *
 * Two numbers bracket it: about 100ms is where a response stops feeling instant, and about a second
 * is where a wait genuinely needs explaining. In between is a judgement call, and the judgement is
 * that a filter answering inside half a second needs no narration — the new content IS the
 * feedback. Below this, nothing is drawn at all.
 *
 * Measured, not guessed: with the query work done (DB_MIGRATION_PLAN.md §8) these fetches answer in
 * roughly 220-380ms from a laptop 66ms from the database, and in production the app server shares
 * the database's region. A lower threshold — the buyer area had 200ms — therefore fired on nearly
 * every switch and showed for a tenth of a second, which is the flicker a cue is supposed to
 * replace rather than cause.
 *
 * The sweep bar carries this delay in CSS; a caller drawing its own skeleton uses the constant.
 */
export const LOADING_CUE_DELAY_MS = 450;

/** Show the bar — after a delay it pays for itself, see above. Safe to call when already running. */
export function startLoadingSweep(track: HTMLElement | null): void {
  if (!track || track.firstChild) return;
  const fade = document.createElement('span');
  // The wrapper owns the delayed reveal because the sweep has already spent its own `animation`
  // shorthand on the loop it runs (utilities/utils.css).
  fade.className = 'block h-full opacity-0 [animation:fade-in_0.2s_ease_0.25s_forwards]';
  const sweep = document.createElement('span');
  sweep.className = 'progress-sweep block h-full';
  fade.appendChild(sweep);
  track.appendChild(fade);
  track.setAttribute('aria-busy', 'true');
}

/** Hide it. Safe to call when it never started. */
export function stopLoadingSweep(track: HTMLElement | null): void {
  if (!track) return;
  track.replaceChildren();
  track.removeAttribute('aria-busy');
}
