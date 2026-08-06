import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { categorySlug, categoryUrlParam, findCategoryByParam, type StoreCategory } from '../src/lib/store-categories.js';

/**
 * A store's catalog has to be REACHABLE by following links, not just listed in a sitemap.
 *
 * Measured 2026-08-03, before the change these tests protect: the store page linked to the first 24
 * products and nothing else. "Load more" is a fetch, the category chips were `<button>`s, and so 76
 * of one showcase store's 100 products had no in-site link pointing at them anywhere — discoverable
 * via the sitemap, but with no path telling Google which shelf they belong to or that the shelf
 * exists. Both halves of the fix are one markup decision each, which is exactly the kind that gets
 * undone by a later refactor that only looks at how it behaves in a browser. Hence a test.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

function cat(id: string, name: string, parentId: string | null = null): StoreCategory {
  return { id, storeId: 's', name, parentId, order: 0 } as StoreCategory;
}

describe('category URLs are keyword-bearing and resolvable', () => {
  const categories = [cat('11111111-1111-4111-8111-111111111111', 'נעליים'), cat('22222222-2222-4222-8222-222222222222', 'Bags')];

  it('slugs a Hebrew name rather than falling back to the id — the keyword IS the point', () => {
    expect(categorySlug('נעליים')).toBe('נעליים');
    expect(categorySlug('Winter Coats')).toBe('winter-coats');
  });

  it('resolves a category from its slug', () => {
    expect(findCategoryByParam(categories, 'נעליים')?.name).toBe('נעליים');
    expect(findCategoryByParam(categories, 'bags')?.name).toBe('Bags');
  });

  it('still resolves the raw id, so links shared before slugs existed keep working', () => {
    expect(findCategoryByParam(categories, '11111111-1111-4111-8111-111111111111')?.name).toBe('נעליים');
  });

  it('returns null for nothing and for an unknown value, so the page falls back to the whole store', () => {
    expect(findCategoryByParam(categories, '')).toBeNull();
    expect(findCategoryByParam(categories, 'no-such-category')).toBeNull();
  });

  /**
   * A seller can call a category anything, and `toSlug` keeps only letters and digits — so a name
   * of stars, emoji or dashes slugs to the EMPTY STRING. Building a URL from that gives
   * `?category=` with nothing after it: a chip that quietly shows the whole catalog, and a sitemap
   * entry handing Google a second address for the store page. Found by review before it shipped.
   */
  describe('a name that cannot produce a slug falls back to the id instead of an empty URL', () => {
    const odd = [cat('33333333-3333-4333-8333-333333333333', '★★★'), cat('44444444-4444-4444-8444-444444444444', '👍')];

    it.each(['★★★', '👍', '---', '   '])('categorySlug(%j) is empty — this is the trap', (name) => {
      expect(categorySlug(name)).toBe('');
    });

    it('categoryUrlParam never returns empty: it hands back the id', () => {
      expect(categoryUrlParam(odd[0])).toBe('33333333-3333-4333-8333-333333333333');
      expect(categoryUrlParam(odd[1])).toBe('44444444-4444-4444-8444-444444444444');
      // and still prefers the slug when there is one
      expect(categoryUrlParam(cat('x', 'נעליים'))).toBe('נעליים');
    });

    it('that id round-trips back to the right category', () => {
      expect(findCategoryByParam(odd, categoryUrlParam(odd[0]))?.name).toBe('★★★');
      expect(findCategoryByParam(odd, categoryUrlParam(odd[1]))?.name).toBe('👍');
    });

    it('an unsluggable PARAM never matches the first unsluggable category by accident', () => {
      // '★' slugs to '' just like both names do; matching on that would pick a wrong shelf silently.
      expect(findCategoryByParam(odd, '★')).toBeNull();
    });
  });
});

