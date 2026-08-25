/**
 * The four documents this site is REQUIRED to publish, and the two ways that requirement breaks
 * silently.
 *
 * **Why a test and not a note.** A statutory page fails in a way no other page does: it goes on
 * rendering perfectly while ceasing to discharge the duty it exists for. There are exactly two
 * mechanisms, and both have already happened here to `/terms` — a link in the footer pointing at a
 * route that does not exist (a 404 that Merchant Center reads as a shop with no published terms),
 * and a reserved-word gap that lets a seller register the slug and answer for the page from their
 * own shopfront. So the assertions are: the page exists, it is linked from every page, nobody can
 * take its slug, a crawler is told about it, and it still says the specific things the law names.
 *
 * **The legal frame, checked 2026-08-25 against primary sources** — the sourcing, with what was
 * read and what it says, is in `docs/legal-privacy-accessibility.md`:
 *
 *   `/privacy`        תיקון 13 לחוק הגנת הפרטיות, in force 2025-08-14. The §11 notification duty
 *                     was WIDENED to require telling a person whether they must give the data and
 *                     **what happens if they refuse**, plus that a right of access (§13) and a
 *                     right of correction (§14) exist. Those three are what §"content" below pins,
 *                     because they are the three a copied policy always drops.
 *   `/accessibility`  תקנה 35 לתקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות),
 *                     תשע״ג-2013 — ת״י 5568 level AA, and תקנה 35ה requires publishing the
 *                     statement itself with contact details for accessibility. The ₪1,000,000
 *                     turnover exemption reaches only sites operating before 26.10.2017, so it
 *                     does not reach this one at any revenue.
 *
 * A failure here is never fixed by editing this file. It is fixed by restoring whatever went.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isReservedSlug } from '../src/lib/stores.js';
import { isPlatformOwnedPath } from '../src/lib/platform-routes.js';
import { platformPageEntries } from '../src/lib/sitemap-document.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** Route → the file that must render it. Every one of these is a document the site is obliged to
 *  publish; `/contact` is in the list because a reachable human is part of the same obligation on
 *  both sides (it is what `contact.astro`'s own header calls the misrepresentation class). */
const REQUIRED_PAGES: { route: string; file: string }[] = [
  { route: '/terms', file: 'src/pages/terms.astro' },
  { route: '/returns-policy', file: 'src/pages/returns-policy.astro' },
  { route: '/privacy', file: 'src/pages/privacy.astro' },
  { route: '/accessibility', file: 'src/pages/accessibility.astro' },
  { route: '/contact', file: 'src/pages/contact.astro' },
];

describe('the pages the site is legally required to publish', () => {
  it.each(REQUIRED_PAGES)('$route is rendered by a real route', ({ file }) => {
    expect(existsSync(join(ROOT, file)), `${file} is gone — the footer still links the route`).toBe(true);
  });

  it.each(REQUIRED_PAGES)('$route is linked from the footer, i.e. from every page', ({ route }) => {
    expect(read('src/components/Footer.astro')).toContain(`href="${route}"`);
  });

  it.each(REQUIRED_PAGES)('$route cannot be claimed as a store slug', ({ route }) => {
    // The failure this prevents is not a broken link: the page keeps working for everyone who never
    // visits, while the seller who took the slug serves their shopfront to everyone who does.
    expect(isReservedSlug(route.slice(1)), `add '${route.slice(1)}' to RESERVED_SLUGS`).toBe(true);
  });

  it.each(REQUIRED_PAGES)('$route is the platform\'s on a seller\'s custom domain too', ({ route }) => {
    // One document for the whole site. A host-local copy served from `shop.acme.co.il` would put
    // the SELLER's brand on a statement about who is legally answerable — and that is us.
    expect(isPlatformOwnedPath(route)).toBe(true);
  });

  it.each(REQUIRED_PAGES)('$route is in the sitemap a crawler is actually given', ({ route }) => {
    // These routes are SSR (`prerender = false`), so @astrojs/sitemap cannot see them at build
    // time — this hand-kept list is the only thing that publishes them.
    const locs = platformPageEntries('https://example.test').map((e) => e.loc);
    expect(locs).toContain(`https://example.test${route}`);
  });
});

/** The clause DATA of a legal page, with the file's own header comment stripped off.
 *
 *  Every one of these pages carries a long frontmatter comment recording which duty each clause
 *  discharges and which phrasings are forbidden — so the header necessarily names the very strings
 *  the copy must not contain. Asserting over the raw file would read those explanations as the
 *  page's text and pass or fail on the wrong half of the document. */
