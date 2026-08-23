/**
 * The help centre's corpus — the surface built so a seller does NOT have to write to a person
 * (CURRENT_TASK סשן ב׳: "מינימום מגע").
 *
 * That purpose is what these assertions are about. A dead link or a duplicated slug on this page
 * does not merely look bad: it sends the one person who tried to help themselves to a 404, and they
 * write the message anyway — so the surface costs support time instead of saving it, while looking
 * like it works.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_ARTICLES } from '../src/lib/help-articles.js';
import { HELP_GROUPS, articlesInGroup, getHelpArticle, relatedArticles, searchHelp } from '../src/lib/help.js';

describe('the corpus is internally sound', () => {
  it('has no duplicate slug', () => {
    const slugs = HELP_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every slug is URL-safe and stable-looking', () => {
    // Latin, lower-case, hyphenated. Unlike a product slug — which keeps Hebrew on purpose
    // (url-base.ts#toSlug) — these are OUR routes, linked from the footer and from `/contact`, and
    // they never need to carry a seller's words.
    for (const a of HELP_ARTICLES) expect(a.slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('every article belongs to a group the index actually renders', () => {
    // An article in an unknown group is invisible: the index loops over HELP_GROUPS, so it would be
    // reachable only by typing its URL — written, deployed, and read by nobody.
    const known = new Set(HELP_GROUPS.map((g) => g.id));
    for (const a of HELP_ARTICLES) expect(known.has(a.group)).toBe(true);
  });

  it('every group on the index has something under it', () => {
    // The other direction. A heading with nothing beneath it reads as a section that failed to
    // load, which is worse than a group that does not exist yet.
    for (const g of HELP_GROUPS) expect(articlesInGroup(g.id).length).toBeGreaterThan(0);
  });

  it('every `related` slug resolves to a real article', () => {
    // The dead-link assertion, and the reason this file exists. `relatedArticles` drops a dangling
    // slug rather than rendering a 404, so without this test the failure would be silent: a link
    // that simply stopped appearing, on the page whose job is to answer.
    for (const a of HELP_ARTICLES) {
      for (const slug of a.related ?? []) {
        expect(getHelpArticle(slug), `${a.slug} → ${slug}`).toBeDefined();
      }
    }
    expect(relatedArticles(HELP_ARTICLES[0]!).length).toBe((HELP_ARTICLES[0]!.related ?? []).length);
  });

  it('no article points at itself', () => {
    for (const a of HELP_ARTICLES) expect(a.related ?? []).not.toContain(a.slug);
  });

  it('every article has a title, a one-line summary and a body', () => {
    for (const a of HELP_ARTICLES) {
      expect(a.title.trim().length).toBeGreaterThan(0);
      expect(a.summary.trim().length).toBeGreaterThan(0);
      // The summary is also the page's meta description and the index card's second line. A long
      // one is truncated by Google mid-sentence and overflows the card.
      expect(a.summary.length).toBeLessThanOrEqual(120);
      expect(a.body.length).toBeGreaterThan(0);
      for (const p of a.body) expect(p.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('a link the corpus makes to the rest of the site must exist', () => {
  // Articles name other pages of the platform in prose ("עמוד המחירים", "ביטולים והחזרות"). Prose
  // cannot be checked, but a real `/path` written into a body can be — and a help article linking
  // to a route that 404s is the exact "misrepresentation" shape that suspends a Merchant Center
  // ACCOUNT, which on this platform is every seller's ads at once.
  it('names no platform path that has no page', () => {
    const routes = new Set(
      readdirSync('src/pages', { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? [`/${e.name}`] : [`/${e.name.replace(/\.(astro|ts)$/, '')}`])),
    );
    const referenced = HELP_ARTICLES.flatMap((a) => [...a.body.join(' ').matchAll(/(?<![\w/])\/[a-z][a-z0-9-]*/g)])
      .map((m) => m[0]);
    for (const path of referenced) expect(routes.has(path), path).toBe(true);
  });
});

describe('search', () => {
  it('finds an article by a word from its body, not only its title', () => {
    // The point of searching the body: a seller types the words of their PROBLEM ("מלאי"), not the
    // title we chose for the answer.
    const hits = searchHelp('מלאי');
    expect(hits.map((a) => a.slug)).toContain('external-inventory');
  });

  it('an empty query is not a match-everything', () => {
    // The page renders the whole corpus already; returning it again from a blank box would make
    // "no results" and "you have not typed anything" the same state on screen.
    expect(searchHelp('   ')).toEqual([]);
  });

  it('ignores case', () => {
    expect(searchHelp('SEO').length + searchHelp('seo').length).toBeGreaterThan(0);
  });
});

describe('the page renders the corpus rather than a second copy of it', () => {
  it('no article text is duplicated into the .astro pages', () => {
    // The failure this prevents is the one that rots quietly: a summary edited in the data file
    // while an old copy of it sits in the template, so two screens answer the same question
    // differently. Checked by looking for any article title as a string literal in the pages.
    const pages = ['src/pages/help/index.astro', 'src/pages/help/[slug].astro']
      .map((f) => readFileSync(join(process.cwd(), f), 'utf8')).join('\n');
    for (const a of HELP_ARTICLES) expect(pages).not.toContain(a.title);
  });
});