describe('the store page keeps its catalog crawlable', () => {
  const page = read('src/pages/[storeSlug]/index.astro');

  it('renders category chips as <a href>, never as <button> — a button is invisible to a crawler', () => {
    // The chip row markup, server-rendered and client-rebuilt, must both be links.
    expect(page).toMatch(/<a href=\{storeViewHref\(cat\)\} class="category-chip"/);
    expect(page).toContain('class="category-chip" data-category-id="${escHtml(c.id)}"');
    expect(page).not.toMatch(/<button[^>]*class="category-chip"/);
  });

  it('renders the breadcrumb trail as links too — it is what places a category in the tree', () => {
    expect(page).toMatch(/<a href=\{storeViewHref\(c\)\} class="category-breadcrumb__crumb"/);
    expect(page).not.toMatch(/<button[^>]*class="category-breadcrumb__crumb"/);
  });

  it('makes "load more" itself the link, so it is not the only way past product 24', () => {
    // A <button> fetches; it does not link, and a crawler never presses anything — which is how
    // 76 of one showcase store's 100 products ended up with no in-site link at all. The fix was
    // briefly a numbered `?page=N` row NEXT TO the button, and that put two controls for one job
    // at the foot of one shelf, contradicting each other as soon as anyone pressed the button
    // ("מה המשמעות ליוזר שיש גם טען עוד וגם עמודים? לא ראיתי דבר כזה" — owner, 2026-08-05).
    // So there is one control and it IS the link: an <a href="?page=N+1"> drawn as a button,
    // whose click handler cancels the navigation and appends in place. Page 2's own button
    // links to page 3, so the chain reaches the whole catalog.
    expect(page).toMatch(/<a\s+id="load-more-btn"/);
    expect(page).toContain('href={hasMoreProducts ? storeViewHref(selectedCategory, currentPage + 1) : undefined}');
    expect(page).not.toMatch(/<button[^>]*id="load-more-btn"/);
  });

  it('drops that href on the last page, so the chain ends instead of looping', () => {
    // Measured 2026-08-05: with the href always present, page <totalPages+1> redirects to page 1,
    // whose button points forward again — a crawler follows links, not pixels, so `hidden` on the
    // wrapper does nothing. The server omits it and the client removes it.
    expect(page).toContain('hasMoreProducts ? storeViewHref');
    expect(page).toMatch(/} else \{\s*loadMoreBtn\.removeAttribute\('href'\);/);
  });

  it('keeps that href pointing at the next page of the view actually on screen', () => {
    // Filter to a category, press it four times, and the link must still mean this shelf —
    // otherwise a crawler arriving on that URL walks the unfiltered store instead.
    expect(page).toMatch(/next\.searchParams\.set\('page',[\s\S]{0,120}loadMoreBtn\.setAttribute\('href'/);
  });

  it('has no numbered pager under the grid', () => {
    expect(page).not.toMatch(/aria-label=\{lang === 'he' \? 'עמודי מוצרים'/);
  });

  it('gives each view its own canonical and title instead of collapsing them onto the store', () => {
    expect(page).toContain('canonical={pageCanonical}');
    expect(page).toContain('title={pageTitle}');
    expect(page).toContain('description={pageDescription}');
  });

  it('keeps a visitor-composed view (search / re-sort) out of the index, and only that', () => {
    expect(page).toContain('const isComposedView = Boolean(initQ || initSort)');
    // `adLanding` joined the list on 2026-08-06 and is the one addition that is NOT a view of this
    // store: it is the platform's own ad landing, which must stay out of the index so it never
    // competes with the seller's domain (custom-domain.ts#AD_LANDING_PARAM). Every other shelf —
    // each category, each page — stays indexable, which is what this assertion is really pinning.
    expect(page).toContain('noindex={!storeReady || isDemo || isComposedView || adLanding}');
  });

  it('redirects past the last page rather than serving an empty shelf', () => {
    expect(page).toMatch(/currentPage > totalPages[\s\S]{0,120}Astro\.redirect/);
  });
});

describe('the sitemap advertises category pages', () => {
  const sitemap = read('src/pages/sitemap-content.xml.ts');

  it('builds the param via categoryUrlParam, so an unsluggable name cannot emit `?category=`', () => {
    expect(sitemap).toContain("?category=${urlSegment(categoryUrlParam(c))}");
  });

  it('skips empty ones — a shelf with nothing on it is a thin page on a shared domain', () => {
    expect(sitemap).toMatch(/counts\[c\.id\] \?\? 0\) === 0\) continue/);
  });
});
