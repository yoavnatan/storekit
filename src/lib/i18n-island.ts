/**
 * Which routes get the `dashboard` slice of the `#i18n-data` island (BaseLayout.astro).
 *
 * It is 34.9KB — 95% of the island — and nothing outside the seller, admin and buyer areas has
 * ever read it, so it is gated rather than shipped to every shopper-facing page (the reasoning and
 * the measurement are at the call site; the file-location rule that keeps consumers inside those
 * areas is `tests/i18n-island-scope.test.ts`).
 *
 * **In a function, and tested, because the gate had a hole in it and the hole was silent
 * (owner, 2026-08-11: "why is the range picker in English when the site is Hebrew").** The test
 * above checks that every READER lives on a dashboard route. Nothing checked the other half — that
 * the gate actually fires for the route the reader is on — and it did not: it matched the prefix
 * `'/admin/'`, WITH a trailing slash, while `astro.config.mjs` sets `trailingSlash: 'never'`. So
 * the admin dashboard itself, which is `/admin` exactly, missed every string it asks for. Each side
 * was right on its own and only the join was wrong, which is why neither side's test could see it.
 *
 * What it looked like: the range picker's SSR label rendered in Hebrew from `getT()`, and the
 * moment the dropdown opened — built client-side — every preset inside it fell back to its English
 * literal, then replaced the Hebrew trigger label with an English one on click.
 */
const DASHBOARD_AREAS = ['/seller', '/admin', '/buyer'];

export function needsDashboardI18n(pathname: string): boolean {
  // The area root itself AND anything under it. `startsWith(area)` alone would also match
  // `/administrators`, which is why the second half names the separator explicitly.
  return DASHBOARD_AREAS.some((area) => pathname === area || pathname.startsWith(`${area}/`));
}
