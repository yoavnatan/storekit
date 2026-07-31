/**
 * The dashboard's FormFallbackGuard listens on `document`, so it judges EVERY form on the page —
 * including the ones the seller-facing chrome renders on top of the dashboard (header, footer).
 * Those forms have no AJAX handler by design: they post to an endpoint that answers 303 and the
 * whole point is the full navigation that follows. Without `data-native-submit` the guard reads
 * that as "the module graph died", blocks the post and tells the seller saving is unavailable —
 * which is what happened to the language toggle (2026-07-31): pressing "English" on the dashboard
 * showed "השמירה לא זמינה כרגע" and the language never changed.
 *
 * Asserted against the source, not the DOM: the failure is a missing attribute in markup, and a
 * runtime test would only catch it on the one page someone remembered to render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Components that render inside BaseLayout on every page — the dashboard included. */
const CHROME = ['src/components/Header.astro', 'src/components/Footer.astro', 'src/layouts/BaseLayout.astro'];

describe('global chrome forms vs the dashboard form guard', () => {
  it.each(CHROME)('%s: every POST form opts out of the guard', (file) => {
    const src = readFileSync(resolve(process.cwd(), file), 'utf8');
    const posts = src.match(/<form\b[^>]*\bmethod=["']POST["'][^>]*>/gi) ?? [];

    for (const tag of posts) {
      expect(tag, `${file}: a POST form in the global chrome is missing data-native-submit — the ` +
        `dashboard guard will block it and claim saving is unavailable`).toContain('data-native-submit');
    }
  });

  it('still sees the forms it is meant to be guarding', () => {
    const found = CHROME.flatMap((f) =>
      readFileSync(resolve(process.cwd(), f), 'utf8').match(/<form\b[^>]*\bmethod=["']POST["'][^>]*>/gi) ?? []);
    // Logout and the language toggle. A rename that empties this test would otherwise pass silently.
    expect(found.length).toBeGreaterThanOrEqual(2);
  });
});