function clauseText(file: string): string {
  const s = read(file);
  const i = s.indexOf('const clauses');
  expect(i, `${file}: no clause array — has the page been rewritten?`).toBeGreaterThan(0);
  // Bounded at the array's own close, not just started at its open: past it lies the markup, whose
  // Tailwind arbitrary values (`!text-[1.6rem]`) are digits that have nothing to do with the copy.
  const rest = s.slice(i);
  const end = rest.indexOf('\n];');
  expect(end, `${file}: clause array is not closed by a bare '];'`).toBeGreaterThan(0);
  return rest.slice(0, end);
}

describe('the privacy policy still says the things §11 names', () => {
  const page = clauseText('src/pages/privacy.astro');

  it('states that giving the data is voluntary and what refusing costs', () => {
    // תיקון 13's widened §11: not only what is collected, but the CONSEQUENCE of not giving it.
    // This is the clause a template policy has never had, which is why it is pinned by content.
    expect(page).toContain('אין חובה חוקית למסור');
    expect(page).toContain('לא ניתן להשלים הזמנה');
  });

  it('tells the reader the rights of access and correction exist', () => {
    expect(page).toContain('לעיין במידע האישי');
    expect(page).toContain('לתקן');
  });

  it('names who the data is given to, including the advertising platforms', () => {
    // The recipients clause is the one that goes stale first, because it is the one a new
    // integration silently invalidates. Google and Meta run on every page (BaseLayout).
    expect(page).toContain('לגוגל ולמטא');
    expect(page).toContain('לחברת השילוח');
    expect(page).toContain('לחברת הסליקה');
  });

  it('says card details never reach us — the split model, stated to the buyer', () => {
    expect(page).toContain('אינם עוברים דרך');
  });

  it('carries NO retention window as a typed digit', () => {
    // Same rule `/terms` follows for the fulfilment deadlines: a number written in a legal clause
    // AND in the code that enforces it is a pair that drifts, and the copy is the half a person can
    // hold us to. Every window on the page is interpolated from `lib/data-retention.ts`.
    //
    // Two numbers are ALLOWED and are stripped before the check, because neither is a window the
    // code owns: `30 יום` is the statutory deadline for answering a subject-access request, and
    // `5568`/`2013` style references name a standard or a law. Anything else that is a bare digit
    // inside a Hebrew clause is a retention window somebody typed.
    const hebrewLines = page.split('\n').filter((l) => /[֐-׿]/.test(l) && !l.trim().startsWith('//'));
    const offenders = hebrewLines
      .map((l) => l.replace(/30 יום/g, ''))
      .filter((l) => /\b\d+\b/.test(l));
    expect(offenders, 'interpolate from lib/data-retention.ts instead of typing the number').toEqual([]);
  });
});

describe('the accessibility statement still says what תקנה 35ה requires', () => {
  const page = clauseText('src/pages/accessibility.astro');

  it('names the standard and the level', () => {
    // ת"י 5568 at level AA is the requirement itself. A statement that omits it claims nothing.
    expect(page).toContain('5568');
    expect(page).toContain('AA');
  });

  it('gives two ways to report an accessibility problem, one of them not a form', () => {
    // "Fill in this form" is not an accommodation for someone who cannot use the form, so BOTH
    // channels have to survive. Asserted as the interpolations the clause uses plus the bindings
    // behind them, rather than as literal contact details — those live in store.config and a test
    // that copied them here would be the second place they are written down.
    expect(page).toContain('${email}');
    expect(page).toContain('${phone}');
    const file = read('src/pages/accessibility.astro');
    expect(file).toContain('platform.business.email');
    expect(file).toContain('platform.business.phone');
  });

  it('still discloses what is NOT fully accessible', () => {
    // The known-limits clause is the load-bearing one: an undisclosed gap is the exposure, and a
    // disclosed gap with a human alternative beside it is what the regulation asks for. Deleting
    // it makes the page read better and makes it worse.
    expect(page).toContain('מה עדיין לא נגיש במלואו');
  });

  it('does not claim a רכז נגישות we are not obliged to appoint', () => {
    // תקנה 91 starts that duty at 25 employees. Taking the title on takes its duties without
    // being under them — and this is the exact phrase a copied statement arrives carrying.
    expect(page).not.toContain('רכז נגישות');
  });
});
